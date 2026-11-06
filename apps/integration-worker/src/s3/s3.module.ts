import { Module, Global } from '@nestjs/common';
import { S3ReaderService } from './s3-reader.service';

@Global()
@Module({
  providers: [S3ReaderService],
  exports: [S3ReaderService],
})
export class S3Module {}
