import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { RabbitMQConsumerService } from '../rabbitmq/rabbitmq.service';
import { DatabaseService } from '../database/database.service';

interface LivenessResponse {
  status: string;
  timestamp: string;
}

interface ReadinessResponse {
  status: string;
  details?: {
    rabbitmq: boolean;
    database: boolean;
  };
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly rabbitMQService: RabbitMQConsumerService,
    private readonly databaseService: DatabaseService,
  ) {}

  @Get('liveness')
  getLiveness(): LivenessResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('readiness')
  async getReadiness(): Promise<ReadinessResponse> {
    const rabbitmqConnected = this.rabbitMQService.isConnected();
    let databaseConnected = false;

    try {
      await this.databaseService.$queryRaw`SELECT 1`;
      databaseConnected = true;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException({
        status: 'error',
        details: {
          rabbitmq: rabbitmqConnected,
          database: false,
          error: errorMessage,
        },
      });
    }

    if (!rabbitmqConnected || !databaseConnected) {
      throw new ServiceUnavailableException({
        status: 'error',
        details: {
          rabbitmq: rabbitmqConnected,
          database: databaseConnected,
        },
      });
    }

    return {
      status: 'ok',
      details: {
        rabbitmq: rabbitmqConnected,
        database: databaseConnected,
      },
    };
  }
}
