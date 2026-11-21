import { ConsoleLogger, Injectable, Optional } from "@nestjs/common";
import { ClsService } from "nestjs-cls";

@Injectable()
export class AppLogger extends ConsoleLogger {
  constructor(
    @Optional() private readonly clsService?: ClsService,
    @Optional() context: string = AppLogger.name,
  ) {
    super(context);
  }

  override log(message: unknown, context?: string): void {
    super.log(this.prefixCorrelationId(message), context);
  }

  override error(message: unknown, stack?: string, context?: string): void {
    super.error(this.prefixCorrelationId(message), stack, context);
  }

  override warn(message: unknown, context?: string): void {
    super.warn(this.prefixCorrelationId(message), context);
  }

  override debug(message: unknown, context?: string): void {
    super.debug(this.prefixCorrelationId(message), context);
  }

  private prefixCorrelationId(message: unknown): unknown {
    const correlationId = this.getCorrelationId();
    if (!correlationId) {
      return message;
    }

    if (typeof message === "string") {
      return `[Correlation-ID: ${correlationId}] ${message}`;
    }

    return `[Correlation-ID: ${correlationId}] ${JSON.stringify(message)}`;
  }

  private getCorrelationId(): string | undefined {
    try {
      return this.clsService?.get<string>("correlationId");
    } catch {
      // CLS throws outside an active request/AMQP scope (e.g., during bootstrap or shutdown).
      return undefined;
    }
  }
}
