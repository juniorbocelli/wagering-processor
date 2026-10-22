import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../app.module.ts';
import { correlationMiddleware } from './correlation.middleware.ts';
import type { HttpDependencies } from './http-dependencies.ts';

/**
 * Cria (sem escutar) a aplicação HTTP: usada por `main.ts` e pelos testes, para exercitar
 * exatamente o mesmo pipeline (middleware → guard → controller → filtro).
 */
export async function createHttpApp(deps: HttpDependencies): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(deps), { logger: false, bodyParser: true });
  app.use(correlationMiddleware({ ids: deps.ids, logger: deps.logger }));
  (app.getHttpAdapter().getInstance() as { disable(name: string): void }).disable('x-powered-by');
  deps.logger.warn('auth disabled: TrustedPayloadProviderIdentity');
  await app.init();
  return app;
}
