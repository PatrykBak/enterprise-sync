import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('API Gateway (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'super-secret-jwt-key-dev';
    process.env.DEV_SECRET_TOKEN = 'dev-secret-token';
    process.env.EXPECTED_CLIENT_ID = 'client-test';
    process.env.S3_BUCKET_NAME = 'transactions-bucket';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Health Probes', () => {
    it('/health/liveness (GET) should return 200 OK', () => {
      return request(app.getHttpServer())
        .get('/health/liveness')
        .expect(200)
        .expect({ status: 'ok' });
    });
  });

  describe('Authentication Flow', () => {
    it('/auth/login (POST) should reject invalid client secret with 401 Unauthorized', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          clientId: 'client-test',
          clientSecret: 'invalid-secret',
        })
        .expect(401);
    });

    it('/auth/login (POST) should issue JWT token for valid credentials', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          clientId: 'client-test',
          clientSecret: 'dev-secret-token',
        })
        .expect(200);

      const body = response.body as { accessToken: unknown };

      expect(body).toHaveProperty('accessToken');
      expect(typeof body.accessToken).toBe('string');

      const accessToken = body.accessToken as string;

      await request(app.getHttpServer())
        .post('/api/sync-transactions')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });
  });

  describe('Secured API Endpoints', () => {
    it('/api/sync-transactions (POST) should reject unauthenticated requests with 401', () => {
      return request(app.getHttpServer())
        .post('/api/sync-transactions')
        .expect(401);
    });
  });
});
