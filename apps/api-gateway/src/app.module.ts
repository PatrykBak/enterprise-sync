import { Module, OnModuleDestroy, Inject, Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health.controller';
import { AuthController } from './auth/auth.controller';
import { S3Module } from './s3.module';
import { RabbitMQModule } from './rabbitmq.module';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { AppLogger } from '@enterprise-sync/shared';
import { AuthModule } from './auth/auth.module';

export const THROTTLER_REDIS_CLIENT = 'THROTTLER_REDIS_CLIENT';

const throttlerRedisProvider: Provider = {
  provide: THROTTLER_REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    return new Redis({
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: configService.get<string>('REDIS_PASSWORD'),
      db: configService.get<number>('REDIS_DB', 0),
    });
  },
};

@Module({
  providers: [throttlerRedisProvider],
  exports: [THROTTLER_REDIS_CLIENT],
})
class ThrottlerRedisModule {}

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (): string => randomUUID(),
        setup: (cls, req: Request, res: Response): void => {
          const headerCorrelationId = req.headers['x-correlation-id'];
          const correlationId =
            typeof headerCorrelationId === 'string' &&
            headerCorrelationId.trim().length > 0
              ? headerCorrelationId.trim()
              : cls.getId();
          cls.set('correlationId', correlationId);
          if (res && typeof res.setHeader === 'function') {
            res.setHeader('x-correlation-id', correlationId);
          }
        },
      },
    }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    ThrottlerRedisModule,
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerRedisModule],
      inject: [THROTTLER_REDIS_CLIENT],
      useFactory: (redis: Redis): ThrottlerModuleOptions => {
        return {
          throttlers: [
            {
              ttl: 60000,
              limit: 10,
            },
          ],
          storage: new ThrottlerStorageRedisService(redis),
        };
      },
    }),
    S3Module,
    RabbitMQModule.forRoot(),
    AuthModule,
  ],
  controllers: [AppController, HealthController, AuthController],
  providers: [
    AppService,
    AppLogger,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements OnModuleDestroy {
  constructor(
    @Inject(THROTTLER_REDIS_CLIENT) private readonly throttlerRedis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.throttlerRedis.quit();
    } catch {
      this.throttlerRedis.disconnect();
    }
  }
}
