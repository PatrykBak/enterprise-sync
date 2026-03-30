import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { S3UploadResult } from './s3-upload-result.interface';

export const UploadedS3File = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): S3UploadResult | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ uploadedFile?: S3UploadResult }>();

    return request.uploadedFile;
  },
);
