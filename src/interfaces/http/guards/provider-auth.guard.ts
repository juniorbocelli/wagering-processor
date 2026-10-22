import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProviderIdentityMismatchError } from '../../../application/errors.ts';
import { PROVIDER_IDENTITY_PORT, type ProviderIdentityPort } from '../../../application/ports/identity.ts';
import type { HttpRequest } from '../http-types.ts';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca rota (ou controller) como aberta: continua aberta quando o guard deixar de ser no-op. */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Guard global **no-op** (ADR-006): resolve a identidade pela porta e a anexa à requisição,
 * mas hoje sempre permite. Substituir o adapter por OIDC não exige tocar neste guard nem no
 * núcleo financeiro. Não é proteção: o log de inicialização avisa que a autenticação está
 * desligada.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY_PORT) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const params = request.params ?? {};
    const identity = await this.identity.resolve({ headers: request.headers, body: request.body, params });
    request.providerIdentity = identity;

    // Só uma identidade verificada restringe o acesso (ADR-006 §4): o provedor da rota ou do
    // corpo precisa ser o autenticado. Leituras por ID interno são checadas no controller.
    if (identity.authenticated) {
      const body = request.body;
      const bodyProvider =
        typeof body === 'object' && body !== null ? (body as { providerId?: unknown }).providerId : undefined;
      for (const claimed of [params['providerId'], bodyProvider]) {
        if (claimed !== undefined && claimed !== identity.providerId) throw new ProviderIdentityMismatchError();
      }
    }
    return true;
  }
}
