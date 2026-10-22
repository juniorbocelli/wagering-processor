import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { HealthProbe } from '../../src/application/ports/health.ts';
import { TrustedPayloadProviderIdentity } from '../../src/infrastructure/auth/trusted-payload-provider-identity.ts';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics.ts';
import { UuidV7Generator } from '../../src/infrastructure/runtime/system-runtime.ts';
import type { WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { createHttpApp } from '../../src/interfaces/http/create-app.ts';
import { NOOP_LOGGER, type Logger } from '../../src/application/ports/observability.ts';

export interface TestHttpApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
  request(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string>; raw?: string }): Promise<{
    status: number;
    headers: Headers;
    body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    text: string;
  }>;
}

/** Sobe o pipeline HTTP real (Nest/Express) numa porta efêmera, sobre serviços reais. */
export async function startHttpApp(
  _orm: MikroORM,
  services: WageringServices,
  options: { readiness?: HealthProbe[]; metrics?: PrometheusMetrics; logger?: Logger; readinessTimeoutMs?: number } = {},
): Promise<TestHttpApp> {
  const app = await createHttpApp({
    openWallet: services.openWallet,
    processWagerTransaction: services.processWagerTransaction,
    getWallet: services.getWallet,
    listLedger: services.listLedger,
    getTransaction: services.getTransaction,
    reconcileWallet: services.reconcileWallet,
    identity: new TrustedPayloadProviderIdentity(),
    readiness: options.readiness ?? [],
    ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
    metrics: options.metrics ?? new PrometheusMetrics(),
    logger: options.logger ?? NOOP_LOGGER,
    ids: new UuidV7Generator(),
  });
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  return {
    app,
    baseUrl,
    close: () => app.close(),
    async request(method, path, opts = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...(opts.body !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
        ...(opts.raw !== undefined
          ? { body: opts.raw }
          : opts.body !== undefined
            ? { body: JSON.stringify(opts.body) }
            : {}),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, headers: response.headers, body, text };
    },
  };
}
