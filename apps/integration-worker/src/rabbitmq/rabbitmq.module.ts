import { Module } from '@nestjs/common';
import { RabbitMQConsumerService } from './rabbitmq.service';

@Module({
  providers: [RabbitMQConsumerService],
  exports: [RabbitMQConsumerService],
})
export class RabbitMQModule {}
