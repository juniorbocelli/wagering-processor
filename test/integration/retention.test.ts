import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { DEFAULT_RETENTION_OPTIONS, RetentionWorker } from '../../src/interfaces/workers/retention-worker.ts';
import { assertLedgerConsistency } from '../support/consistency.ts';
import { connect, ensureSchema, sql } from '../support/db.ts';
import { createFixtures } from '../support/wagering-fixtures.ts';

/** Retenção (ADR-011) contra PostgreSQL real. */
let app: MikroORM;
let services: WageringServices;

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 30);
  services = buildWageringServices(app);
});

afterAll(async () => {
  await app.close();
});

const { openWallet, cmd, count, balanceOf, ledgerCount } = createFixtures(
  () => app,
  () => services,
);

const retention = (over: Partial<typeof DEFAULT_RETENTION_OPTIONS> = {}) =>
  new RetentionWorker({
    store: services.store,
    clock: services.clock,
    options: { ...DEFAULT_RETENTION_OPTIONS, ...over },
  });

async function outboxRow(aggregateId: string, publishedHoursAgo: number | null): Promise<string> {
  const id = crypto.randomUUID();
  await sql(
    app,
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, next_attempt_at, published_at)
     VALUES (?, ?, 'WalletBalanceChanged', 1, '{}'::jsonb, now(), now(),
             CASE WHEN ?::numeric IS NULL THEN NULL ELSE now() - make_interval(hours => ?::int) END)`,
    [id, aggregateId, publishedHoursAgo, publishedHoursAgo],
  );
  return id;
}

async function inboxRow(messageId: string, processedDaysAgo: number): Promise<void> {
  await sql(
    app,
    `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
     VALUES ('retention-test', ?, ?, now(), now() - make_interval(days => ?::int))`,
    [messageId, 'a'.repeat(64), processedDaysAgo],
  );
}

describe('RetentionWorker (PostgreSQL real)', () => {
  test('eligible rows are deleted; pending and recent rows are preserved', async () => {
    const aggregate = crypto.randomUUID();
    const old = await outboxRow(aggregate, 100);
    const recent = await outboxRow(aggregate, 1);
    const pending = await outboxRow(aggregate, null);

    const tag = crypto.randomUUID();
    await inboxRow(`old-${tag}`, 10);
    await inboxRow(`new-${tag}`, 1);

    const result = await retention().runOnce();
    expect(result.outbox).toBeGreaterThanOrEqual(1);
    expect(result.inbox).toBeGreaterThanOrEqual(1);

    const survivors = await sql<{ id: string }>(app, 'SELECT id FROM outbox_messages WHERE aggregate_id = ?', [aggregate]);
    expect(survivors.map((row) => row.id).sort()).toEqual([recent, pending].sort());
    expect(survivors.map((row) => row.id)).not.toContain(old);
    expect(await count('inbox_messages', 'message_id = ?', [`old-${tag}`])).toBe(0);
    expect(await count('inbox_messages', 'message_id = ?', [`new-${tag}`])).toBe(1);
  });

  test('a pending row is never deleted, even with a tiny retention window', async () => {
    const aggregate = crypto.randomUUID();
    const pending = await outboxRow(aggregate, null);
    await retention({ outboxRetentionHours: 1 }).runOnce();
    expect(await count('outbox_messages', 'id = ?', [pending])).toBe(1);
  });

  test('two simultaneous workers purge in small batches without conflict and without double deletion', async () => {
    const aggregate = crypto.randomUUID();
    const total = 40;
    await Promise.all(Array.from({ length: total }, () => outboxRow(aggregate, 200)));
    expect(await count('outbox_messages', 'aggregate_id = ?', [aggregate])).toBe(total);

    const results = await Promise.all([retention({ batchSize: 5 }).runOnce(), retention({ batchSize: 5 }).runOnce()]);
    expect(await count('outbox_messages', 'aggregate_id = ?', [aggregate])).toBe(0);
    // SKIP LOCKED: cada linha foi apagada por exatamente um dos workers
    expect(results[0].outbox + results[1].outbox).toBeGreaterThanOrEqual(total);
  });

  test('two simultaneous workers purging the inbox do not conflict (ordered deletes, no deadlock)', async () => {
    const tag = crypto.randomUUID();
    const total = 40;
    await Promise.all(Array.from({ length: total }, (_, i) => inboxRow(`bulk-${tag}-${i}`, 30)));

    const results = await Promise.all([retention({ batchSize: 5 }).runOnce(), retention({ batchSize: 5 }).runOnce()]);
    expect(await count('inbox_messages', 'message_id LIKE ?', [`bulk-${tag}-%`])).toBe(0);
    expect(results[0].inbox + results[1].inbox).toBeGreaterThanOrEqual(total);
  });

  test('redelivery of a purged inbox message has no effect (the business idempotency absorbs it)', async () => {
    const wallet = await openWallet('100.00');
    const command = cmd(wallet);
    const messageId = `msg-${crypto.randomUUID()}`;
    const ctx = { correlationId: `corr-${crypto.randomUUID()}`, inbox: { consumerName: 'wager-transactions', messageId } };

    const first = await services.processWagerTransaction.execute(command, ctx);
    expect(first.kind).not.toBe('duplicate-delivery');
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await count('inbox_messages', 'message_id = ?', [messageId])).toBe(1);

    // Janela de 0 dias: a linha da inbox deste teste passa a ser elegível e é expurgada.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await retention({ inboxRetentionDays: 0 }).runOnce();
    expect(await count('inbox_messages', 'message_id = ?', [messageId])).toBe(0);

    const again = await services.processWagerTransaction.execute(command, {
      ...ctx,
      correlationId: `corr-${crypto.randomUUID()}`,
    });
    expect(again.kind).toBe('replay');
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('the retention indexes are partial and serve the purge predicates', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }>(
      app,
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('ix_outbox_published', 'ix_inbox_processed')",
    );
    const defs = Object.fromEntries(indexes.map((index) => [index.indexname, index.indexdef]));
    expect(defs['ix_outbox_published']).toContain('published_at IS NOT NULL');
    expect(defs['ix_inbox_processed']).toBeDefined();
  });
});
