import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics.ts';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { connect, ensureSchema, uuid } from '../support/db.ts';
import { startHttpApp, type TestHttpApp } from '../support/http.ts';
import { assertLedgerConsistency } from '../support/consistency.ts';

let orm: MikroORM;
let services: WageringServices;
let http: TestHttpApp;
const metrics = new PrometheusMetrics();

beforeAll(async () => {
  await ensureSchema();
  orm = await connect('app', 20);
  services = buildWageringServices(orm, { metrics });
  http = await startHttpApp(orm, services, { metrics });
});

afterAll(async () => {
  await http.close();
  await orm.close();
});

const money = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(amount = '100.00') {
  const playerId = `player-${uuid()}`;
  const response = await http.request('POST', '/wallets', { body: { playerId, initialBalance: money(amount) } });
  expect(response.status).toBe(201);
  return { id: response.body.id as string, playerId };
}

function submitBody(wallet: { id: string; playerId: string }, over: Record<string, unknown> = {}) {
  const externalTransactionId = `ext-${uuid()}`;
  const body = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: money('25.00'),
    ...over,
  };
  return { body, key: `provider-a:${body.externalTransactionId as string}` };
}

const submit = (body: unknown, key?: string) =>
  http.request('POST', '/wagering/transactions', { body, headers: key === undefined ? {} : { 'idempotency-key': key } });

describe('POST /wallets', () => {
  test('201 with the §9 contract; duplicate (playerId, currency) is 409; invalid payloads are 400', async () => {
    const playerId = `player-${uuid()}`;
    const created = await http.request('POST', '/wallets', { body: { playerId, initialBalance: money('1000.00') } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ playerId, balance: money('1000.00'), version: 1 });
    expect(created.body.id).toBe(created.body.walletId);
    expect(created.headers.get('x-correlation-id')).toBeTruthy();

    const duplicate = await http.request('POST', '/wallets', { body: { playerId, initialBalance: money('5.00') } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');
    expect(duplicate.body.correlationId).toBe(duplicate.headers.get('x-correlation-id'));

    for (const bad of [
      { playerId, initialBalance: { amount: 10, currency: 'BRL' } }, // amount numérico
      { playerId, initialBalance: money('1.234') },
      { playerId, initialBalance: money('-1.00') },
      { playerId, initialBalance: money('1.00'), extra: true },
      { initialBalance: money('1.00') },
    ]) {
      const response = await http.request('POST', '/wallets', { body: bad });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    }
    const malformed = await http.request('POST', '/wallets', { raw: '{not json' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /wagering/transactions — status contract', () => {
  test('201 → 200 replay → 422 rejection (and its replay) → 202 pending reference → 409 conflict → 400', async () => {
    const wallet = await createWallet('100.00');

    const bet = submitBody(wallet);
    const first = await submit(bet.body, bet.key);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: money('75.00'), idempotentReplay: false });

    const replay = await submit(bet.body, bet.key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: first.body.transactionId, balance: money('75.00'), idempotentReplay: true });

    const tooBig = submitBody(wallet, { money: money('500.00') });
    const rejected = await submit(tooBig.body, tooBig.key);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false });
    const rejectedReplay = await submit(tooBig.body, tooBig.key);
    expect(rejectedReplay.status).toBe(422);
    expect(rejectedReplay.body.idempotentReplay).toBe(true);

    const refund = submitBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: `missing-${uuid()}`, money: money('25.00') });
    const pending = await submit(refund.body, refund.key);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    const conflict = await submit({ ...bet.body, money: money('26.00') }, bet.key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const otherKey = await submit(bet.body, `another-${uuid()}`);
    expect(otherKey.status).toBe(409);
    expect(otherKey.body.code).toBe('EXTERNAL_TRANSACTION_ID_REUSED');

    expect((await submit(bet.body)).status).toBe(400); // sem Idempotency-Key
    expect((await submit({ ...bet.body, amount: '1.00' }, bet.key)).status).toBe(400); // campo desconhecido
    expect((await submit({ ...bet.body, kind: 'OPENING' }, `k-${uuid()}`)).status).toBe(400);
    const unknownWallet = submitBody({ id: uuid(), playerId: 'p' });
    const missing = await submit(unknownWallet.body, unknownWallet.key);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('WALLET_NOT_FOUND');

    await assertLedgerConsistency(orm, wallet.id);
  });

  test('queries return the same body as the POST (without idempotentReplay) and 404 when absent', async () => {
    const wallet = await createWallet('50.00');
    const bet = submitBody(wallet);
    const posted = await submit(bet.body, bet.key);

    const byId = await http.request('GET', `/wagering/transactions/${posted.body.transactionId as string}`);
    const byExternal = await http.request(
      'GET',
      `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`,
    );
    const { idempotentReplay: _ignored, ...expected } = posted.body;
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual(expected);
    expect(byExternal.body).toEqual(expected);

    expect((await http.request('GET', `/wagering/transactions/${uuid()}`)).status).toBe(404);
    expect((await http.request('GET', '/wagering/transactions/not-a-uuid')).status).toBe(400);
    expect((await http.request('GET', '/providers/provider-a/wagering/transactions/nope')).body.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await http.request('GET', '/no/such/route')).body.code).toBe('NOT_FOUND');
  });
});

describe('GET /wallets/:walletId and ledger', () => {
  test('wallet view, 404 and 400', async () => {
    const wallet = await createWallet('10.00');
    const response = await http.request('GET', `/wallets/${wallet.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ walletId: wallet.id, playerId: wallet.playerId, balance: money('10.00'), version: 1 });
    expect((await http.request('GET', `/wallets/${uuid()}`)).status).toBe(404);
    expect((await http.request('GET', '/wallets/xyz')).status).toBe(400);
  });

  test('cursor pagination is stable and complete, also while new entries are appended concurrently', async () => {
    const wallet = await createWallet('1000.00');
    for (let i = 0; i < 6; i += 1) {
      const bet = submitBody(wallet, { money: money('1.00') });
      expect((await submit(bet.body, bet.key)).status).toBe(201);
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `limit=3${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = await http.request('GET', `/wallets/${wallet.id}/ledger?${query}`);
      expect(page.status).toBe(200);
      for (const item of page.body.items) seen.push(item.walletVersion);
      pages += 1;
      if (pages === 1) {
        // inserção concorrente entre páginas: não pode duplicar nem pular itens
        const extra = submitBody(wallet, { money: money('1.00') });
        expect((await submit(extra.body, extra.key)).status).toBe(201);
      }
      cursor = page.body.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(seen).size).toBe(seen.length);

    const first = await http.request('GET', `/wallets/${wallet.id}/ledger?limit=1`);
    expect(first.body.items[0]).toMatchObject({
      direction: 'CREDIT',
      amount: money('1000.00'),
      balanceBefore: money('0.00'),
      balanceAfter: money('1000.00'),
      walletVersion: 1,
    });
    expect(Buffer.from(first.body.nextCursor, 'base64url').toString()).toBe('{"v":1}');

    for (const bad of ['limit=0', 'limit=201', 'limit=abc', 'cursor=@@@', `cursor=${Buffer.from('{"v":"x"}').toString('base64url')}`]) {
      expect((await http.request('GET', `/wallets/${wallet.id}/ledger?${bad}`)).status).toBe(400);
    }
    expect((await http.request('GET', `/wallets/${uuid()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistent wallet reports zero difference and the number of checked entries', async () => {
    const wallet = await createWallet('100.00');
    const bet = submitBody(wallet);
    await submit(bet.body, bet.key);
    const response = await http.request('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: money('75.00'),
      calculatedBalance: money('75.00'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 2,
      chainIntact: true,
      versionConsistent: true,
    });
    expect((await http.request('POST', `/wallets/${uuid()}/reconciliation`)).status).toBe(404);
  });
});

describe('operational endpoints', () => {
  test('live and metrics are open; metrics expose the catalog including reconciliation series', async () => {
    expect((await http.request('GET', '/health/live')).body).toEqual({ status: 'ok' });
    const response = await http.request('GET', '/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    for (const name of ['wager_transactions_total', 'idempotency_replays_total', 'wallet_reconciliation_divergences_total']) {
      expect(response.text).toContain(name);
    }
  });

  test('a client-supplied X-Correlation-Id is echoed; an unsafe one is replaced', async () => {
    const ok = await http.request('GET', '/health/live', { headers: { 'x-correlation-id': 'abc-123' } });
    expect(ok.headers.get('x-correlation-id')).toBe('abc-123');
    const unsafe = await http.request('GET', '/health/live', { headers: { 'x-correlation-id': 'a b"c' } });
    expect(unsafe.headers.get('x-correlation-id')).not.toBe('a b"c');
  });
});
