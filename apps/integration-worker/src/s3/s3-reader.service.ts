import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  GetObjectCommandInput,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import * as readline from 'readline';
import { AppLogger } from '@enterprise-sync/shared';

export interface S3ReadResult {
  lines: AsyncIterable<string>;
  stream: Readable;
}

@Injectable()
export class S3ReaderService implements OnModuleInit, OnModuleDestroy {
  private s3Client!: S3Client;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly logger: AppLogger = new AppLogger(
      undefined,
      S3ReaderService.name,
    ),
  ) {}

  onModuleInit(): void {
    const accessKeyId =
      this.configService.get<string>('AWS_ACCESS_KEY_ID') ??
      this.configService.getOrThrow<string>('MINIO_ROOT_USER');
    const secretAccessKey =
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ??
      this.configService.getOrThrow<string>('MINIO_ROOT_PASSWORD');

    this.s3Client = new S3Client({
      region: this.configService.getOrThrow<string>('S3_REGION'),
      endpoint: this.configService.getOrThrow<string>('S3_ENDPOINT_URL'),
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

    this.logger.log('S3ReaderService client initialized successfully');
  }

  onModuleDestroy(): void {
    try {
      this.s3Client?.destroy();
      this.logger.log('S3ReaderService client destroyed cleanly');
    } catch (err: unknown) {
      this.logger.error(
        'Error destroying S3Client on shutdown:',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async getStream(bucket: string, key: string): Promise<S3ReadResult> {
    const input: GetObjectCommandInput = {
      Bucket: bucket,
      Key: key,
    };

    const command = new GetObjectCommand(input);
    const response = await this.s3Client.send(command);

    const body = response.Body;

    if (!(body instanceof Readable)) {
      throw new Error('Expected S3 response body to be a Readable stream');
    }

    const rl = readline.createInterface({
      input: body,
      crlfDelay: Infinity,
    });

    return {
      lines: (async function* () {
        try {
          for await (const line of rl) {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
              continue;
            }
            yield trimmed;
          }
        } finally {
          rl.close();
          body.destroy();
        }
      })(),
      stream: body,
    };
  }
}
