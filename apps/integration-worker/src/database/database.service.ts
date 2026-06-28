import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import pg from 'pg';

@Injectable()
export class DatabaseService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private pool: Pool;

  constructor(private readonly configService: ConfigService) {
    const connectionString = configService.get<string>('DATABASE_URL');

    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    const pool = new pg.Pool({ connectionString });
    const adapter = new PrismaPg(pool);

    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }

  async saveTransactionsBatch(
    transactions: Prisma.TransactionLogCreateManyInput[],
  ): Promise<void> {
    await this.transactionLog.createMany({
      data: transactions,
      skipDuplicates: true,
    });
  }

  async updateJobStatus(
    jobId: string,
    fileId: string,
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED',
  ): Promise<void> {
    await this.integrationJob.upsert({
      where: { id: jobId },
      update: { status },
      create: { id: jobId, fileId, status },
    });
  }
}
