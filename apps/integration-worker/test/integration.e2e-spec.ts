/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { DatabaseModule } from '../src/database/database.module';
import { RabbitMQModule } from '../src/rabbitmq/rabbitmq.module';
import { HealthModule } from '../src/health/health.module';
import { RedisModule } from '../src/redis/redis.module';
import { S3ReaderService } from '../src/s3/s3-reader.service';
import { TransactionProcessorService } from '../src/processor/transaction-processor.service';
import { PrismaClient, JobStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { connect, Channel, ChannelModel } from 'amqplib';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppLogger } from '@enterprise-sync/shared';

describe('IntegrationWorker E2E (Docker Compose)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let pgPool: pg.Pool;
  let s3Client: S3Client;
  let rabbitChannel: Channel;
  let rabbitConnection: ChannelModel;
  let redisClient: Redis;

  const TEST_TENANT_ID = 'test-tenant-001';
  const TEST_FILE_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'; // Poprawny UUID
  const TEST_CORRELATION_ID = 'corr-e2e-001';
  const TEST_EXPECTED_HASH =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const TEST_BUCKET = 'transactions-bucket';
  const TEST_OBJECT_KEY = `transactions/${TEST_FILE_ID}/test-data.ndjson`;

  beforeAll(async () => {
    process.env.DATABASE_URL =
      'postgresql://admin:password@localhost:5432/enterprise_db';
    process.env.RABBITMQ_URL = 'amqp://localhost:5672';
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.REDIS_PASSWORD = '';
    process.env.REDIS_DB = '0';
    process.env.S3_ENDPOINT_URL = 'http://localhost:9000';
    process.env.S3_REGION = 'us-east-1';
    process.env.MINIO_ROOT_USER = 'admin';
    process.env.MINIO_ROOT_PASSWORD = 'password';
    process.env.S3_BUCKET_NAME = TEST_BUCKET;

    s3Client = new S3Client({
      region: 'us-east-1',
      endpoint: process.env.S3_ENDPOINT_URL,
      credentials: {
        accessKeyId: 'admin',
        secretAccessKey: 'password',
      },
      forcePathStyle: true,
    });

    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
    } catch {
      // Bucket może już istnieć
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
        }),
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true, generateId: true },
        }),
        DatabaseModule,
        RabbitMQModule,
        HealthModule,
        RedisModule,
      ],
      controllers: [],
      providers: [AppLogger, S3ReaderService, TransactionProcessorService],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();

    pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pgPool);
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    rabbitConnection = (await connect(process.env.RABBITMQ_URL, {
      heartbeat: 30,
      timeout: 10000,
    })) as unknown as ChannelModel;
    rabbitChannel = await rabbitConnection.createConfirmChannel();

    redisClient = new Redis({
      host: 'localhost',
      port: 6379,
    });
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (prisma) {
      await prisma.$disconnect();
    }
    if (pgPool) {
      await pgPool.end();
    }
    if (rabbitChannel) {
      await rabbitChannel.close();
    }
    if (rabbitConnection) {
      await rabbitConnection.close();
    }
    if (redisClient) {
      await redisClient.quit();
    }
    if (s3Client) {
      s3Client.destroy();
    }
  }, 30_000);

  beforeEach(async () => {
    await prisma.transactionLog.deleteMany();
    await prisma.integrationJob.deleteMany();
    await redisClient.flushdb();
  });

  describe('Active Polling & PII Masking', () => {
    it('should process NDJSON file from MinIO and mask PII in senderAccount', async () => {
      const testTransactions = [
        {
          transactionId: 'txn-001',
          amount: '1500.50',
          currency: 'PLN',
          senderName: 'John Doe',
          receiverName: 'Jane Smith',
          senderAccount: 'PL12345678901234567890123456',
          receiverAccount: 'PL98765432109876543210987654',
          timestamp: '2026-06-26T10:00:00.000Z',
        },
        {
          transactionId: 'txn-002',
          amount: '2500.75',
          currency: 'EUR',
          senderName: 'Alice Brown',
          receiverName: 'Bob White',
          senderAccount: 'DE89370400440532013000',
          receiverAccount: 'FR7630006000011234567890123',
          timestamp: '2026-06-26T10:05:00.000Z',
        },
        {
          transactionId: 'txn-003',
          amount: '500.00',
          currency: 'USD',
          senderName: 'Charlie Day',
          receiverName: 'Diana Prince',
          senderAccount: 'US12345678901234567890',
          receiverAccount: 'GB29NWBK60161331926819',
          timestamp: '2026-06-26T10:10:00.000Z',
        },
        {
          transactionId: 'txn-004',
          amount: '750.25',
          currency: 'GBP',
          senderName: 'Edward Lee',
          receiverName: 'Fiona Gallagher',
          senderAccount: 'GB12BARC20658244971655',
          receiverAccount: 'IE29AIBK93115212345678',
          timestamp: '2026-06-26T10:15:00.000Z',
        },
        {
          transactionId: 'txn-005',
          amount: '300.00',
          currency: 'CHF',
          senderName: 'George Martin',
          receiverName: 'Hannah Baker',
          senderAccount: 'CH93007620116238529576',
          receiverAccount: 'AT611904300234573201',
          timestamp: '2026-06-26T10:20:00.000Z',
        },
      ];

      const ndjsonContent = testTransactions
        .map((tx) => JSON.stringify(tx))
        .join('\n');

      await s3Client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: TEST_OBJECT_KEY,
          Body: ndjsonContent,
          ContentType: 'application/x-ndjson',
        }),
      );

      await prisma.integrationJob.create({
        data: {
          id: TEST_FILE_ID,
          fileId: TEST_FILE_ID,
          status: JobStatus.PENDING,
        },
      });

      const payload = {
        fileId: TEST_FILE_ID,
        objectKey: TEST_OBJECT_KEY,
        bucket: TEST_BUCKET,
        expectedHash: TEST_EXPECTED_HASH,
        correlationId: TEST_CORRELATION_ID,
        tenantId: TEST_TENANT_ID,
      };

      rabbitChannel.publish(
        'integration.events',
        'transaction.file.uploaded',
        Buffer.from(JSON.stringify(payload), 'utf-8'),
        {
          headers: { 'x-correlation-id': TEST_CORRELATION_ID },
          persistent: true,
        },
      );

      const startTime = Date.now();
      const timeoutMs = 15_000;
      let jobStatus: JobStatus | null = null;

      while (Date.now() - startTime < timeoutMs) {
        const job = await prisma.integrationJob.findFirst({
          where: { fileId: TEST_FILE_ID },
        });

        if (job && job.status === JobStatus.COMPLETED) {
          jobStatus = job.status;
          break;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
      }

      expect(jobStatus).toBe(JobStatus.COMPLETED);

      const transactionLogs = await prisma.transactionLog.findMany({
        where: { jobId: TEST_FILE_ID },
        orderBy: { transactionId: 'asc' },
      });

      expect(transactionLogs).toHaveLength(5);

      const expectedMaskedAccounts = [
        'PL******3456',
        'DE******3000',
        'US******7890',
        'GB******1655',
        'CH******9576',
      ];

      transactionLogs.forEach((log, index) => {
        expect(log.senderAccount).toBe(expectedMaskedAccounts[index]);
        expect(log.transactionId).toBe(`txn-00${index + 1}`);
      });

      transactionLogs.forEach((log) => {
        expect(log.receiverAccount).toMatch(/^[A-Z]{2}\*{6}\d{4}$/);
      });
    }, 20_000);
  });

  describe('Health Check (Docker Compose)', () => {
    it('should return readiness status ok when all dependencies are connected', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      const response = await request(server)
        .get('/health/readiness')
        .expect(200);

      const body = response.body as {
        status: string;
        details: {
          rabbitmq: boolean;
          database: boolean;
        };
      };
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('details');
      expect(body.details).toHaveProperty('rabbitmq', true);
      expect(body.details).toHaveProperty('database', true);
    });

    it('should return liveness status ok', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      const response = await request(server)
        .get('/health/liveness')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });
  });
});
