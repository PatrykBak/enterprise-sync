import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';

export const S3_CLIENT_TOKEN = Symbol('S3_CLIENT');

@Module({
  providers: [
    {
      provide: S3_CLIENT_TOKEN,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        return new S3Client({
          region: configService.getOrThrow<string>('S3_REGION'),
          endpoint: configService.getOrThrow<string>('S3_ENDPOINT_URL'),
          credentials: {
            accessKeyId: configService.getOrThrow<string>('MINIO_ROOT_USER'),
            secretAccessKey: configService.getOrThrow<string>(
              'MINIO_ROOT_PASSWORD',
            ),
          },
          forcePathStyle: true,
        });
      },
    },
  ],
  exports: [S3_CLIENT_TOKEN],
})
export class S3Module {}
