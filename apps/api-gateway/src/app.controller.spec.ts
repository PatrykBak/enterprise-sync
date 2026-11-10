import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { S3_CLIENT_TOKEN } from './s3.module';
import type { S3UploadResult } from './s3-upload-result.interface';

describe('AppController', () => {
  let appController: AppController;
  let appService: jest.Mocked<AppService>;

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
    getOrThrow: jest.fn().mockReturnValue('transactions-bucket'),
  };

  const validMockFile: S3UploadResult = {
    status: 'accepted',
    fileId: 'file-123',
    sha256: 'hash-123',
    message: 'File accepted',
    objectKey: 'transactions/file-123/file.ndjson',
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: AppService, useValue: mockAppService },
        { provide: ClsService, useValue: mockClsService },
        { provide: S3_CLIENT_TOKEN, useValue: mockS3Client },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    appController = moduleRef.get<AppController>(AppController);
    appService = moduleRef.get(AppService);

    jest.clearAllMocks();
  });

  describe('syncTransactions', () => {
    it('should throw BadRequestException if file was not uploaded', async () => {
      await expect(
        appController.syncTransactions(
          undefined as unknown as S3UploadResult,
          'valid-hash',
          'tenant-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if x-expected-hash header is missing', async () => {
      await expect(
        appController.syncTransactions(validMockFile, undefined, 'tenant-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if x-tenant-id header is missing', async () => {
      await expect(
        appController.syncTransactions(validMockFile, 'valid-hash', undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('should delegate to appService and return accepted status when request is valid', async () => {
      const result = await appController.syncTransactions(
        validMockFile,
        'valid-hash',
        'tenant-1',
      );

      expect(result).toEqual({
        status: 'accepted',
        correlationId: 'test-correlation-id',
      });

      expect(appService.processSyncTransaction).toHaveBeenCalledWith(
        validMockFile,
        'hash-123',
        'test-correlation-id',
        'tenant-1',
      );
    });

    it('should propagate ServiceUnavailableException from appService when downstream broker fails', async () => {
      appService.processSyncTransaction.mockRejectedValueOnce(
        new ServiceUnavailableException('Downstream broker unavailable'),
      );

      await expect(
        appController.syncTransactions(validMockFile, 'valid-hash', 'tenant-1'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
