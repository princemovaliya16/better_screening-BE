import { loadEnv } from '@config/env';
// Must run before AppModule (and anything it imports) is loaded, since some
// providers read env vars at construction/decoration time.
loadEnv();

import compression from 'compression';
import { raw } from 'express';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getEnv, getEnvNumber } from '@config/env';
import { GlobalExceptionFilter } from '@core/dispatchers';
import { logger } from '@core/logger';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.use(compression());
  // LiveKit webhooks are signed over the exact request body (and sent as
  // application/webhook+json, which the default JSON parser skips) — keep it raw.
  // Registered before Nest's own body parsers, which only attach on listen().
  app.use('/v1/livekit/webhook', raw({ type: '*/*' }));
  app.enableCors({ origin: getEnv('FRONTEND_URL', '*'), credentials: true });
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validationError: { target: false, value: false },
    }),
  );

  setupSwagger(app);

  const port = getEnvNumber('PORT', 3000);
  await app.listen(port);
  logger.log(`Better Screening API listening on port ${port} (docs at /docs)`);
}

bootstrap().catch((err: unknown) => {
  logger.error('Failed to start Better Screening API', err instanceof Error ? err.stack : err);
  process.exit(1);
});
