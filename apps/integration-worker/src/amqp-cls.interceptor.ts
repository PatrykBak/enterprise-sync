import { ClsService } from 'nestjs-cls';

export interface AmqpClsInterceptorOptions {
  clsService: ClsService<Record<string, unknown>>;
  correlationId: string;
}

/**
 * Helper function to run AMQP message processing within a CLS context.
 * This ensures that the correlation ID from the message headers is available
 * throughout the entire request processing pipeline.
 *
 * @param options - Configuration options including ClsService and correlationId
 * @param callback - The async callback function to execute within the CLS context
 * @returns Promise that resolves to the callback's return value
 */
export async function runWithCorrelationId<T>(
  options: AmqpClsInterceptorOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const { clsService, correlationId } = options;

  return clsService.runWith(
    {
      correlationId,
    },
    async () => {
      return callback();
    },
  );
}

/**
 * Extracts correlation ID from AMQP message headers
 * @param headers - AMQP message headers
 * @returns The correlation ID or undefined if not present
 */
export function extractCorrelationIdFromHeaders(
  headers: Record<string, unknown> | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const correlationId = headers['x-correlation-id'];

  if (typeof correlationId === 'string' && correlationId.trim().length > 0) {
    return correlationId.trim();
  }

  return undefined;
}
