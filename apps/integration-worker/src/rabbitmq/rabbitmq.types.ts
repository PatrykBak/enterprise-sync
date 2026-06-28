import type { ConsumeMessage } from 'amqplib';

export interface SyncJobPayload {
  fileId: string;
  expectedHash: string;
  correlationId: string;
  tenantId: string;
  messageId?: string;
}

export interface RabbitMQStatus {
  isConnected: boolean;
  isChannelOpen: boolean;
  consumerTag: string | null;
  isProcessing: boolean;
  isShuttingDown: boolean;
}

export type SyncJobHandler = (
  payload: SyncJobPayload,
  msg: ConsumeMessage,
) => Promise<void>;
