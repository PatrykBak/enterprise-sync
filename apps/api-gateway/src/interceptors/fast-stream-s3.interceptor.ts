import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  BadRequestException,
  PayloadTooLargeException,
  InternalServerErrorException,
  HttpException,
  Inject,
  Optional,
} from '@nestjs/common';
import type { Request } from 'express';
import busboy from 'busboy';
import { Upload } from '@aws-sdk/lib-storage';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Observable, from, switchMap } from 'rxjs';
import { PassThrough, Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash, randomUUID, type BinaryLike } from 'crypto';
import { S3_CLIENT_TOKEN } from '../s3.module';
import { ConfigService } from '@nestjs/config';
import { S3UploadResult } from '../s3-upload-result.interface';
import { AppLogger } from '@enterprise-sync/shared';

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const S3_UPLOAD_QUEUE_SIZE = 4;
const S3_UPLOAD_PART_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class FastStreamToS3Interceptor implements NestInterceptor {
  private readonly bucketName: string;
  private readonly ALLOWED_MIME_TYPES = [
    'application/x-ndjson',
    'application/octet-stream',
    'application/json',
  ];

  constructor(
    @Inject(S3_CLIENT_TOKEN) private readonly s3Client: S3Client,
    private readonly configService: ConfigService,
    @Optional()
    private readonly logger: AppLogger = new AppLogger(
      undefined,
      FastStreamToS3Interceptor.name,
    ),
  ) {
    this.bucketName = this.configService.getOrThrow<string>('S3_BUCKET_NAME');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();

    const contentType = req.headers['content-type'];
    if (!contentType?.includes('multipart/form-data')) {
      throw new BadRequestException(
        'Expected Content-Type: multipart/form-data header.',
      );
    }

    const tenantIdRaw = req.headers['x-tenant-id'];
    const tenantId = Array.isArray(tenantIdRaw) ? tenantIdRaw[0] : tenantIdRaw;
    if (!tenantId || tenantId.trim().length === 0) {
      throw new BadRequestException(
        'Missing required tenant header: X-Tenant-ID.',
      );
    }

    const expectedHash = this.extractExpectedHash(req);

    return from(this.processUpload(req, expectedHash)).pipe(
      switchMap((uploadResult: S3UploadResult) => {
        Object.assign(req, { uploadedFile: uploadResult });
        return next.handle();
      }),
    );
  }

  private extractExpectedHash(req: Request): string {
    const expectedHashRaw = req.headers['x-expected-hash'];
    const expectedHash = Array.isArray(expectedHashRaw)
      ? expectedHashRaw[0]
      : expectedHashRaw;

    if (!expectedHash) {
      throw new BadRequestException(
        'Missing required checksum header: X-Expected-Hash.',
      );
    }

    return expectedHash
      .trim()
      .toLowerCase()
      .replace(/^sha256:/, '');
  }

  private async processUpload(
    req: Request,
    expectedHash: string,
  ): Promise<S3UploadResult> {
    return new Promise((resolve, reject) => {
      const bb = busboy({
        headers: req.headers,
        limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      });

      let isFileDetected = false;
      let uploadTask: Upload | undefined;
      let uploadObjectKey = 'unknown';

      const abortUpload = () => {
        uploadTask
          ?.abort()
          .catch((e: unknown) =>
            this.logger.error(
              `Failed to abort S3 upload task for key ${uploadObjectKey}`,
              e instanceof Error ? e.stack : String(e),
            ),
          );
      };

      bb.on('file', (_name, fileStream, info) => {
        if (isFileDetected) {
          // Busboy stalls multipart parsing unless unwanted file streams are drained.
          fileStream.resume();
          return;
        }

        isFileDetected = true;
        const { filename, mimeType } = info;

        if (!this.ALLOWED_MIME_TYPES.includes(mimeType)) {
          // Drain the rejected stream so Busboy can finish parsing and emit 'close'.
          fileStream.resume();
          return reject(
            new BadRequestException(
              `Invalid file type: ${mimeType}. Allowed types: ${this.ALLOWED_MIME_TYPES.join(
                ', ',
              )}`,
            ),
          );
        }

        const fileId = randomUUID();
        const safeName = (filename || 'data.ndjson').replace(
          /[^a-zA-Z0-9.-]/g,
          '_',
        );
        uploadObjectKey = `transactions/${fileId}/${safeName}`;

        const hasher = createHash('sha256');

        const hashTransform = new Transform({
          transform(chunk: Buffer, _encoding: string, cb: TransformCallback) {
            hasher.update(chunk as BinaryLike);
            cb(null, chunk);
          },
        });

        const passThrough = new PassThrough();

        uploadTask = new Upload({
          client: this.s3Client,
          params: {
            Bucket: this.bucketName,
            Key: uploadObjectKey,
            Body: passThrough,
            ContentType: mimeType,
          },
          queueSize: S3_UPLOAD_QUEUE_SIZE,
          partSize: S3_UPLOAD_PART_SIZE_BYTES,
        });

        const uploadPromise = uploadTask.done();
        // Attach a no-op handler immediately so an early abort/S3 failure does not
        // trigger an UnhandledPromiseRejection while pipelinePromise is still awaited.
        uploadPromise.catch(() => {});

        const pipelinePromise = pipeline(
          fileStream,
          hashTransform,
          passThrough,
        );

        void this.handleUploadCompletion(
          pipelinePromise,
          uploadPromise,
          hasher,
          expectedHash,
          uploadObjectKey,
          fileId,
          uploadTask,
          resolve,
          reject,
        );

        fileStream.on('limit', () => {
          abortUpload();
          reject(
            new PayloadTooLargeException(
              `File exceeded the allowed size limit (${MAX_FILE_SIZE_BYTES} bytes).`,
            ),
          );
        });
      });

      bb.on('close', () => {
        if (!isFileDetected) {
          reject(new BadRequestException('No file found in the request.'));
        }
      });

      req.on('aborted', () => {
        this.logger.warn(
          'Client aborted HTTP connection. Terminating upload...',
        );
        abortUpload();
        reject(new BadRequestException('Connection aborted by the client.'));
      });

      bb.on('error', (err: Error) => {
        this.logger.error(
          'Busboy parsing error. Terminating upload...',
          err.stack,
        );
        abortUpload();
        reject(
          new InternalServerErrorException(
            `Busboy parsing error: ${err.message}`,
          ),
        );
      });

      req.pipe(bb);
    });
  }

  private async handleUploadCompletion(
    pipelinePromise: Promise<void>,
    uploadPromise: Promise<unknown>,
    hasher: ReturnType<typeof createHash>,
    expectedHash: string,
    uploadObjectKey: string,
    fileId: string,
    uploadTask: Upload | undefined,
    resolve: (value: S3UploadResult) => void,
    reject: (error: Error) => void,
  ): Promise<void> {
    try {
      await pipelinePromise;
      const calculatedHash = hasher.digest('hex');

      if (calculatedHash !== expectedHash) {
        this.logger.warn(
          `[Integrity Error] Hash mismatch for key ${uploadObjectKey}. Expected: ${expectedHash}, Got: ${calculatedHash}. Aborting upload.`,
        );
        await uploadTask?.abort();

        // Single-part uploads can finish before abort() runs; delete defensively so
        // mismatched data does not remain in S3.
        try {
          await this.s3Client.send(
            new DeleteObjectCommand({
              Bucket: this.bucketName,
              Key: uploadObjectKey,
            }),
          );
        } catch (cleanupError: unknown) {
          this.logger.error(
            `Failed to delete corrupted S3 object for key ${uploadObjectKey}:`,
            cleanupError instanceof Error
              ? cleanupError.stack
              : String(cleanupError),
          );
        }

        return reject(new BadRequestException('Checksum mismatch'));
      }

      this.logger.log(
        `Hash for key ${uploadObjectKey} is valid. Waiting for S3 upload to complete.`,
      );
      await uploadPromise;

      const result: S3UploadResult = {
        status: 'accepted',
        fileId,
        sha256: calculatedHash,
        message: 'File accepted and queued for processing',
        objectKey: uploadObjectKey,
      };

      resolve(result);
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        return reject(error);
      }

      this.logger.error(
        `Streaming or upload failed for key ${uploadObjectKey}. Aborting.`,
        error instanceof Error ? error.stack : String(error),
      );
      await uploadTask?.abort();
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      reject(
        new InternalServerErrorException(`Streaming failed: ${errorMessage}`),
      );
    }
  }
}
