import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { RabbitMQConsumerService } from '../rabbitmq/rabbitmq.service';
import { DatabaseService } from '../database/database.service';

export interface LivenessResponse {
  status: string;
  timestamp: string;
}

export interface ReadinessResponse {
  status: string;
  details: {
    rabbitmq: boolean;
    database: boolean;
    error?: string;
  };
  timestamp: string;
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
    let databaseError: string | undefined;

    try {
      await this.databaseService.$queryRaw`SELECT 1`;
      databaseConnected = true;
    } catch (error: unknown) {
      databaseError = error instanceof Error ? error.message : String(error);
      databaseConnected = false;
    }

    const isHealthy = rabbitmqConnected && databaseConnected;
    const responsePayload: ReadinessResponse = {
      status: isHealthy ? 'ok' : 'error',
      details: {
        rabbitmq: rabbitmqConnected,
        database: databaseConnected,
        ...(databaseError ? { error: databaseError } : {}),
      },
      timestamp: new Date().toISOString(),
    };

    if (!isHealthy) {
      throw new ServiceUnavailableException(responsePayload);
    }

    return responsePayload;
  }
}
