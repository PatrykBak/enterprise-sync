import { Module } from '@nestjs/common';
import { RabbitMQConsumerService } from './rabbitmq.service';
import { TransactionProcessorService } from '../processor/transaction-processor.service';

@Module({
  providers: [RabbitMQConsumerService, TransactionProcessorService],
  exports: [RabbitMQConsumerService, TransactionProcessorService],
})
export class RabbitMQModule {}
