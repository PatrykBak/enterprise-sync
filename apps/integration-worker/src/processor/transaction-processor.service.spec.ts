import { Test, TestingModule } from '@nestjs/testing';
import { TransactionProcessorService } from './transaction-processor.service';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { AppLogger } from '@enterprise-sync/shared';

describe('TransactionProcessorService', () => {
  let service: TransactionProcessorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionProcessorService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(1000) },
        },
        {
          provide: DatabaseService,
          useValue: { saveTransactionsBatch: jest.fn() },
        },
        {
          provide: AppLogger,
          useValue: { warn: jest.fn(), log: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<TransactionProcessorService>(
      TransactionProcessorService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
