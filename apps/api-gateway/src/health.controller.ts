import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import Redis from 'ioredis';
import { RabbitMQService } from './rabbitmq.service';
import { THROTTLER_REDIS_CLIENT } from './throttler-redis.constants';

@Controller('health')
export class HealthController {
  constructor(
    private readonly rabbitMQService: RabbitMQService,
    @Inject(THROTTLER_REDIS_CLIENT) private readonly throttlerRedis: Redis,
  ) {}

  @Get('liveness')
  @SkipThrottle()
  checkLiveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('readiness')
  @SkipThrottle()
  async checkReadiness(): Promise<{
    status: string;
    details: { rabbitmq: boolean; redis: boolean };
    timestamp: string;
  }> {
    const rabbitConnected = this.rabbitMQService.isConnected();
    let redisConnected = false;

    try {
      const pong = await this.throttlerRedis.ping();
      redisConnected = pong === 'PONG';
    } catch {
      redisConnected = false;
    }

    if (!rabbitConnected || !redisConnected) {
      throw new ServiceUnavailableException({
        status: 'error',
        details: {
          rabbitmq: rabbitConnected,
          redis: redisConnected,
        },
      });
    }

    return {
      status: 'ok',
      details: {
        rabbitmq: true,
        redis: true,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
