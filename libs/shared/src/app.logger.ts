import { ConsoleLogger, Injectable, Optional } from "@nestjs/common";
import { ClsService } from "nestjs-cls";

@Injectable()
export class AppLogger extends ConsoleLogger {
  private readonly clsService: ClsService<Record<string, unknown>>;

  constructor(
    clsService: ClsService<Record<string, unknown>>,
    @Optional() context: string = AppLogger.name,
  ) {
    super(context);
    this.clsService = clsService;
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
      return this.clsService.get<string>("correlationId");
    } catch {
      return undefined;
    }
  }
}
