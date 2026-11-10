import { Module } from '@nestjs/common';
import { RabbitMQConsumerService } from './rabbitmq.service';
import { TransactionProcessorService } from '../processor/transaction-processor.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [RabbitMQConsumerService, TransactionProcessorService],
  exports: [RabbitMQConsumerService, TransactionProcessorService],
})
export class RabbitMQModule {}
