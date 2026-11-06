/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClsService } from 'nestjs-cls';
import { ConfigService } from '@nestjs/config';
import { RabbitMQService } from './rabbitmq.service';
import { S3_CLIENT_TOKEN } from './s3.module';

describe('AppController', () => {
  let appController: AppController;
  let appService: AppService;

  beforeEach(async () => {
    const mockClsService = {
      get: jest.fn().mockReturnValue('test-correlation-id'),
    };

    const mockAppService = {
      processSyncTransaction: jest.fn().mockResolvedValue(undefined),
    };

    const mockS3Client = {
      send: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn().mockReturnValue('transactions-bucket'),
      getOrThrow: jest.fn().mockReturnValue('mock-val'),
    };

    const mockRabbitMQService = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: AppService, useValue: mockAppService },
        { provide: ClsService, useValue: mockClsService },
        { provide: S3_CLIENT_TOKEN, useValue: mockS3Client },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RabbitMQService, useValue: mockRabbitMQService },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
    appService = app.get<AppService>(AppService);
  });

  it('should be defined', () => {
    expect(appController).toBeDefined();
    expect(appService).toBeDefined();
  });
});
