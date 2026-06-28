import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { connect, ConfirmChannel, ChannelModel } from 'amqplib';

export interface RabbitMQOptions {
  exchange: string;
  routingKey: string;
}

export class RabbitMQPublishException extends Error {
  constructor(
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'RabbitMQPublishException';
  }
}

const DEFAULT_PUBLISH_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 4000;

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private connection!: ChannelModel;
  private channel!: ConfirmChannel;
  private readonly logger = new Logger(RabbitMQService.name);
  private isConnecting = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly options: RabbitMQOptions,
    private readonly clsService: ClsService<Record<string, unknown>>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.isConnecting) {
      return;
    }
    this.isConnecting = true;

    try {
      await this.connectWithRetry();
      await this.setupChannel();
    } finally {
      this.isConnecting = false;
    }
  }

  private async connectWithRetry(): Promise<void> {
    const user = this.configService.getOrThrow<string>('RABBITMQ_DEFAULT_USER');
    const pass = this.configService.getOrThrow<string>('RABBITMQ_DEFAULT_PASS');
    const host = this.configService.getOrThrow<string>('RABBITMQ_HOST');
    const portStr = this.configService.getOrThrow<string>('RABBITMQ_PORT');
    const port = Number(portStr);

    if (isNaN(port)) {
      throw new Error(`Invalid RABBITMQ_PORT: "${portStr}" is not a number`);
    }

    const url = `amqp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;

    this.logger.log(`Connecting to RabbitMQ at ${host}:${port}`);

    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.connection = await connect(url);
        break;
      } catch (error) {
        if (attempt === maxAttempts) {
          this.logger.error(
            `Failed to connect to RabbitMQ after ${maxAttempts} attempts`,
          );
          throw error;
        }
        const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 32000);
        this.logger.warn(
          `RabbitMQ connection failed. Retrying in ${delay}ms... (Attempt ${attempt}/${maxAttempts})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    this.connection.on('error', (err) => {
      this.logger.error('RabbitMQ connection error:', err);
    });
    this.connection.on('close', () => {
      this.logger.warn('RabbitMQ connection closed.');
    });
  }

  private async setupChannel(): Promise<void> {
    this.channel = await this.connection.createConfirmChannel();

    this.channel.on('error', (err) => {
      this.logger.error('RabbitMQ channel error:', err);
    });
    this.channel.on('close', () => {
      this.logger.warn('RabbitMQ channel closed.');
    });

    const exchangeName = this.options.exchange;
    await this.channel.assertExchange(exchangeName, 'topic', { durable: true });

    this.logger.log(
      `Connected to RabbitMQ, created ConfirmChannel, and asserted exchange "${exchangeName}"`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
    } catch (err) {
      this.logger.error('Error closing RabbitMQ connection on destroy', err);
    }
  }

  async publish(
    payload: Record<string, unknown>,
    correlationId: string,
    timeoutMs: number = DEFAULT_PUBLISH_TIMEOUT_MS,
  ): Promise<void> {
    const maxRetries = DEFAULT_MAX_RETRIES;

    let buffer: Buffer;
    try {
      buffer = Buffer.from(JSON.stringify(payload));
    } catch (serializationError) {
      throw new Error('Failed to serialize payload to JSON', {
        cause: serializationError,
      });
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.publishWithTimeout(
          this.options.exchange,
          this.options.routingKey,
          buffer,
          timeoutMs,
        );
        return;
      } catch (error: unknown) {
        const isRetryable = this.isRetryableError(error);

        if (isRetryable && attempt < maxRetries) {
          const delay = Math.min(
            Math.pow(2, attempt) * INITIAL_RETRY_DELAY_MS,
            MAX_RETRY_DELAY_MS,
          );
          this.logger.warn(
            `RabbitMQ publish failed with retryable error (attempt ${attempt + 1}/${maxRetries + 1}): ${this.getErrorMessage(error)}. Retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          this.logger.error(
            `[CRITICAL] Failed to publish message to RabbitMQ after ${attempt + 1} attempts. CorrelationId: ${correlationId}. Message: ${JSON.stringify(payload)}`,
          );
          throw new RabbitMQPublishException(
            `Failed to publish message after ${attempt + 1} attempts`,
            error,
          );
        }
      }
    }
  }

  private publishWithTimeout(
    exchange: string,
    routingKey: string,
    buffer: Buffer,
    timeoutMs: number,
  ): Promise<void> {
    const correlationId = this.clsService.get<string>('correlationId') ?? '';
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new RabbitMQPublishException(
            `RabbitMQ publish timeout after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      try {
        this.channel.publish(
          exchange,
          routingKey,
          buffer,
          {
            persistent: true,
            headers: { 'x-correlation-id': correlationId },
          },
          (err) => {
            clearTimeout(timeoutId);
            if (err) {
              reject(
                new RabbitMQPublishException(
                  `Broker rejected message: ${this.getErrorMessage(err)}`,
                  err,
                ),
              );
            } else {
              resolve();
            }
          },
        );
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private isRetryableError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const err = error as Record<string, unknown>;
    const code = typeof err.code === 'string' ? err.code : undefined;
    const message = typeof err.message === 'string' ? err.message : undefined;

    if (code === 'ECONNREFUSED') {
      return true;
    }

    if (message) {
      const lowerMessage = message.toLowerCase();
      return (
        lowerMessage.includes('channel') || lowerMessage.includes('timeout')
      );
    }

    return false;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
