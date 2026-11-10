import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppLogger } from '@enterprise-sync/shared';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly clsService: ClsService,
    @Optional()
    private readonly logger: AppLogger = new AppLogger(
      clsService,
      HttpExceptionFilter.name,
    ),
  ) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (response.headersSent) {
      return;
    }

    let correlationId: string | undefined;
    try {
      correlationId = this.clsService.get<string>('correlationId');
    } catch {
      correlationId = undefined;
    }

    if (!correlationId) {
      const headerCorrelation = request.headers['x-correlation-id'];
      correlationId = Array.isArray(headerCorrelation)
        ? headerCorrelation[0]
        : (headerCorrelation ?? 'not-provided');
    }

    const headerTenant = request.headers['x-tenant-id'];
    const tenantId = Array.isArray(headerTenant)
      ? headerTenant[0]
      : (headerTenant ?? 'not-provided');

    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let errorMessages: string | string[] = 'An internal server error occurred';

    if (typeof exceptionResponse === 'string') {
      errorMessages = exceptionResponse;
    } else if (
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null
    ) {
      if ('message' in exceptionResponse) {
        const resMessage = (exceptionResponse as { message: unknown }).message;
        errorMessages = Array.isArray(resMessage)
          ? (resMessage as string[])
          : String(resMessage);
      } else if ('error' in exceptionResponse) {
        errorMessages = String((exceptionResponse as { error: unknown }).error);
      } else {
        errorMessages = JSON.stringify(exceptionResponse);
      }
    }

    const logMessage = `HTTP Status: ${status} [${request.method} ${request.url}] - Error: ${JSON.stringify(errorMessages)}`;

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
