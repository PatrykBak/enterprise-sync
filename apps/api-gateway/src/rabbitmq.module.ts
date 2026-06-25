import { Module, DynamicModule, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQService } from './rabbitmq.service';

const DEFAULT_EXCHANGE = 'integration.events';
const DEFAULT_ROUTING_KEY = 'transaction.file.uploaded';

interface RabbitMQModuleOptions {
  exchange?: string;
  routingKey?: string;
}

@Module({})
export class RabbitMQModule {
  static forRoot(options: RabbitMQModuleOptions = {}): DynamicModule {
    const exchange = options.exchange ?? DEFAULT_EXCHANGE;
    const routingKey = options.routingKey ?? DEFAULT_ROUTING_KEY;

    if (!exchange || !routingKey) {
      throw new Error('Exchange and routingKey must be non-empty strings');
    }

    const rabbitMQServiceProvider: Provider = {
      provide: RabbitMQService,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        return new RabbitMQService(configService, { exchange, routingKey });
      },
    };

    return {
      module: RabbitMQModule,
      imports: [ConfigModule],
      providers: [rabbitMQServiceProvider],
      exports: [RabbitMQService],
    };
  }
}
