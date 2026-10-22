/** Identidade do provedor que originou a requisição (ADR-006). */
export interface ProviderIdentity {
  readonly providerId: string | undefined;
  /** `false` no adapter no-op: a identidade vem do payload, não de uma credencial verificada. */
  readonly authenticated: boolean;
  readonly scopes: readonly string[];
}

/** Metadados de transporte e corpo da requisição, sem acoplar a aplicação ao framework HTTP. */
export interface InboundContext {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  /** Parâmetros de rota (ex.: `providerId` nas leituras por ID externo, que não têm corpo). */
  readonly params: Readonly<Record<string, string | undefined>>;
}

export interface ProviderIdentityPort {
  resolve(ctx: InboundContext): Promise<ProviderIdentity>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('ProviderIdentityPort');
