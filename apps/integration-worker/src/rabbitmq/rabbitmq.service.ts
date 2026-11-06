import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { connect, Channel, ConsumeMessage, ChannelModel } from 'amqplib';
import { z } from 'zod';
import { Readable } from 'stream';
import type { SyncJobPayload, RabbitMQStatus } from './rabbitmq.types';
import type { LockResult } from '../redis/redis.types';
import { AppLogger } from '@enterprise-sync/shared';
import { DatabaseService } from '../database/database.service';
import { RedisLockService } from '../redis/redis-lock.service';
import { S3ReaderService } from '../s3/s3-reader.service';
import { TransactionProcessorService } from '../processor/transaction-processor.service';
import {
  runWithCorrelationId,
  extractCorrelationIdFromHeaders,
} from '../amqp-cls.interceptor';

@Injectable()
export class RabbitMQConsumerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger: AppLogger;
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private isProcessing = false;
  private isShuttingDown = false;
  private isChannelClosed = true;

  constructor(
    private readonly configService: ConfigService,
    private readonly clsService: ClsService<Record<string, unknown>>,
    private readonly databaseService: DatabaseService,
    private readonly redisLockService: RedisLockService,
    private readonly s3ReaderService: S3ReaderService,
    private readonly transactionProcessor: TransactionProcessorService,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger;
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
    await this.setupTopology();
    await this.startConsuming();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.gracefulShutdown();
  }

  isConnected(): boolean {
    return this.connection !== null && !this.isChannelClosed;
  }

  getStatus(): RabbitMQStatus {
    return {
      isConnected: this.isConnected(),
      isChannelOpen: this.channel !== null && !this.isChannelClosed,
      consumerTag: this.consumerTag,
      isProcessing: this.isProcessing,
      isShuttingDown: this.isShuttingDown,
    };
  }

  private async connect(): Promise<void> {
    const host = this.configService.get<string>('RABBITMQ_HOST', 'localhost');
    const port = this.configService.get<number>('RABBITMQ_PORT', 5672);
    const user = this.configService.get<string>(
      'RABBITMQ_DEFAULT_USER',
      'guest',
    );
    const pass = this.configService.get<string>(
      'RABBITMQ_DEFAULT_PASS',
      'guest',
    );
    const vhost = this.configService.get<string>('RABBITMQ_VHOST', '/');

    const vhostPart =
      vhost && vhost !== '/'
        ? `/${encodeURIComponent(vhost.replace(/^\//, ''))}`
        : '';
    const rabbitUrl = `amqp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}${vhostPart}`;

    this.connection = (await connect(rabbitUrl, {
      heartbeat: 30,
      timeout: 10000,
    })) as unknown as ChannelModel;

    this.connection.on('error', (error: Error) => {
      this.logger.error(`Connection error: ${error.message}`);
    });

    this.connection.on('close', () => {
      this.logger.warn('Connection closed');
    });

    this.channel = await this.connection.createConfirmChannel();
    this.isChannelClosed = false;

    this.channel.on('error', (error: Error) => {
      this.logger.error(`Channel error: ${error.message}`);
    });

    this.channel.on('close', () => {
      this.logger.warn('Channel closed');
      this.isChannelClosed = true;
    });

    this.logger.log(`Connected to RabbitMQ at ${host}:${port}`);
  }

  private async setupTopology(): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not initialized');
    }

    await this.channel.assertExchange('integration.events', 'topic', {
      durable: true,
    });

    await this.channel.assertExchange('integration.events.dlx', 'topic', {
      durable: true,
    });

    await this.channel.assertQueue('tx-sync-jobs-dlq', {
      durable: true,
    });

    await this.channel.bindQueue(
      'tx-sync-jobs-dlq',
      'integration.events.dlx',
      'transaction.file.uploaded',
    );

    await this.channel.assertQueue('tx-sync-jobs-v2', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'integration.events.dlx',
        'x-dead-letter-routing-key': 'transaction.file.uploaded',
      },
    });

    await this.channel.bindQueue(
      'tx-sync-jobs-v2',
      'integration.events',
      'transaction.file.uploaded',
    );

    await this.channel.prefetch(1, false);

    this.logger.log(
      'Topology configured: exchange=integration.events, dlx=integration.events.dlx, queue=tx-sync-jobs-v2, dlq=tx-sync-jobs-dlq, prefetch=1',
    );
  }

  private async startConsuming(): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not initialized');
    }

    const consumer = await this.channel.consume(
      'tx-sync-jobs-v2',
      (msg: ConsumeMessage | null) => {
        if (!msg) {
          this.logger.warn('Received null message (consumer cancelled)');
          return;
        }

        if (this.isShuttingDown) {
          if (this.channel) {
            this.channel.nack(msg, false, true);
          }
          return;
        }

        this.processMessage(msg).catch((error: Error) => {
          this.logger.error(`Processing failed: ${error.message}`);
        });
      },
    );

    this.consumerTag = consumer.consumerTag;
    this.logger.log(
      `Started consuming on queue=tx-sync-jobs-v2, consumerTag=${this.consumerTag}`,
    );
  }

  private async processMessage(msg: ConsumeMessage): Promise<void> {
    if (!this.channel) {
      return;
    }

    this.isProcessing = true;
    const streamWrapper: { stream: Readable | null } = { stream: null };
    let fileId: string | null = null;
    let expectedHash: string | null = null;
    let tenantId: string | null = null;

    const correlationId =
      extractCorrelationIdFromHeaders(
        msg.properties.headers as Record<string, unknown> | undefined,
      ) ?? 'unknown';

    const processWithCls = async (): Promise<void> => {
      const payload = this.parseAndValidatePayload(msg);
      fileId = payload.fileId;
      expectedHash = payload.expectedHash;
      tenantId = payload.tenantId;

      this.logger.log(
        `[correlationId=${payload.correlationId}] Processing job: fileId=${payload.fileId}`,
      );

      const lockResult: LockResult = await this.redisLockService.acquireLock(
        payload.tenantId,
        payload.expectedHash,
      );

      if (lockResult.status === 'COLLISION') {
        if (lockResult.currentState === 'COMPLETED') {
          this.logger.log(
            `[correlationId=${payload.correlationId}] Job already completed, acknowledging`,
          );
          this.channel!.ack(msg);
          return;
        }

        if (lockResult.currentState === 'PROCESSING') {
          this.logger.warn(
            `[correlationId=${payload.correlationId}] Job is currently processing elsewhere, requeueing with delay`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
          this.channel!.nack(msg, false, true);
          return;
        }

        this.logger.warn(
          `[correlationId=${payload.correlationId}] Lock collision in unexpected state: ${lockResult.currentState}, routing to DLQ`,
        );
        this.channel!.nack(msg, false, false);
        return;
      }

      await this.databaseService.updateJobStatus(
        payload.fileId,
        payload.fileId,
        'PROCESSING',
      );

      const bucket =
        payload.bucket ||
        this.configService.get<string>('S3_BUCKET_NAME') ||
        this.configService.get<string>('S3_BUCKET', 'transactions-bucket');
      const key = payload.objectKey;

      const { lines, stream } = await this.s3ReaderService.getStream(
        bucket,
        key,
      );
      streamWrapper.stream = stream;

      await this.transactionProcessor.processFileWithStream(
        payload.fileId,
        lines,
      );

      await this.databaseService.updateJobStatus(
        payload.fileId,
        payload.fileId,
        'COMPLETED',
      );

      await this.redisLockService.updateLockStatus(
        payload.tenantId,
        payload.expectedHash,
        'COMPLETED',
      );

      this.channel!.ack(msg);

      this.logger.log(
        `[correlationId=${payload.correlationId}] Job completed successfully`,
      );
    };

    try {
      await runWithCorrelationId(
        { clsService: this.clsService, correlationId },
        processWithCls,
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `[correlationId=${correlationId}] Message processing failed: ${errorMessage}`,
      );

      const isFatal = this.isFatalError(error);
      const isRedelivered = msg.fields.redelivered;

      if (isFatal || isRedelivered) {
        this.logger.error(
          `[correlationId=${correlationId}] Routing message to DLQ (fatal: ${isFatal}, redelivered: ${isRedelivered})`,
        );

        if (fileId) {
          await this.databaseService.updateJobStatus(fileId, fileId, 'FAILED');
        }

        if (expectedHash && tenantId) {
          await this.redisLockService.releaseLock(tenantId, expectedHash);
        }

        this.channel.nack(msg, false, false);
      } else {
        this.logger.warn(
          `[correlationId=${correlationId}] Transient error, requeueing with backoff`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        this.channel.nack(msg, false, true);
      }
    } finally {
      this.isProcessing = false;

      const s3Stream = streamWrapper.stream;
      if (s3Stream && !s3Stream.destroyed) {
        s3Stream.destroy();
      }
    }
  }

  private parseAndValidatePayload(msg: ConsumeMessage): SyncJobPayload {
    let parsed: unknown;

    try {
      const content = msg.content.toString('utf-8');
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Invalid JSON in message body');
    }

    const payloadSchema = z.object({
      fileId: z.string().uuid('fileId must be a valid UUID'),
      objectKey: z.string().min(1, 'objectKey is required'),
      bucket: z.string().optional(),
      expectedHash: z.string().min(1, 'expectedHash is required'),
      correlationId: z.string().min(1, 'correlationId is required'),
      tenantId: z.string().min(1, 'tenantId is required'),
      messageId: z.string().optional(),
    });

    const result = payloadSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join(', ');
      throw new Error(`Missing or invalid payload properties: ${issues}`);
    }

    return result.data;
  }

  private isFatalError(error: unknown): boolean {
    if (error instanceof SyntaxError) {
      return true;
    }

    if (error instanceof Error) {
      const errorCode = (error as Error & { code?: string }).code;

      if (
        errorCode === 'ECONNREFUSED' ||
        errorCode === 'ETIMEDOUT' ||
        errorCode === 'ENOTFOUND'
      ) {
        return false;
      }

      if (
        error.message.includes('404') ||
        error.message.includes('NotFound') ||
        error.message.includes('NoSuchKey')
      ) {
        return true;
      }

      if (
        error.message.includes('Invalid JSON') ||
        error.message.includes('Missing or invalid') ||
        error.name === 'PrismaClientValidationError' ||
        error.name === 'ZodError' ||
        error.message.includes('invalid input syntax for type uuid')
      ) {
        return true;
      }
    }

    return false;
  }

  private async gracefulShutdown(): Promise<void> {
    this.logger.log('Starting graceful shutdown...');
    this.isShuttingDown = true;

    if (this.channel && this.consumerTag) {
      try {
        await this.channel.cancel(this.consumerTag);
        this.logger.log(`Cancelled consumer ${this.consumerTag}`);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to cancel consumer: ${errorMessage}`);
      }
    }

    await this.waitForCurrentProcessing();

    const SHUTDOWN_TIMEOUT_MS = 15000;

    if (this.channel) {
      try {
        await Promise.race([
          this.channel.close(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Channel close timeout')),
              SHUTDOWN_TIMEOUT_MS,
            ),
          ),
        ]);
        this.isChannelClosed = true;
        this.logger.log('Channel closed');
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to close channel gracefully: ${errorMessage}`,
        );
      }
    }

    if (this.connection) {
      try {
        await Promise.race([
          this.connection.close(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Connection close timeout')),
              SHUTDOWN_TIMEOUT_MS,
            ),
          ),
        ]);
        this.connection = null;
        this.logger.log('Connection closed');
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to close connection gracefully: ${errorMessage}`,
        );
      }
    }

    this.logger.log('Graceful shutdown completed');
  }

  private async waitForCurrentProcessing(): Promise<void> {
    const timeoutMs = 15000;
    const startTime = Date.now();

    while (this.isProcessing && Date.now() - startTime < timeoutMs) {
      this.logger.log('Waiting for current message processing to complete...');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    if (this.isProcessing) {
      this.logger.warn(
        'Timeout reached while waiting for processing to complete, forcing shutdown',
      );
    }
  }
}
