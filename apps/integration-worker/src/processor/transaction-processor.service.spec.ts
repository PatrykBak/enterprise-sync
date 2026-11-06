import { Readable } from 'node:stream';
import { Test, TestingModule } from '@nestjs/testing';
import { TransactionProcessorService } from './transaction-processor.service';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { AppLogger } from '@enterprise-sync/shared';

describe('TransactionProcessorService', () => {
  let service: TransactionProcessorService;
  let databaseService: jest.Mocked<DatabaseService>;

  beforeEach(async () => {
    const mockDatabaseService = {
      saveTransactionsBatch: jest.fn().mockResolvedValue(undefined),
    };

    const mockAppLogger = {
      warn: jest.fn(),
      log: jest.fn(),
    };

    const mockConfigService = {
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue?: unknown) => {
          if (key === 'BATCH_SIZE') return 2;
          return defaultValue;
        }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionProcessorService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DatabaseService, useValue: mockDatabaseService },
        { provide: AppLogger, useValue: mockAppLogger },
      ],
    }).compile();

    service = module.get<TransactionProcessorService>(
      TransactionProcessorService,
    );
    databaseService = module.get(DatabaseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should correctly mask PII in bank account numbers', async () => {
    const validLines = [
      JSON.stringify({
        transactionId: 'tx-1',
        amount: '100.50',
        currency: 'USD',
        senderAccount: 'PL1234567890123456',
        receiverAccount: 'PL9876543210987654',
        timestamp: '2026-06-26T10:00:00.000Z',
      }),
    ];

    await service.processFileWithStream(
      '00000000-0000-0000-0000-000000000001',
      Readable.from(validLines),
    );

    expect(databaseService.saveTransactionsBatch.mock.calls).toHaveLength(1);
    const savedBatch = databaseService.saveTransactionsBatch.mock.calls[0][0];
    expect(savedBatch[0].senderAccount).toBe('PL******3456');
    expect(savedBatch[0].receiverAccount).toBe('PL******7654');
  });

  it('should skip corrupted json lines (poison pills) without crashing', async () => {
    const mixedLines = [
      '{ invalid-json }',
      JSON.stringify({
        transactionId: 'tx-valid',
        amount: '50.00',
        currency: 'USD',
        senderAccount: 'PL1111222233334444',
        receiverAccount: 'PL5555666677778888',
        timestamp: '2026-06-26T10:00:00.000Z',
      }),
      JSON.stringify({
        transactionId: 'tx-bad-amount',
        amount: '-10.00', // Ujemna kwota - nie przejdzie walidacji Zod
        currency: 'USD',
        senderAccount: 'PL1111222233334444',
        receiverAccount: 'PL5555666677778888',
        timestamp: '2026-06-26T10:00:00.000Z',
      }),
    ];

    await service.processFileWithStream(
      '00000000-0000-0000-0000-000000000001',
      Readable.from(mixedLines),
    );

    expect(databaseService.saveTransactionsBatch.mock.calls).toHaveLength(1);
    const savedBatch = databaseService.saveTransactionsBatch.mock.calls[0][0];
    expect(savedBatch).toHaveLength(1);
    expect(savedBatch[0].transactionId).toBe('tx-valid');
  });

  it('should flush batches in chunks matching configured BATCH_SIZE', async () => {
    const lines = [
      JSON.stringify({
        transactionId: 'tx-1',
        amount: '10.00',
        currency: 'USD',
        senderAccount: 'PL1111111111',
        receiverAccount: 'PL2222222222',
        timestamp: '2026-06-26T10:00:00.000Z',
      }),
      JSON.stringify({
        transactionId: 'tx-2',
        amount: '20.00',
        currency: 'USD',
        senderAccount: 'PL3333333333',
        receiverAccount: 'PL4444444444',
        timestamp: '2026-06-26T10:00:00.000Z',
      }),
      JSON.stringify({
        transactionId: 'tx-3',
        amount: '30.00',
        currency: 'USD',
        senderAccount: 'PL5555555555',
        receiverAccount: 'PL6666666666',
        timestamp: '2026-06-26T10:00:00.000Z',
      }),
    ];

    await service.processFileWithStream(
      '00000000-0000-0000-0000-000000000001',
      Readable.from(lines),
    );

    // BATCH_SIZE = 2, więc przy 3 rekordach powinny być 2 wywołania: pierwsza paczka (2) i pozostałość (1)
    expect(databaseService.saveTransactionsBatch.mock.calls).toHaveLength(2);
    expect(databaseService.saveTransactionsBatch.mock.calls[0][0]).toHaveLength(
      2,
    );
    expect(databaseService.saveTransactionsBatch.mock.calls[1][0]).toHaveLength(
      1,
    );
  });
});
