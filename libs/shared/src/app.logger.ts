import { ConsoleLogger, Injectable, type Type } from "@nestjs/common";
import { ClsService } from "nestjs-cls";

@Injectable()
export class AppLogger extends ConsoleLogger {
  private readonly clsService: ClsService<Record<string, unknown>>;

  constructor(
    clsService: ClsService<Record<string, unknown>>,
    context: string = AppLogger.name,
  ) {
    super(context);
    this.clsService = clsService;
  }

  log(message: string): void {
    const correlationId = this.getCorrelationId();
    const formattedMessage = correlationId
      ? `[Correlation-ID: ${correlationId}] ${message}`
      : message;
    super.log(formattedMessage);
  }

  error(message: string, stack?: string): void {
    const correlationId = this.getCorrelationId();
    const formattedMessage = correlationId
      ? `[Correlation-ID: ${correlationId}] ${message}`
      : message;
    super.error(formattedMessage, stack);
  }

  warn(message: string): void {
    const correlationId = this.getCorrelationId();
    const formattedMessage = correlationId
      ? `[Correlation-ID: ${correlationId}] ${message}`
      : message;
    super.warn(formattedMessage);
  }

  static forContext(context: string): Type<AppLogger> {
    @Injectable()
    class ContextLogger extends AppLogger {
      constructor(clsService: ClsService<Record<string, unknown>>) {
        super(clsService, context);
      }
    }
    return ContextLogger as Type<AppLogger>;
  }

  private getCorrelationId(): string | undefined {
    try {
      return this.clsService.get<string>("correlationId");
    } catch {
      return undefined;
    }
  }
}
