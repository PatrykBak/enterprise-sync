import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { S3Module } from './s3.module';
import { RabbitMQModule } from './rabbitmq.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    S3Module,
    RabbitMQModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
