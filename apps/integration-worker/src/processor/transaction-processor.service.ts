import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '@enterprise-sync/shared';
import { DatabaseService } from '../database/database.service';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

export const RawTransactionSchema = z.object({
  transactionId: z.string().min(1),
  amount: z
    .union([z.string().trim(), z.number()])
    .transform((val) => (typeof val === 'number' ? val.toFixed(2) : val))
    .pipe(
      z
        .string()
        .regex(
          /^\d+(\.\d{1,2})?$/,
          'Amount must be a positive decimal with up to 2 decimal places',
        )
        .refine((val) => parseFloat(val) > 0, {
          message: 'Amount must be greater than zero',
        }),
    ),
  currency: z.string().min(1),
  senderName: z.string().optional().default(''),
  receiverName: z.string().optional().default(''),
  senderAccount: z.string().min(1),
  receiverAccount: z.string().min(1),
  timestamp: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'Invalid ISO timestamp string',
  }),
});

export type RawTransaction = z.infer<typeof RawTransactionSchema>;

@Injectable()
export class TransactionProcessorService {
  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly appLogger: AppLogger,
  ) {}

  async processFileWithStream(
    jobId: string,
    lines: AsyncIterable<string>,
  ): Promise<void> {
    const batchSize = Math.max(
      1,
      parseInt(this.configService.get<string>('BATCH_SIZE') ?? '1000', 10) ||
        1000,
    );
    const buffer: Prisma.TransactionLogCreateManyInput[] = [];
    let lineNumber = 0;

    for await (const line of lines) {
      lineNumber += 1;
      let parsed: unknown;

      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.appLogger.warn(
          `Skipping invalid NDJSON record at line ${lineNumber}: malformed JSON or schema mismatch`,
          'TransactionProcessorService',
        );
        continue;
      }

      const validationResult = RawTransactionSchema.safeParse(parsed);
      if (!validationResult.success) {
        this.appLogger.warn(
          `Skipping invalid NDJSON record at line ${lineNumber}: malformed JSON or schema mismatch`,
          'TransactionProcessorService',
        );
        continue;
      }

      const masked = this.maskPii(validationResult.data, jobId);
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
  ): Prisma.TransactionLogCreateManyInput {
    return {
      jobId,
      transactionId: raw.transactionId,
      amount: new Prisma.Decimal(raw.amount),
      currency: raw.currency,
      senderAccount: this.maskAccount(raw.senderAccount),
      receiverAccount: this.maskAccount(raw.receiverAccount),
      timestamp: new Date(raw.timestamp),
    };
  }

  private maskAccount(account: string): string {
    if (account.length <= 6) {
      return '*'.repeat(account.length);
    }

    const start = account.substring(0, 2);
    const end = account.substring(account.length - 4);
    return `${start}******${end}`;
  }
}
