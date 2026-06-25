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
import { ZeroTrustAuthGuard } from './zero-trust-auth.guard';

@Controller('api')
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(private readonly appService: AppService) {}

  @Post('sync-transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ZeroTrustAuthGuard)
  @UseInterceptors(FastStreamToS3Interceptor)
  async syncTransactions(
    @UploadedS3File() uploadedFile: S3UploadResult,
    @Headers('x-expected-hash') expectedHash: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
  ): Promise<{ status: string; correlationId: string }> {
    if (!uploadedFile) {
      throw new BadRequestException({
        message: 'File was not uploaded',
        correlationId: 'unknown',
      });
    }

    if (!expectedHash || !correlationId || !tenantId) {
      throw new BadRequestException({
        message: 'Missing required headers',
        missing: [
          ...(!expectedHash ? ['x-expected-hash'] : []),
          ...(!correlationId ? ['x-correlation-id'] : []),
          ...(!tenantId ? ['x-tenant-id'] : []),
        ],
        correlationId: correlationId ?? 'unknown',
      });
    }

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
