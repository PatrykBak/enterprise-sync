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
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly bucketName: string;

  constructor(
    @Inject(S3_CLIENT_TOKEN) private readonly s3Client: S3Client,
    private readonly configService: ConfigService,
    private readonly rabbitMQService: RabbitMQService,
  ) {
    const bucketName = this.configService.get<string>('S3_BUCKET_NAME');

    if (!bucketName) {
      throw new Error('S3_BUCKET_NAME environment variable is required');
    }

    this.bucketName = bucketName;
  }

  async processSyncTransaction(
    uploadedFile: S3UploadResult,
    expectedHash: string,
    correlationId: string,
    tenantId: string,
  ): Promise<void> {
    const payload = {
      messageId: uuidv4(),
      fileId: uploadedFile.fileId,
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
    } catch (error) {
      this.logger.error(
        `Failed to publish event for file ${uploadedFile.fileId}:`,
        error,
      );
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: uploadedFile.objectKey,
        }),
      );

      throw new ServiceUnavailableException(
        'System temporarily unavailable. File rejected.',
      );
    }
  }
}
