import type {
  InboundContext,
  ProviderIdentity,
  ProviderIdentityPort,
} from '../../application/ports/identity.ts';

/**
 * Adapter **no-op** (ADR-006): confia no `providerId` do payload e marca a identidade como
 * não autenticada. Trocar por um adapter OIDC (Keycloak/Zitadel) é uma linha de binding no
 * módulo da aplicação; o núcleo financeiro não muda.
 */
export class TrustedPayloadProviderIdentity implements ProviderIdentityPort {
  resolve(ctx: InboundContext): Promise<ProviderIdentity> {
    const body = ctx.body as { providerId?: unknown } | null | undefined;
    const providerId =
      typeof body?.providerId === 'string' ? body.providerId : ctx.params['providerId'];
    return Promise.resolve({ providerId, authenticated: false, scopes: ['*'] });
  }
}
