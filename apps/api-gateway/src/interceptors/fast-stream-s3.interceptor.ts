import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  BadRequestException,
  PayloadTooLargeException,
  InternalServerErrorException,
  Inject,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import busboy from 'busboy';
import { Upload } from '@aws-sdk/lib-storage';
import { S3Client } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { Observable, from, switchMap } from 'rxjs';
import { PassThrough, Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash, type BinaryLike } from 'crypto';
import { S3_CLIENT_TOKEN } from '../s3.module';
import { ConfigService } from '@nestjs/config';
import { S3UploadResult } from '../s3-upload-result.interface';

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
const S3_UPLOAD_QUEUE_SIZE = 4;
const S3_UPLOAD_PART_SIZE_BYTES = 5 * 1024 * 1024;

@Injectable()
export class FastStreamToS3Interceptor implements NestInterceptor {
  private readonly logger = new Logger(FastStreamToS3Interceptor.name);
  private readonly bucketName: string;
  private readonly ALLOWED_MIME_TYPES = [
    'application/x-ndjson',
    'application/octet-stream',
    'application/json',
  ];

  constructor(
    @Inject(S3_CLIENT_TOKEN) private readonly s3Client: S3Client,
    private readonly configService: ConfigService,
  ) {
    const bucketName = this.configService.get<string>('S3_BUCKET_NAME');

    if (!bucketName) {
      throw new Error('S3_BUCKET_NAME environment variable is required');
    }

    this.bucketName = bucketName;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>();

    const contentType = req.headers['content-type'];
    if (!contentType?.includes('multipart/form-data')) {
      throw new BadRequestException(
        'Expected Content-Type: multipart/form-data header.',
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

    return expectedHash;
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
          .catch((e) =>
            this.logger.error(
              `Failed to abort S3 upload task for key ${uploadObjectKey}`,
              e,
            ),
          );
      };

      bb.on('file', (name, fileStream, info) => {
        isFileDetected = true;
        const { filename, mimeType } = info;

        if (!this.ALLOWED_MIME_TYPES.includes(mimeType)) {
          fileStream.resume();
          return reject(
            new BadRequestException(
              `Invalid file type: ${mimeType}. Allowed types: ${this.ALLOWED_MIME_TYPES.join(
                ', ',
              )}`,
            ),
          );
        }

        const fileId = uuidv4();
        uploadObjectKey = `transactions/${fileId}/${filename.replace(
          /[^a-zA-Z0-9.-]/g,
          '_',
        )}`;

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

      bb.on('finish', () => {
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
        this.logger.error('Busboy parsing error. Terminating upload...', err);
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
    } catch (error) {
      this.logger.error(
        `Streaming or upload failed for key ${uploadObjectKey}. Aborting.`,
        error,
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
