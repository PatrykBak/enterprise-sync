import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(
    private readonly clsService: ClsService<Record<string, unknown>>,
  ) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId =
      this.clsService.get<string>('correlationId') ||
      (typeof request.headers['x-correlation-id'] === 'string'
        ? request.headers['x-correlation-id']
        : 'not-provided');

    const tenantId =
      typeof request.headers['x-tenant-id'] === 'string'
        ? request.headers['x-tenant-id']
        : 'not-provided';

    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let errorMessages: string | string[] = 'An internal server error occurred';

    if (typeof exceptionResponse === 'string') {
      errorMessages = exceptionResponse;
    } else if (
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'message' in exceptionResponse
    ) {
      const resMessage = (exceptionResponse as { message: unknown }).message;
      errorMessages = Array.isArray(resMessage)
        ? (resMessage as string[])
        : String(resMessage);
    }

    const logMessage = `[${correlationId}] HTTP Status: ${status} Error: ${JSON.stringify(
      errorMessages,
    )}`;

    if (status >= 500) {
      this.logger.error(logMessage, exception.stack);
    } else {
      this.logger.warn(logMessage);
    }

    const errorForResponse = Array.isArray(errorMessages)
      ? errorMessages.join(', ')
      : errorMessages;

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: errorForResponse,
      correlationId,
      tenantId,
    });
  }
}
