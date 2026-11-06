import {
  Controller,
  Post,
  UseInterceptors,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Headers,
  Logger,
} from '@nestjs/common';
import { AppService } from './app.service';
import { FastStreamToS3Interceptor } from './interceptors/fast-stream-s3.interceptor';
import { UploadedS3File } from './uploaded-s3-file.decorator';
import type { S3UploadResult } from './s3-upload-result.interface';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { Roles } from './auth/roles.decorator';
import { ClsService } from 'nestjs-cls';

@Controller('api')
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly appService: AppService,
    private readonly clsService: ClsService<Record<string, unknown>>,
  ) {}

  @Post('sync-transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @UseInterceptors(FastStreamToS3Interceptor)
  async syncTransactions(
    @UploadedS3File() uploadedFile: S3UploadResult,
    @Headers('x-expected-hash') expectedHash: string | undefined,
    @Headers('x-tenant-id') tenantId: string,
  ): Promise<{ status: 'accepted'; correlationId: string }> {
    if (!uploadedFile) {
      throw new BadRequestException({
        message: 'File was not uploaded',
        correlationId: 'unknown',
      });
    }

    if (!expectedHash) {
      const currentCorrelationId =
        this.clsService.get<string>('correlationId') ?? 'unknown';
      throw new BadRequestException({
        message: 'Missing required headers',
        missing: ['x-expected-hash'],
        correlationId: currentCorrelationId,
      });
    }

    const correlationId = this.clsService.get<string>('correlationId') ?? '';

    await this.appService.processSyncTransaction(
      uploadedFile,
      expectedHash,
      correlationId,
      tenantId,
    );

    return {
      status: 'accepted',
      correlationId,
    };
  }
}
