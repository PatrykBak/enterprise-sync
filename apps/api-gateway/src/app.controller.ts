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
  constructor(
    private readonly appService: AppService,
    private readonly clsService: ClsService,
  ) {}

  @Post('sync-transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @UseInterceptors(FastStreamToS3Interceptor)
  async syncTransactions(
    @UploadedS3File() uploadedFile: S3UploadResult,
    @Headers('x-expected-hash') expectedHash: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
  ): Promise<{ status: 'accepted'; correlationId: string }> {
    if (!uploadedFile) {
      throw new BadRequestException('File was not uploaded');
    }

    if (!expectedHash) {
      throw new BadRequestException('Missing required header: X-Expected-Hash');
    }

    if (!tenantId) {
      throw new BadRequestException('Missing required header: X-Tenant-ID');
    }

    const correlationId =
      this.clsService.get<string>('correlationId') ?? 'not-provided';

    await this.appService.processSyncTransaction(
      uploadedFile,
      uploadedFile.sha256,
      correlationId,
      tenantId,
    );

    return {
      status: 'accepted',
      correlationId,
    };
  }
}
