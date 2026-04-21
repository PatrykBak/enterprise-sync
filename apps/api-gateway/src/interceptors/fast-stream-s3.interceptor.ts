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
import { Request } from 'express';
import busboy from 'busboy';
import { Upload } from '@aws-sdk/lib-storage';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { PassThrough, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import { S3_CLIENT_TOKEN } from '../s3.module';
import { ConfigService } from '@nestjs/config';
import { S3UploadResult } from '../s3-upload-result.interface';

/**
 * A NestJS interceptor that efficiently streams a multipart file upload directly to an S3-compatible
 * object storage without buffering the entire file in memory or on disk.
 *
 * It performs the following operations in a single pass:
 * 1. Parses the multipart/form-data stream using `busboy`.
 * 2. Calculates the file's SHA256 hash on the fly.
 * 3. Streams the file directly to S3 using `@aws-sdk/lib-storage`'s Upload.
 * 4. Validates required headers (`Content-Type`, `X-Expected-Hash`).
 * 5. Verifies the file's integrity by comparing the calculated hash with the expected hash.
 * 6. Handles various error scenarios gracefully (e.g., client disconnect, size limits, hash mismatch).
 */
@Injectable()
export class FastStreamToS3Interceptor implements NestInterceptor {
  private readonly logger = new Logger(FastStreamToS3Interceptor.name);

  constructor(
    @Inject(S3_CLIENT_TOKEN) private readonly s3Client: S3Client,
    private readonly configService: ConfigService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<S3UploadResult>> {
    const req = context.switchToHttp().getRequest<Request>();

    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      throw new BadRequestException(
        'Expected Content-Type: multipart/form-data header.',
      );
    }

    const expectedHash = req.headers['x-expected-hash'] as string;
    if (!expectedHash) {
      throw new BadRequestException(
        'Missing required checksum header: X-Expected-Hash.',
      );
    }

    // The entire stream processing logic is wrapped in a Promise.
    // This is because `busboy` is an event-driven parser, and its lifecycle
    // doesn't align directly with the async/await or Observable patterns
    // expected by NestJS interceptors. This Promise resolves or rejects
    // based on the outcome of the stream processing.
    return new Promise((resolve, reject) => {
      const bb = busboy({
        headers: req.headers,
        limits: {
          fileSize: 2 * 1024 * 1024 * 1024,
          files: 1,
        },
      });

      let isFileDetected = false;
      let uploadTask: Upload | null = null;

      bb.on('file', (name, fileStream, info) => {
        isFileDetected = true;
        const { filename, mimeType } = info;

        if (
          mimeType !== 'application/x-ndjson' &&
          mimeType !== 'application/octet-stream'
        ) {
          // If the file type is invalid, we must consume the rest of the stream
          // to prevent the request from hanging, then reject.
          fileStream.resume();
          return reject(
            new BadRequestException(`Invalid file type: ${mimeType}`),
          );
        }

        const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const fileId = uuidv4();
        const objectKey = `transactions/${fileId}/${sanitizedFilename}`;

        const hasher = createHash('sha256');

        // This Transform stream acts as a "passthrough" with a side effect.
        // For each chunk of data that flows through it, it updates the SHA256 hasher.
        // The chunk itself is passed on unmodified to the next stream in the pipeline.
        // This allows for on-the-fly hash calculation without an extra read pass.
        const hashTransform = new Transform({
          transform(chunk: Buffer, encoding: BufferEncoding, callback) {
            hasher.update(chunk);
            callback(null, chunk);
          },
        });

        const passThrough = new PassThrough();

        const bucketName = this.configService.get<string>(
          'S3_BUCKET_NAME',
          'transactions-bucket',
        );

        // The S3 Upload utility from `@aws-sdk/lib-storage` handles multipart uploads
        // automatically. It reads from the `passThrough` stream.
        uploadTask = new Upload({
          client: this.s3Client,
          params: {
            Bucket: bucketName,
            Key: objectKey,
            Body: passThrough,
            ContentType: mimeType,
          },
          queueSize: 4,
          partSize: 5 * 1024 * 1024,
        });

        // `pipeline` connects the streams together. Data flows from `fileStream` (from the client),
        // through `hashTransform` (for hashing), and into `passThrough` (which the S3 Upload consumes).
        // `pipeline` also ensures that if one stream fails, all streams in the pipeline are destroyed.
        const pipelinePromise = pipeline(
          fileStream,
          hashTransform,
          passThrough,
        );

        // This is the critical synchronization point. We wait for two separate asynchronous
        // operations to complete:
        // 1. `uploadTask.done()`: The S3 upload is complete.
        // 2. `pipelinePromise`: The entire file has been read from the client and passed through our local pipeline.
        // Only when both are finished can we be sure the file is on S3 and we have the final hash.
        Promise.all([uploadTask.done(), pipelinePromise])
          .then(async () => {
            const calculatedHash = hasher.digest('hex');

            if (calculatedHash !== expectedHash) {
              this.logger.warn(
                `[Integrity Error] Hash mismatch. Expected: ${expectedHash}, Got: ${calculatedHash}. Deleting file...`,
              );
              await this.s3Client.send(
                new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }),
              );
              return reject(new BadRequestException('Checksum mismatch'));
            }

            // Attach the upload result to the request object for the controller to access
            // via a custom decorator (@UploadedS3File).
            req['uploadedFile'] = {
              status: 'accepted',
              fileId: fileId,
              sha256: calculatedHash,
              message: 'File accepted and queued for processing',
              objectKey: objectKey,
            };
            resolve(next.handle());
          })
          .catch(async (err) => {
            // Centralized error handling for the pipeline or S3 upload.
            // If an upload was in progress, we must abort it to clean up any partial
            // data on S3 and release resources.
            if (uploadTask) {
              await uploadTask
                .abort()
                .catch((e) =>
                  this.logger.error(
                    'Failed to abort upload task during stream error',
                    e,
                  ),
                );
            }
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            reject(
              new InternalServerErrorException(
                `Streaming failed: ${errorMessage}`,
              ),
            );
          });

        // Handles the case where the file exceeds the size limit defined in `busboy`.
        fileStream.on('limit', () => {
          // Abort the S3 upload if it has started.
          if (uploadTask) {
            uploadTask
              .abort()
              .catch((e) =>
                this.logger.error(
                  'Failed to abort upload task on size limit',
                  e,
                ),
              );
          }
          reject(
            new PayloadTooLargeException(
              'File exceeded the allowed size limit (2 GB).',
            ),
          );
        });
      });

      // Handles the case where the client sends a multipart request but without a file part.
      bb.on('finish', () => {
        if (!isFileDetected) {
          return reject(
            new BadRequestException('No file found in the request.'),
          );
        }
      });

      // Handles client-side connection termination (e.g., user closes browser tab).
      req.on('aborted', () => {
        if (uploadTask) {
          this.logger.warn(
            'Client aborted HTTP connection. Terminating upload...',
          );
          uploadTask
            .abort()
            .catch((e) =>
              this.logger.error(
                'Failed to abort upload task on client disconnect',
                e,
              ),
            );
        }
        reject(new BadRequestException('Connection aborted by the client.'));
      });

      // Handles parsing errors from busboy itself (e.g., malformed multipart data).
      bb.on('error', (err) => {
        if (uploadTask) {
          uploadTask
            .abort()
            .catch((e) =>
              this.logger.error(
                'Failed to abort upload task on Busboy error',
                e,
              ),
            );
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        reject(
          new InternalServerErrorException(
            `Busboy parsing error: ${errorMessage}`,
          ),
        );
      });

      // This starts the entire process. It connects the incoming request stream (`req`)
      // to the `busboy` parser, which will then start emitting events like 'file'.
      req.pipe(bb);
    });
  }
}
