import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PROVIDER_IDENTITY_PORT } from './application/ports/identity.ts';
import { ConsoleController } from './interfaces/http/controllers/console.controller.ts';
import { DocsController } from './interfaces/http/controllers/docs.controller.ts';
import { HealthController } from './interfaces/http/controllers/health.controller.ts';
import { WageringController } from './interfaces/http/controllers/wagering.controller.ts';
import { WalletsController } from './interfaces/http/controllers/wallets.controller.ts';
import { ApplicationExceptionFilter, HTTP_LOGGER } from './interfaces/http/filters/application-exception.filter.ts';
import { ProviderAuthGuard } from './interfaces/http/guards/provider-auth.guard.ts';
import { HTTP_DEPENDENCIES, type HttpDependencies } from './interfaces/http/http-dependencies.ts';

/**
 * Módulo HTTP. As dependências chegam já compostas (`register`): a raiz de composição
 * (`main.ts`, ou o harness dos testes) decide adapters reais ou de teste, e o módulo apenas
 * os liga a controllers, guard e filtro. A identidade do provedor é trocada em **um** ponto:
 * o provider de `PROVIDER_IDENTITY_PORT` (ADR-006).
 */
@Module({})
export class AppModule {
  static register(deps: HttpDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, DocsController, ConsoleController],
      providers: [
        { provide: HTTP_DEPENDENCIES, useValue: deps },
        { provide: HTTP_LOGGER, useValue: deps.logger },
        { provide: PROVIDER_IDENTITY_PORT, useValue: deps.identity },
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        { provide: APP_FILTER, useClass: ApplicationExceptionFilter },
      ],
    };
  }
}
