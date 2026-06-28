import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  GetObjectCommandInput,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import * as readline from 'readline';

export interface S3ReadResult {
  lines: AsyncIterable<string>;
  stream: Readable;
}

@Injectable()
export class S3ReaderService implements OnModuleInit {
  private s3Client!: S3Client;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.s3Client = new S3Client({
      region: this.configService.getOrThrow<string>('S3_REGION'),
      endpoint: this.configService.getOrThrow<string>('S3_ENDPOINT_URL'),
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('MINIO_ROOT_USER'),
        secretAccessKey: this.configService.getOrThrow<string>(
          'MINIO_ROOT_PASSWORD',
        ),
      },
      forcePathStyle: true,
    });
  }

  async *readLines(bucket: string, key: string): AsyncIterable<string> {
    const input: GetObjectCommandInput = {
      Bucket: bucket,
      Key: key,
    };

    const command = new GetObjectCommand(input);
    const response = await this.s3Client.send(command);

    const body = response.Body;

    if (!(body instanceof Readable)) {
      throw new Error('Expected response body to be a Readable stream');
    }

    const rl = readline.createInterface({
      input: body,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (line.trim().length === 0) {
          continue;
        }
        yield line;
      }
    } finally {
      body.destroy();
    }
  }

  async getStream(
    bucket: string,
    key: string,
  ): Promise<{ lines: AsyncIterable<string>; stream: Readable }> {
    const input: GetObjectCommandInput = {
      Bucket: bucket,
      Key: key,
    };

    const command = new GetObjectCommand(input);
    const response = await this.s3Client.send(command);

    const body = response.Body;

    if (!(body instanceof Readable)) {
      throw new Error('Expected response body to be a Readable stream');
    }

    const rl = readline.createInterface({
      input: body,
      crlfDelay: Infinity,
    });

    return {
      lines: (async function* () {
        try {
          for await (const line of rl) {
            if (line.trim().length === 0) {
              continue;
            }
            yield line;
          }
        } finally {
          body.destroy();
        }
      })(),
      stream: body,
    };
  }

  async getFileStream(bucket: string, key: string): Promise<Readable> {
    const input: GetObjectCommandInput = {
      Bucket: bucket,
      Key: key,
    };

    const command = new GetObjectCommand(input);
    const response = await this.s3Client.send(command);

    const body = response.Body;

    if (!(body instanceof Readable)) {
      throw new Error('Expected response body to be a Readable stream');
    }

    return body;
  }
}
