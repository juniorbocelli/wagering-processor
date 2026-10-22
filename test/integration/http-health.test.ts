import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../src/application/errors.ts';
import type { HealthProbe } from '../../src/application/ports/health.ts';
import { PostgresHealthProbe, SqsHealthProbe } from '../../src/infrastructure/observability/health-probes.ts';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { connect, ensureSchema } from '../support/db.ts';
import { startHttpApp, type TestHttpApp } from '../support/http.ts';
import { testSqsClient } from '../support/sqs.ts';

let orm: MikroORM;
let services: WageringServices;

beforeAll(async () => {
  await ensureSchema();
  orm = await connect('app', 5);
  services = buildWageringServices(orm);
});

afterAll(async () => {
  await orm.close();
});

/** `docker compose pause|unpause <serviço>` no diretório do projeto (infraestrutura real). */
async function compose(action: 'pause' | 'unpause', service: string): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', action, service], { cwd: `${import.meta.dir}/../..`, stdout: 'ignore', stderr: 'pipe' });
  if ((await proc.exited) !== 0) throw new Error(`docker compose ${action} ${service}: ${await new Response(proc.stderr).text()}`);
}

describe('GET /health/ready (PostgreSQL e LocalStack reais)', () => {
  let http: TestHttpApp;

  beforeAll(async () => {
    const probes: HealthProbe[] = [
      new PostgresHealthProbe(orm),
      new SqsHealthProbe(testSqsClient(), process.env['WAGER_QUEUE_NAME'] ?? 'wager-transactions.fifo'),
    ];
    http = await startHttpApp(orm, services, { readiness: probes, readinessTimeoutMs: 1_000 });
  });
  afterAll(async () => {
    await http.close();
  });

  test('200 with both dependencies up; live never depends on them', async () => {
    const ready = await http.request('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('503 naming the dependency when LocalStack is paused; recovers after unpause', async () => {
    await compose('pause', 'localstack');
    try {
      const ready = await http.request('GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
      expect((await http.request('GET', '/health/live')).status).toBe(200);
    } finally {
      await compose('unpause', 'localstack');
    }
    const recovered = await http.request('GET', '/health/ready');
    expect(recovered.status).toBe(200);
  }, 30_000);

  test('503 naming the dependency when PostgreSQL is paused; recovers after unpause', async () => {
    await compose('pause', 'postgres');
    try {
      const ready = await http.request('GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } });
      expect((await http.request('GET', '/health/live')).status).toBe(200);
    } finally {
      await compose('unpause', 'postgres');
    }
    await Bun.sleep(500);
    expect((await http.request('GET', '/health/ready')).status).toBe(200);
  }, 30_000);
});

describe('transient failures', () => {
  test('503 + Retry-After + TRANSIENT_FAILURE: the provider may resend with the same key', async () => {
    const failing = {
      ...services,
      processWagerTransaction: {
        execute: () => Promise.reject(new TransientInfrastructureError('database down')),
      },
    } as unknown as WageringServices;
    const http = await startHttpApp(orm, failing);
    try {
      const response = await http.request('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': 'k-1' },
        body: {
          providerId: 'provider-a',
          externalTransactionId: 'ext-1',
          playerId: 'p',
          walletId: crypto.randomUUID(),
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(response.body.code).toBe('TRANSIENT_FAILURE');
    } finally {
      await http.close();
    }
  });

  test('an unclassified error is a 500 without leaking details', async () => {
    const broken = {
      ...services,
      getWallet: { execute: () => Promise.reject(new Error('secret connection string postgres://user:pw@host')) },
    } as unknown as WageringServices;
    const http = await startHttpApp(orm, broken);
    try {
      const response = await http.request('GET', `/wallets/${crypto.randomUUID()}`);
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(response.text).not.toContain('secret');
    } finally {
      await http.close();
    }
  });
});
