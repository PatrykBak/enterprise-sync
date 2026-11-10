import {
  Injectable,
  Inject,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { RabbitMQService } from './rabbitmq.service';
import { S3_CLIENT_TOKEN } from './s3.module';
import { S3UploadResult } from './s3-upload-result.interface';
import { AppLogger } from '@enterprise-sync/shared';
import { randomUUID } from 'crypto';

@Injectable()
export class AppService {
  private readonly bucketName: string;

  constructor(
    @Inject(S3_CLIENT_TOKEN) private readonly s3Client: S3Client,
    private readonly configService: ConfigService,
    private readonly rabbitMQService: RabbitMQService,
    @Optional()
    private readonly logger: AppLogger = new AppLogger(
      undefined,
      AppService.name,
    ),
  ) {
    this.bucketName = this.configService.getOrThrow<string>('S3_BUCKET_NAME');
  }

  async processSyncTransaction(
    uploadedFile: S3UploadResult,
    expectedHash: string,
    correlationId: string,
    tenantId: string,
  ): Promise<void> {
    const payload = {
      messageId: randomUUID(),
      fileId: uploadedFile.fileId,
      objectKey: uploadedFile.objectKey,
      bucket: this.bucketName,
      expectedHash,
      correlationId,
      tenantId,
      uploadedAt: new Date().toISOString(),
    };

    try {
      await this.rabbitMQService.publish(payload, correlationId);
      this.logger.log(
        `Event successfully published to the broker for file: ${uploadedFile.fileId}`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Failed to publish event for file ${uploadedFile.fileId}:`,
        error instanceof Error ? error.stack : String(error),
      );

      try {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: uploadedFile.objectKey,
          }),
        );
        this.logger.warn(
          `Successfully rolled back S3 object for key: ${uploadedFile.objectKey}`,
        );
      } catch (s3Error: unknown) {
        this.logger.error(
          `Failed to delete S3 file ${uploadedFile.objectKey} during rollback:`,
          s3Error instanceof Error ? s3Error.stack : String(s3Error),
        );
      }

      throw new ServiceUnavailableException(
        'System temporarily unavailable. File rejected.',
      );
    }
  }
}
