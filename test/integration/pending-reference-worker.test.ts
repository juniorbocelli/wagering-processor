import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../../src/application/ports/runtime.ts';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { PendingReferenceWorker } from '../../src/interfaces/workers/pending-reference-worker.ts';
import { assertLedgerConsistency } from '../support/consistency.ts';
import { connect, ensureSchema, sql } from '../support/db.ts';
import { createFixtures } from '../support/wagering-fixtures.ts';

/** Relógio controlável: backoff e TTL avançam sem esperar. */
class MutableClock implements Clock {
  private current = Date.now();
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void { // check-money:allow
    this.current += ms;
  }
}

let app: MikroORM;
let services: WageringServices;
const clock = new MutableClock();
let worker: PendingReferenceWorker;

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 30);
  services = buildWageringServices(app, { clock });
  worker = new PendingReferenceWorker({
    scanner: services.store,
    reprocess: services.reprocessPendingReference,
    clock,
    options: { pollIntervalMs: 50, batchSize: 100, concurrency: 5 },
  });
});

afterAll(async () => {
  await worker.stop();
  await app.close();
});

const { openWallet, cmd, run, txOf, balanceOf, ledgerCount } = createFixtures(
  () => app,
  () => services,
);

const statusOf = async (transactionId: string) => {
  const [row] = await sql<{ status: string; failure_code: string | null }>(
    app,
    'SELECT status, failure_code FROM wager_transactions WHERE id = ?',
    [transactionId],
  );
  return row!;
};

describe('PendingReferenceWorker (PostgreSQL real)', () => {
  test('REFUND before BET: PENDING_REFERENCE, then PROCESSED once the BET exists', async () => {
    const wallet = await openWallet('100.00');
    const bet = cmd(wallet);
    const refund = cmd(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const pending = txOf(await run(refund));
    expect(pending.status).toBe('PENDING_REFERENCE');
    expect(await balanceOf(wallet.id)).toBe('100.00'); // nada foi aplicado

    // Antes do vencimento, o worker não toca na transação.
    await worker.runOnce();
    expect((await statusOf(pending.id)).status).toBe('PENDING_REFERENCE');

    expect(txOf(await run(bet)).status).toBe('PROCESSED');
    clock.advance(2_000);
    await worker.runOnce();

    expect((await statusOf(pending.id)).status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('100.00'); // -10 (bet) +10 (refund)
    expect(await ledgerCount(wallet.id, 'CREDIT')).toBe(2); // OPENING + REFUND
    await assertLedgerConsistency(app, wallet.id);
  });

  test('reference never arrives and the TTL is exhausted: REJECTED(REFERENCE_NOT_FOUND) with its event', async () => {
    const wallet = await openWallet('100.00');
    const refund = cmd(wallet, { kind: 'REFUND', referenceExternalTransactionId: `never-${crypto.randomUUID()}` });
    const pending = txOf(await run(refund));
    expect(pending.status).toBe('PENDING_REFERENCE');

    clock.advance(16 * 60_000); // além dos 15 min de TTL
    await worker.runOnce();

    const settled = await statusOf(pending.id);
    expect(settled).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    const events = await sql<{ event_type: string }>(
      app,
      'SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq',
      [wallet.id],
    );
    expect(events.map((event) => event.event_type)).toContain('WagerTransactionRejected');
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await assertLedgerConsistency(app, wallet.id);
  });

  test('attempts are consumed by backoff: still pending after a failed attempt, then rejected at the limit', async () => {
    const wallet = await openWallet('100.00');
    const pending = txOf(
      await run(cmd(wallet, { kind: 'REFUND', referenceExternalTransactionId: `missing-${crypto.randomUUID()}` })),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      clock.advance(61_000); // sempre além do maior atraso (60 s), mas aquém do TTL somado
      await worker.runOnce();
      if ((await statusOf(pending.id)).status !== 'PENDING_REFERENCE') break;
    }
    // 12 tentativas ou 15 min: com passos de 61 s, o limite de tentativas ainda não foi atingido.
    expect((await statusOf(pending.id)).status).toBe('PENDING_REFERENCE');

    for (let attempt = 0; attempt < 12; attempt += 1) {
      clock.advance(61_000);
      await worker.runOnce();
    }
    expect(await statusOf(pending.id)).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    await assertLedgerConsistency(app, wallet.id);
  });

  test('two workers racing on the same due item: it is settled once (one rejection event)', async () => {
    const wallet = await openWallet('100.00');
    const pending = txOf(
      await run(cmd(wallet, { kind: 'REFUND', referenceExternalTransactionId: `ghost-${crypto.randomUUID()}` })),
    );
    clock.advance(16 * 60_000); // TTL esgotado: o reprocessamento rejeita

    const second = new PendingReferenceWorker({
      scanner: services.store,
      reprocess: services.reprocessPendingReference,
      clock,
      options: { pollIntervalMs: 50, batchSize: 100, concurrency: 5 },
    });
    await Promise.all([worker.runOnce(), second.runOnce()]);

    expect(await statusOf(pending.id)).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    const events = await sql<{ event_type: string }>(
      app,
      "SELECT event_type FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'",
      [wallet.id],
    );
    expect(events).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await assertLedgerConsistency(app, wallet.id);
  });

  test('a reference that arrives while the item is pending resolves it (cascade) and the worker leaves it alone', async () => {
    const wallet = await openWallet('100.00');
    const bet = cmd(wallet);
    const pending = txOf(
      await run(cmd(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId })),
    );
    await run(bet);
    clock.advance(2_000);
    await worker.runOnce();

    expect((await statusOf(pending.id)).status).toBe('PROCESSED');
    expect(await ledgerCount(wallet.id, 'CREDIT')).toBe(2); // OPENING + um único REFUND
    await assertLedgerConsistency(app, wallet.id);
  });
});
