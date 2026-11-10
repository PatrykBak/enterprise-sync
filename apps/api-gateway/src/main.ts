import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '@enterprise-sync/shared';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const configService = app.get(ConfigService);
  const port = Number(configService.get('PORT')) || 3000;
  await app.listen(port);
}

bootstrap().catch((error: unknown): void => {
  console.error(
    `Application crashed during startup: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
