import {
  Module,
  DynamicModule,
  FactoryProvider,
  ModuleMetadata,
  InjectionToken,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisLockService } from './redis-lock.service';

export interface RedisModuleOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
  retryMaxAttempts?: number;
  retryMaxDelay?: number;
}

export type RedisModuleFactory = (
  ...args: unknown[]
) => Promise<RedisModuleOptions> | RedisModuleOptions;

export interface RedisModuleAsyncOptions extends Pick<
  ModuleMetadata,
  'imports'
> {
  useFactory: RedisModuleFactory;
  inject?: Array<InjectionToken>;
}

@Module({})
export class RedisModule {
  static register(options: RedisModuleOptions): DynamicModule {
    const redisClientProvider: FactoryProvider<Redis> = {
      provide: REDIS_CLIENT,
      useFactory: (): Redis => {
        return RedisModule.createRedisClient(options);
      },
    };

    return {
      module: RedisModule,
      providers: [redisClientProvider, RedisLockService],
      exports: [RedisLockService],
    };
  }

  static registerAsync(asyncOptions: RedisModuleAsyncOptions): DynamicModule {
    const redisClientProvider: FactoryProvider<Redis> = {
      provide: REDIS_CLIENT,
      useFactory: async (...args: unknown[]): Promise<Redis> => {
        const options = await asyncOptions.useFactory(...args);
        return RedisModule.createRedisClient(options);
      },
      inject: asyncOptions.inject ?? [],
    };

    return {
      module: RedisModule,
      imports: asyncOptions.imports ?? [],
      providers: [redisClientProvider, RedisLockService],
      exports: [RedisLockService],
    };
  }

  private static createRedisClient(options: RedisModuleOptions): Redis {
    const client = new Redis({
      host: options.host,
      port: options.port,
      password: options.password,
      db: options.db ?? 0,
      retryStrategy: (times: number): number | void => {
        if (times > (options.retryMaxAttempts ?? 10)) {
          return undefined;
        }
        return Math.min(times * 100, options.retryMaxDelay ?? 3000);
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    client.on('error', (error: Error) => {
      console.error('[Redis] Connection error:', error.message);
    });

    return client;
  }
}
