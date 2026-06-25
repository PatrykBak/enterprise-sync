import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ValidationError } from 'class-validator';

type ExceptionResponse = {
  message: string | string[];
  error?: string;
  statusCode?: number;
};

type ValidationErrorResponse = {
  statusCode: number;
  message: string[];
  error: string;
};

function isExceptionResponse(obj: unknown): obj is ExceptionResponse {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return false;
  }
  const record = obj as Record<string, unknown>;
  const message = record['message'];
  return typeof message === 'string' || Array.isArray(message);
}

function isValidationErrorResponse(
  obj: unknown,
): obj is ValidationErrorResponse {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return false;
  }
  const record = obj as Record<string, unknown>;
  const message = record['message'];
  return (
    typeof record['error'] === 'string' &&
    typeof record['statusCode'] === 'number' &&
    Array.isArray(message) &&
    message.every((item) => typeof item === 'string')
  );
}

function formatValidationErrors(errors: ValidationError[]): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    if (error.constraints) {
      messages.push(...Object.values(error.constraints));
    }
    if (error.children && error.children.length > 0) {
      messages.push(...formatValidationErrors(error.children));
    }
  }
  return messages;
}

function extractErrorMessage(
  exceptionResponse: ExceptionResponse | ValidationErrorResponse,
): string[] {
  if (isValidationErrorResponse(exceptionResponse)) {
    return exceptionResponse.message;
  }

  if (isExceptionResponse(exceptionResponse)) {
    const message = exceptionResponse.message;
    return Array.isArray(message) ? message : [message];
  }

  return ['An internal server error occurred'];
}

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId =
      typeof request.headers['x-correlation-id'] === 'string'
        ? request.headers['x-correlation-id']
        : 'not-provided';

    const tenantId =
      typeof request.headers['x-tenant-id'] === 'string'
        ? request.headers['x-tenant-id']
        : 'not-provided';

    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let errorMessage: string[] = ['An internal server error occurred'];

    if (
      exception instanceof BadRequestException &&
      Array.isArray(exceptionResponse)
    ) {
      const validationErrors =
        exceptionResponse as unknown as ValidationError[];
      errorMessage = formatValidationErrors(validationErrors);
    } else if (typeof exceptionResponse === 'string') {
      errorMessage = [exceptionResponse];
    } else if (isExceptionResponse(exceptionResponse)) {
      errorMessage = extractErrorMessage(exceptionResponse);
    }

    const logMessage = `[${correlationId}] HTTP Status: ${status} Error: ${JSON.stringify(
      errorMessage,
    )}`;

    if (status >= 500) {
      this.logger.error(logMessage, exception.stack);
    } else {
      this.logger.warn(logMessage);
    }

    const errorForResponse = Array.isArray(errorMessage)
      ? errorMessage.join(', ')
      : errorMessage;

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
