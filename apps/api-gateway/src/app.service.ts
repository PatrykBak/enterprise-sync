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
    } catch (publishError) {
      await this.compensateFailedPublish(
        uploadedFile.objectKey,
        correlationId,
        publishError,
      );

      throw new ServiceUnavailableException(
        'System temporarily unavailable. File rejected.',
      );
    }
  }

  private async compensateFailedPublish(
    objectKey: string,
    correlationId: string,
    publishError: unknown,
  ): Promise<void> {
    const compensationAttemptId = uuidv4();
    const errorDetails =
      publishError instanceof Error ? publishError.stack : String(publishError);

    this.logger.error(
      `[Compensation] Failed to publish event for file ${objectKey} (correlationId: ${correlationId}). ` +
        `Initiating S3 object deletion. Compensation ID: ${compensationAttemptId}`,
      errorDetails,
    );

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({ Bucket: this.bucketName, Key: objectKey }),
      );
      this.logger.warn(
        `[Compensation] Successfully deleted S3 object ${objectKey}. Compensation ID: ${compensationAttemptId}`,
      );
    } catch (compensationError) {
      const compErrorDetails =
        compensationError instanceof Error
          ? compensationError.stack
          : String(compensationError);

      this.logger.error(
        `[CRITICAL] COMPENSATION FAILED! Could not delete S3 object after a RabbitMQ publish failure. ` +
          `Manual intervention required for key: ${objectKey}. Compensation ID: ${compensationAttemptId}`,
        compErrorDetails,
      );
    }
  }
}
