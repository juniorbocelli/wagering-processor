import type { ProviderIdentity } from '../../application/ports/identity.ts';

/**
 * Subconjunto mínimo de `Request`/`Response` do Express usado pela camada HTTP. Tipado aqui
 * para não depender de `@types/express` nem vazar o framework para fora de `interfaces/http`.
 */
export interface HttpRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  query: Record<string, unknown>;
  body?: unknown;
  /** Definido pelo middleware de correlação, antes de qualquer guard ou controller. */
  correlationId?: string;
  /** Definido pelo guard de autenticação (ADR-006). */
  providerIdentity?: ProviderIdentity;
}

export interface HttpResponse {
  statusCode: number;
  status(code: number): HttpResponse; // check-money:allow
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

export const CORRELATION_HEADER = 'x-correlation-id';
