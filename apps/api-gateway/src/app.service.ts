import {
  Injectable,
  Logger,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { RabbitMQService } from './rabbitmq.service';
import { S3_CLIENT_TOKEN } from './s3.module';
import { S3UploadResult } from './s3-upload-result.interface';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(
    @Inject(S3_CLIENT_TOKEN) private readonly s3Client: S3Client,
    private readonly configService: ConfigService,
    private readonly rabbitMQService: RabbitMQService,
  ) {}

  async processSyncTransaction(
    uploadedFile: S3UploadResult,
    expectedHash: string,
    correlationId: string,
    tenantId: string,
  ) {
    const payload = {
      fileId: uploadedFile.fileId,
      expectedHash,
      correlationId,
      tenantId,
      uploadedAt: new Date().toISOString(),
    };

    try {
      await this.rabbitMQService.publishEvent(
        'integration.events',
        'transaction.file.uploaded',
        payload,
      );
      this.logger.log(
        `Event successfully published to the broker for file: ${uploadedFile.fileId}`,
      );
    } catch (publishError) {
      this.logger.error(
        `Error publishing event to RabbitMQ for file ${uploadedFile.fileId}:`,
        publishError,
      );

      const bucketName = this.configService.get<string>(
        'S3_BUCKET_NAME',
        'transactions-bucket',
      );
      const objectKey = uploadedFile.objectKey;

      try {
        await this.s3Client.send(
          new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }),
        );
        this.logger.warn(
          `Compensation successful: deleted uploaded file from MinIO (${objectKey})`,
        );
      } catch (compensationError) {
        this.logger.error(
          `[CRITICAL ERROR] COMPENSATION FAILED! Orphaned file left in MinIO. ` +
            `Manual deletion required! Bucket: ${bucketName}, Key: ${objectKey}. ` +
            `Report this to an administrator immediately.`,
          compensationError,
        );
      }

      throw new ServiceUnavailableException(
        'System temporarily unavailable. File rejected.',
      );
    }
  }
}
