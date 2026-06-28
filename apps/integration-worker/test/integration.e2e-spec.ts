/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { DatabaseModule } from '../src/database/database.module';
import { RabbitMQModule } from '../src/rabbitmq/rabbitmq.module';
import { HealthModule } from '../src/health/health.module';
import { RedisModule } from '../src/redis/redis.module';
import { S3ReaderService } from '../src/s3/s3-reader.service';
import { TransactionProcessorService } from '../src/processor/transaction-processor.service';
import { PrismaClient, JobStatus } from '@prisma/client';
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { connect, Channel, ChannelModel } from 'amqplib';
import { Redis } from 'ioredis';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';
import { Wait, StartedTestContainer } from 'testcontainers';
import { MinioContainer } from '@testcontainers/minio';
import request from 'supertest';

describe('IntegrationWorker E2E (Testcontainers)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let s3Client: S3Client;
  let rabbitChannel: Channel;
  let rabbitConnection: ChannelModel;
  let redisClient: Redis;

  let pgContainer: StartedTestContainer;
  let rabbitContainer: StartedTestContainer;
  let redisContainer: StartedTestContainer;
  let minioContainer: StartedTestContainer;

  let pgHost: string;
  let pgPort: number;
  let pgDatabase: string;
  let pgUser: string;
  let pgPassword: string;

  const TEST_TENANT_ID = 'test-tenant-001';
  const TEST_FILE_ID = 'test-file-e2e-001';
  const TEST_CORRELATION_ID = 'corr-e2e-001';
  const TEST_EXPECTED_HASH =
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  beforeAll(async () => {
    // 1. Start Testcontainers
    const pg = new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('enterprise_db')
      .withUsername('admin')
      .withPassword('password');
    const startedPg = await pg.start();
    pgContainer = startedPg;
    pgHost = startedPg.getHost();
    pgPort = startedPg.getMappedPort(5432);
    pgDatabase = 'enterprise_db';
    pgUser = 'admin';
    pgPassword = 'password';

    const rabbit = new RabbitMQContainer('rabbitmq:3-management');
    const startedRabbit = await rabbit.start();
    rabbitContainer = startedRabbit;

    const redis = new RedisContainer('redis:7-alpine');
    const startedRedis = await redis.start();
    redisContainer = startedRedis;

    const minio = new MinioContainer('minio/minio:latest')
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000));

    const startedMinioResult = await minio.start();
    minioContainer = startedMinioResult;
    const startedMinio = startedMinioResult as StartedTestContainer;

    // 2. Override process.env with dynamic container ports
    process.env.DATABASE_URL = `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDatabase}`;
    process.env.RABBITMQ_URL = `amqp://${startedRabbit.getHost()}:${startedRabbit.getMappedPort(5672)}`;
    process.env.REDIS_HOST = startedRedis.getHost();
    process.env.REDIS_PORT = startedRedis.getMappedPort(6379).toString();
    process.env.REDIS_PASSWORD = '';
    process.env.REDIS_DB = '0';
    process.env.S3_ENDPOINT_URL = `http://${startedMinio.getHost()}:${startedMinio.getMappedPort(9000)}`;
    process.env.S3_REGION = 'us-east-1';
    process.env.MINIO_ROOT_USER = 'minioadmin';
    process.env.MINIO_ROOT_PASSWORD = 'minioadmin';
    process.env.S3_BUCKET = 'transactions';

    // 3. Initialize MinIO bucket
    s3Client = new S3Client({
      region: 'us-east-1',
      endpoint: process.env.S3_ENDPOINT_URL,
      credentials: {
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
      },
      forcePathStyle: true,
    });

    await s3Client.send(new CreateBucketCommand({ Bucket: 'transactions' }));

    // 4. Start NestJS application
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
        RedisModule.registerAsync({
          imports: [ConfigModule],
          useFactory: (...args: unknown[]) => {
            const configService = args[0] as ConfigService;
            return {
              host: configService.get<string>('REDIS_HOST', 'localhost'),
              port: configService.get<number>('REDIS_PORT', 6379),
              password: configService.get<string>('REDIS_PASSWORD'),
              db: configService.get<number>('REDIS_DB', 0),
              retryMaxAttempts: 10,
              retryMaxDelay: 3000,
            };
          },
          inject: [ConfigService],
        }),
      ],
      controllers: [],
      providers: [S3ReaderService, TransactionProcessorService],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();

    // 5. Connect Prisma
    prisma = new PrismaClient();
    await prisma.$connect();

    // 6. Setup RabbitMQ channel for publishing test messages
    rabbitConnection = (await connect(process.env.RABBITMQ_URL, {
      heartbeat: 30,
      timeout: 10000,
    })) as unknown as ChannelModel;
    rabbitChannel = await rabbitConnection.createConfirmChannel();

    await rabbitChannel.assertExchange('integration.events', 'topic', {
      durable: true,
    });
    await rabbitChannel.assertExchange('integration.dlx', 'topic', {
      durable: true,
    });
    await rabbitChannel.assertQueue('tx-sync-jobs', {
      durable: true,
      arguments: { 'x-dead-letter-exchange': 'integration.dlx' },
    });
    await rabbitChannel.bindQueue(
      'tx-sync-jobs',
      'integration.events',
      'transaction.file.uploaded',
    );
    await rabbitChannel.prefetch(1, false);

    // 7. Connect Redis for cleanup/verification
    redisClient = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    });
  }, 120_000);

  afterAll(async () => {
    // 1. Close NestJS app
    if (app) {
      await app.close();
    }

    // 2. Close Prisma
    if (prisma) {
      await prisma.$disconnect();
    }

    // 3. Close RabbitMQ
    if (rabbitChannel) {
      await rabbitChannel.close();
    }
    if (rabbitConnection) {
      await rabbitConnection.close();
    }

    // 4. Close Redis
    if (redisClient) {
      await redisClient.quit();
    }

    // 5. Close S3 client
    if (s3Client) {
      s3Client.destroy();
    }

    // 6. Stop containers
    if (pgContainer) await pgContainer.stop();
    if (rabbitContainer) await rabbitContainer.stop();
    if (redisContainer) await redisContainer.stop();
    if (minioContainer) await minioContainer.stop();
  }, 30_000);

  beforeEach(async () => {
    // Clean up database before each test
    await prisma.transactionLog.deleteMany();
    await prisma.integrationJob.deleteMany();
    await redisClient.flushdb();
  });

  describe('Active Polling & PII Masking', () => {
    it('should process NDJSON file from MinIO and mask PII in senderAccount', async () => {
      // 1. Prepare test NDJSON payload (5 lines)
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

      // 2. Upload NDJSON to MinIO
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'transactions',
          Key: `uploads/${TEST_TENANT_ID}/${TEST_FILE_ID}.jsonl`,
          Body: ndjsonContent,
          ContentType: 'application/x-ndjson',
        }),
      );

      // 3. Pre-create IntegrationJob with PENDING status
      await prisma.integrationJob.create({
        data: {
          id: TEST_FILE_ID,
          fileId: TEST_FILE_ID,
          status: JobStatus.PENDING,
        },
      });

      // 4. Publish message to RabbitMQ to trigger processing
      const payload = {
        fileId: TEST_FILE_ID,
        expectedHash: TEST_EXPECTED_HASH,
        correlationId: TEST_CORRELATION_ID,
        tenantId: TEST_TENANT_ID,
      };

      rabbitChannel.publish(
        'integration.events',
        'transaction.file.uploaded',
        Buffer.from(JSON.stringify(payload), 'utf-8'),
        {
          correlationId: TEST_CORRELATION_ID,
          persistent: true,
        },
      );

      // 5. Active Polling: poll database until job status is COMPLETED (max 10 seconds)
      const startTime = Date.now();
      const timeoutMs = 10_000;
      let jobStatus: JobStatus | null = null;

      while (Date.now() - startTime < timeoutMs) {
        const job = await prisma.integrationJob.findFirst({
          where: { fileId: TEST_FILE_ID },
        });

        if (job && job.status === JobStatus.COMPLETED) {
          jobStatus = job.status;
          break;
        }

        // Wait 200ms before next poll
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
      }

      // 6. Assert: Job status must be COMPLETED
      expect(jobStatus).toBe(JobStatus.COMPLETED);

      // 7. Assert: TransactionLogs exist and PII is masked
      const transactionLogs = await prisma.transactionLog.findMany({
        where: { jobId: TEST_FILE_ID },
        orderBy: { transactionId: 'asc' },
      });

      expect(transactionLogs).toHaveLength(5);

      // Verify PII masking for senderAccount
      // Format: first 2 chars + "******" + last 4 chars
      const expectedMaskedAccounts = [
        'PL******3456', // PL12345678901234567890123456
        'DE******3000', // DE89370400440532013000
        'US******7890', // US12345678901234567890
        'GB******1655', // GB12BARC20658244971655
        'CH******9576', // CH93007620116238529576
      ];

      transactionLogs.forEach((log, index) => {
        expect(log.senderAccount).toBe(expectedMaskedAccounts[index]);
        expect(log.transactionId).toBe(`txn-00${index + 1}`);
      });

      // 8. Verify receiverAccount is also masked
      transactionLogs.forEach((log) => {
        expect(log.receiverAccount).toMatch(/^[A-Z]{2}\*{6}\d{4}$/);
      });
    }, 15_000);
  });

  describe('Health Check (Testcontainers)', () => {
    interface ReadinessResponse {
      status: string;
      details?: {
        rabbitmq: boolean;
        database: boolean;
      };
    }

    interface LivenessResponse {
      status: string;
      timestamp: string;
    }

    it('should return readiness status ok when all dependencies are connected', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      const response = await request(server)
        .get('/health/readiness')
        .expect(200);

      const body = response.body as ReadinessResponse;
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

      const body = response.body as LivenessResponse;
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('timestamp');
    });
  });
});
