import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AppLogger } from './app.logger';
import { RabbitMQModule } from './rabbitmq/rabbitmq.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';
import { S3Module } from './s3/s3.module';
import { TransactionProcessorService } from './processor/transaction-processor.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    ClsModule.forRoot({
      global: true,
    }),
    DatabaseModule,
    RabbitMQModule,
    HealthModule,
    RedisModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (...args: unknown[]) => {
        const configService = args[0] as ConfigService;
        return {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
          db: configService.get<number>('REDIS_DB', 0),
          retryMaxAttempts: 10,
          retryMaxDelay: 3000,
        };
      },
      inject: [ConfigService],
    }),
    S3Module,
  ],
  controllers: [AppController],
  providers: [AppService, AppLogger, TransactionProcessorService],
})
export class AppModule {}
