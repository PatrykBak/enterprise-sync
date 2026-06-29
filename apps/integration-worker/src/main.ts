import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppLogger } from './app.logger';
import { ConfigService } from '@nestjs/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: false,
  });
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
}

bootstrap().catch((error: unknown): void => {
  console.error(
    `Application crashed during startup: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
