/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClsService } from 'nestjs-cls';
import { ConfigService } from '@nestjs/config';
import { RabbitMQService } from './rabbitmq.service';
import { S3_CLIENT_TOKEN } from './s3.module';
import { BadRequestException } from '@nestjs/common';
import type { S3UploadResult } from './s3-upload-result.interface';

describe('AppController', () => {
  let appController: AppController;
  let appService: jest.Mocked<AppService>;

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
      isConnected: jest.fn().mockReturnValue(true),
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
    appService = app.get(AppService);
  });

  it('should be defined', () => {
    expect(appController).toBeDefined();
    expect(appService).toBeDefined();
  });

  it('should throw BadRequestException if file was not uploaded', async () => {
    await expect(
      appController.syncTransactions(
        undefined as unknown as S3UploadResult,
        'sha256-hash',
        'tenant-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw BadRequestException if x-expected-hash header is missing', async () => {
    const mockFile: S3UploadResult = {
      status: 'accepted',
      fileId: 'file-123',
      sha256: 'hash-123',
      message: 'File accepted',
      objectKey: 'transactions/file-123/file.ndjson',
    };

    await expect(
      appController.syncTransactions(mockFile, undefined, 'tenant-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('should delegate to appService when payload is valid', async () => {
    const mockFile: S3UploadResult = {
      status: 'accepted',
      fileId: 'file-123',
      sha256: 'hash-123',
      message: 'File accepted',
      objectKey: 'transactions/file-123/file.ndjson',
    };

    const result = await appController.syncTransactions(
      mockFile,
      'valid-hash',
      'tenant-1',
    );

    expect(result).toEqual({
      status: 'accepted',
      correlationId: 'test-correlation-id',
    });
    expect(appService.processSyncTransaction.mock.calls[0]).toEqual([
      mockFile,
      'valid-hash',
      'test-correlation-id',
      'tenant-1',
    ]);
  });
});
