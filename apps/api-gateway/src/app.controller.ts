import {
  Controller,
  Post,
  UseInterceptors,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import { ApiOperation, ApiConsumes, ApiHeader } from '@nestjs/swagger';
import { AppService } from './app.service';
import { FastStreamToS3Interceptor } from './interceptors/fast-stream-s3.interceptor';
import { UploadedS3File } from './uploaded-s3-file.decorator';
import type { S3UploadResult } from './s3-upload-result.interface';
import { ZeroTrustAuthGuard } from './zero-trust-auth.guard';

@Controller('api')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('sync-transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Streams file to S3 and queues for processing' })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'x-correlation-id',
    description: 'A unique ID to trace the request through the system.',
    required: true,
  })
  @ApiHeader({
    name: 'x-tenant-id',
    description: 'The identifier for the tenant initiating the sync.',
    required: true,
  })
  @ApiHeader({
    name: 'x-expected-hash',
    description: 'The SHA256 hash of the file for integrity verification.',
    required: true,
  })
  @UseGuards(ZeroTrustAuthGuard)
  @UseInterceptors(FastStreamToS3Interceptor)
  async syncTransactions(
    @UploadedS3File() uploadedFile: S3UploadResult,
    @Headers('x-expected-hash') expectedHash: string,
    @Headers('x-correlation-id') correlationId: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    if (!uploadedFile) {
      throw new BadRequestException('File was not uploaded.');
    }

    if (!correlationId || !tenantId || !expectedHash) {
      throw new BadRequestException(
        'Missing required headers: X-Correlation-ID, X-Tenant-ID, X-Expected-Hash',
      );
    }

    await this.appService.processSyncTransaction(
      uploadedFile,
      expectedHash,
      correlationId,
      tenantId,
    );

    return uploadedFile;
  }
}
