import { Module, Global } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AppLogger } from '@enterprise-sync/shared';
import { RabbitMQModule } from './rabbitmq/rabbitmq.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';
import { S3Module } from './s3/s3.module';

@Global()
@Module({
  providers: [AppLogger],
  exports: [AppLogger],
})
class GlobalSharedModule {}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    ClsModule.forRoot({
      global: true,
    }),
    GlobalSharedModule,
    DatabaseModule,
    S3Module,
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
    RabbitMQModule,
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
