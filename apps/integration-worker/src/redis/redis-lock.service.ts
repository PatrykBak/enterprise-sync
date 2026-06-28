import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import {
  REDIS_CLIENT,
  LOCK_PREFIX,
  LOCK_TTL_SECONDS,
  FINALIZE_TTL_SECONDS,
} from './redis.constants';
import { LockResult } from './redis.types';
import { AppLogger } from '../app.logger';

@Injectable()
export class RedisLockService implements OnModuleDestroy {
  private readonly logger: AppLogger;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redisClient: Redis,
    logger: AppLogger,
  ) {
    this.logger = logger;
  }

  async acquireLock(expectedHash: string): Promise<LockResult> {
    const key = `${LOCK_PREFIX}${expectedHash}`;

    try {
      const result = await this.redisClient.set(
        key,
        'PROCESSING',
        'EX',
        LOCK_TTL_SECONDS,
        'NX',
      );

      if (result === 'OK') {
        return { status: 'ACQUIRED' };
      }

      const currentValue = await this.redisClient.get(key);

      if (currentValue === 'PROCESSING') {
        return { status: 'COLLISION', currentState: 'PROCESSING' };
      }

      if (currentValue === 'COMPLETED') {
        return { status: 'COLLISION', currentState: 'COMPLETED' };
      }

      return { status: 'COLLISION', currentState: 'UNKNOWN' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.stack : String(error);
      this.logger.error(
        `Failed to acquire lock for ${expectedHash}`,
        errorMessage,
      );
      throw error;
    }
  }

  async updateLockStatus(
    expectedHash: string,
    status: 'COMPLETED' | 'FAILED',
  ): Promise<void> {
    const key = `${LOCK_PREFIX}${expectedHash}`;

    try {
      const result = await this.redisClient.set(
        key,
        status,
        'EX',
        FINALIZE_TTL_SECONDS,
      );

      if (result !== 'OK') {
        throw new Error(
          `Failed to update lock status for ${expectedHash} to ${status}`,
        );
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.stack : String(error);
      this.logger.error(
        `Failed to update lock status for ${expectedHash} to ${status}`,
        errorMessage,
      );
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redisClient.quit();
  }
}
