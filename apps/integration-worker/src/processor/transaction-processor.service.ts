import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { AppLogger } from '../app.logger';
import { DatabaseService } from '../database/database.service';
import { S3ReaderService } from '../s3/s3-reader.service';
import { Prisma } from '@prisma/client';

interface RawTransaction {
  transactionId: string;
  amount: string | number;
  currency: string;
  senderName: string;
  receiverName: string;
  senderAccount: string;
  receiverAccount: string;
  timestamp: string;
}

interface MaskedTransaction {
  jobId: string;
  fileId: string;
  transactionId: string;
  amount: Prisma.Decimal | string | number;
  currency: string;
  senderName: string;
  receiverName: string;
  senderAccount: string;
  receiverAccount: string;
  timestamp: Date;
}

@Injectable()
export class TransactionProcessorService {
  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly s3ReaderService: S3ReaderService,
    private readonly appLogger: AppLogger,
    private readonly clsService: ClsService<Record<string, unknown>>,
  ) {}

  async processFile(
    jobId: string,
    fileId: string,
    bucket: string,
    key: string,
  ): Promise<void> {
    const batchSize = this.configService.get<number>('BATCH_SIZE', 1000);
    const buffer: MaskedTransaction[] = [];

    for await (const line of this.s3ReaderService.readLines(bucket, key)) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.appLogger.warn(
          `Poison pill skipped: failed to parse line: ${line.substring(0, 100)}`,
          'TransactionProcessorService',
        );
        continue;
      }

      if (!this.isRawTransaction(parsed)) {
        this.appLogger.warn(
          `Poison pill skipped: invalid transaction structure: ${line.substring(0, 100)}`,
          'TransactionProcessorService',
        );
        continue;
      }

      const masked = this.maskPii(parsed, jobId, fileId);
      buffer.push(masked);

      if (buffer.length >= batchSize) {
        await this.databaseService.saveTransactionsBatch([...buffer]);
        buffer.length = 0;
      }
    }

    if (buffer.length > 0) {
      await this.databaseService.saveTransactionsBatch([...buffer]);
      buffer.length = 0;
    }
  }

  async processFileWithStream(
    jobId: string,
    fileId: string,
    bucket: string,
    key: string,
    lines: AsyncIterable<string>,
  ): Promise<void> {
    const batchSize = this.configService.get<number>('BATCH_SIZE', 1000);
    const buffer: MaskedTransaction[] = [];

    for await (const line of lines) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.appLogger.warn(
          `Poison pill skipped: failed to parse line: ${line.substring(0, 100)}`,
          'TransactionProcessorService',
        );
        continue;
      }

      if (!this.isRawTransaction(parsed)) {
        this.appLogger.warn(
          `Poison pill skipped: invalid transaction structure: ${line.substring(0, 100)}`,
          'TransactionProcessorService',
        );
        continue;
      }

      const masked = this.maskPii(parsed, jobId, fileId);
      buffer.push(masked);

      if (buffer.length >= batchSize) {
        await this.databaseService.saveTransactionsBatch([...buffer]);
        buffer.length = 0;
      }
    }

    if (buffer.length > 0) {
      await this.databaseService.saveTransactionsBatch([...buffer]);
      buffer.length = 0;
    }
  }

  private maskPii(
    raw: RawTransaction,
    jobId: string,
    fileId: string,
  ): MaskedTransaction {
    return {
      jobId,
      fileId,
      transactionId: raw.transactionId,
      amount: raw.amount,
      currency: raw.currency,
      senderName: this.maskName(raw.senderName),
      receiverName: this.maskName(raw.receiverName),
      senderAccount: this.maskAccount(raw.senderAccount),
      receiverAccount: this.maskAccount(raw.receiverAccount),
      timestamp: new Date(raw.timestamp),
    };
  }

  private maskName(name: string): string {
    const parts = name
      .trim()
      .split(' ')
      .filter((p) => p.length > 0);
    return parts
      .map((part) => {
        if (part.length <= 1) {
          return part;
        }
        return part.charAt(0) + '*'.repeat(part.length - 1);
      })
      .join(' ');
  }

  private maskAccount(account: string): string {
    if (account.length <= 6) {
      return account;
    }

    const start = account.substring(0, 2);
    const end = account.substring(account.length - 4);
    return `${start}******${end}`;
  }

  private isRawTransaction(value: unknown): value is RawTransaction {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const obj = value as Record<string, unknown>;

    return (
      typeof obj['transactionId'] === 'string' &&
      (typeof obj['amount'] === 'string' ||
        typeof obj['amount'] === 'number') &&
      typeof obj['currency'] === 'string' &&
      typeof obj['senderName'] === 'string' &&
      typeof obj['receiverName'] === 'string' &&
      typeof obj['senderAccount'] === 'string' &&
      typeof obj['receiverAccount'] === 'string' &&
      typeof obj['timestamp'] === 'string'
    );
  }
}
