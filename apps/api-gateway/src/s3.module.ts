import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';

export const S3_CLIENT_TOKEN = Symbol('S3_CLIENT');

@Module({
  providers: [
    {
      provide: S3_CLIENT_TOKEN,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): S3Client => {
        const accessKeyId =
          configService.get<string>('AWS_ACCESS_KEY_ID') ??
          configService.getOrThrow<string>('MINIO_ROOT_USER');
        const secretAccessKey =
          configService.get<string>('AWS_SECRET_ACCESS_KEY') ??
          configService.getOrThrow<string>('MINIO_ROOT_PASSWORD');

        return new S3Client({
          region: configService.getOrThrow<string>('S3_REGION'),
          endpoint: configService.getOrThrow<string>('S3_ENDPOINT_URL'),
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
          forcePathStyle: true,
        });
      },
    },
  ],
  exports: [S3_CLIENT_TOKEN],
})
export class S3Module implements OnModuleDestroy {
  constructor(@Inject(S3_CLIENT_TOKEN) private readonly s3Client: S3Client) {}

  onModuleDestroy(): void {
    this.s3Client.destroy();
  }
}
