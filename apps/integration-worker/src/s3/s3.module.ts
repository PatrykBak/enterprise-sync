import { Module } from '@nestjs/common';
import { S3ReaderService } from './s3-reader.service';

@Module({
  providers: [S3ReaderService],
  exports: [S3ReaderService],
})
export class S3Module {}
