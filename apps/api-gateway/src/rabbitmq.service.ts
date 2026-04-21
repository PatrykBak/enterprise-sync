import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, ChannelModel, ConfirmChannel } from 'amqplib';

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private connection!: ChannelModel;
  private channel!: ConfirmChannel;
  private readonly logger = new Logger(RabbitMQService.name);

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const user = this.configService.getOrThrow<string>('RABBITMQ_DEFAULT_USER');
    const pass = this.configService.getOrThrow<string>('RABBITMQ_DEFAULT_PASS');

    const safeUser = encodeURIComponent(user);
    const safePass = encodeURIComponent(pass);

    const url = `amqp://${safeUser}:${safePass}@localhost:5672`;

    this.logger.log(
      `Connecting to RabbitMQ with user "${user}" at localhost:5672`,
    );

    this.connection = await connect(url);

    this.connection.on('error', (err) => {
      this.logger.error('RabbitMQ connection error:', err);
    });
    this.connection.on('close', () => {
      this.logger.warn('RabbitMQ connection closed.');
    });

    this.channel = await this.connection.createConfirmChannel();

    this.channel.on('error', (err) => {
      this.logger.error('RabbitMQ channel error:', err);
    });
    this.channel.on('close', () => {
      this.logger.warn('RabbitMQ channel closed.');
    });

    const exchangeName = 'integration.events';
    await this.channel.assertExchange(exchangeName, 'topic', { durable: true });

    this.logger.log(
      `Connected to RabbitMQ, created ConfirmChannel, and asserted exchange "${exchangeName}"`,
    );
  }

  async onModuleDestroy() {
    try {
      if (this.channel) await this.channel.close();
      if (this.connection) await this.connection.close();
    } catch (err) {
      this.logger.error('Error closing RabbitMQ connection on destroy', err);
    }
  }

  /**
   * Publishes an event to RabbitMQ using a ConfirmChannel.
   *
   * A ConfirmChannel guarantees that the message has been either accepted or
   * rejected by the broker. This method wraps the callback-based amqplib publish
   * into a Promise with a timeout to prevent the application from hanging indefinitely.
   */
  async publishEvent(
    exchange: string,
    routingKey: string,
    payload: Record<string, any>,
    timeoutMs = 3000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(JSON.stringify(payload));

      const timeoutId = setTimeout(() => {
        reject(
          new InternalServerErrorException(
            `RabbitMQ publish timeout after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      try {
        this.channel.publish(
          exchange,
          routingKey,
          buffer,

          { persistent: true },

          (err) => {
            clearTimeout(timeoutId);

            if (err) {
              reject(
                new InternalServerErrorException(
                  `Broker rejected message: ${err instanceof Error ? err.message : String(err)}`,
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
}
