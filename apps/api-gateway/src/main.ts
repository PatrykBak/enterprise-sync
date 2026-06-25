import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get<ConfigService>(ConfigService);
  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  Logger.error(
    `Application crashed during startup: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
