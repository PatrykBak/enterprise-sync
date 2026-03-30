import {
  Controller,
  Post,
  UseInterceptors,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiConsumes } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Streams file to S3' })
  @ApiConsumes('multipart/form-data')
  @UseGuards(ZeroTrustAuthGuard)
  @UseInterceptors(FastStreamToS3Interceptor)
  syncTransactions(@UploadedS3File() uploadedFile?: S3UploadResult) {
    if (!uploadedFile) {
      throw new BadRequestException('File was not uploaded.');
    }

    return uploadedFile;
  }
}
