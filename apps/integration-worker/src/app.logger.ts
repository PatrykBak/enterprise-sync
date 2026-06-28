import { Injectable, Logger as NestLogger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class AppLogger extends NestLogger {
  constructor(
    private readonly clsService: ClsService<Record<string, unknown>>,
  ) {
    super(AppLogger.name);
  }

  override log(message: string, context?: string): void {
    const correlationId = this.getCorrelationId();
    const formattedMessage = correlationId
      ? `[Correlation-ID: ${correlationId}] ${message}`
      : message;
    super.log(formattedMessage, context);
  }

  override error(message: string, stack?: string, context?: string): void {
    const correlationId = this.getCorrelationId();
    const formattedMessage = correlationId
      ? `[Correlation-ID: ${correlationId}] ${message}`
      : message;
    super.error(formattedMessage, stack, context);
  }

  override warn(message: string, context?: string): void {
    const correlationId = this.getCorrelationId();
    const formattedMessage = correlationId
      ? `[Correlation-ID: ${correlationId}] ${message}`
      : message;
    super.warn(formattedMessage, context);
  }

  private getCorrelationId(): string | undefined {
    try {
      return this.clsService.get<string>('correlationId');
    } catch {
      return undefined;
    }
  }
}
