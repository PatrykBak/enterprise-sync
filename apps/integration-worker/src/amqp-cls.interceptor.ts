import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'crypto';

export interface AmqpClsInterceptorOptions {
  clsService: ClsService<Record<string, unknown>>;
  correlationId?: string;
}

export async function runWithCorrelationId<T>(
  options: AmqpClsInterceptorOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const { clsService, correlationId } = options;
  const resolvedCorrelationId =
    correlationId && correlationId.trim().length > 0
      ? correlationId.trim()
      : randomUUID();

  return clsService.runWith(
    {
      correlationId: resolvedCorrelationId,
    },
    callback,
  );
}

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

  if (Buffer.isBuffer(correlationId)) {
    const decoded = correlationId.toString('utf-8').trim();
    return decoded.length > 0 ? decoded : undefined;
  }

  return undefined;
}
