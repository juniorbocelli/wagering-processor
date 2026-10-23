import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher } from '../../src/application/ports/messaging.ts';
import { SimulatedCrashError } from '../../src/application/ports/runtime.ts';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message.ts';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs/sqs.ts';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { OutboxPublisherWorker, type OutboxPublisherOptions } from '../../src/interfaces/workers/outbox-publisher-worker.ts';
import { assertLedgerConsistency, CrashOnceFaultInjector } from '../support/consistency.ts';
import { connect, ensureSchema, sql } from '../support/db.ts';
import { collect, createTestQueues, type TestQueues } from '../support/sqs.ts';
import { createFixtures, type TestWallet } from '../support/wagering-fixtures.ts';
import { sleep, waitFor } from '../support/wait.ts';

/**
 * Publisher da outbox (ADR-004 §4 e §6) contra PostgreSQL e LocalStack reais. A tabela é
 * global: cada teste "liquida" o que ficou pendente antes e filtra pelas próprias wallets.
 */
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

const { openWallet, cmd, run } = createFixtures(
  () => app,
  () => services,
);

let queues: TestQueues;
const workers: OutboxPublisherWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await queues?.cleanup();
});

async function settleForeignOutbox(): Promise<void> {
  await sql(app, 'UPDATE outbox_messages SET published_at = now(), locked_until = NULL, locked_by = NULL WHERE published_at IS NULL');
}

function workerFor(
  instanceId: string,
  over: { publisher?: EventPublisher; faults?: CrashOnceFaultInjector; options?: Partial<OutboxPublisherOptions> } = {},
): OutboxPublisherWorker {
  const worker = new OutboxPublisherWorker({
    store: services.store,
    publisher: over.publisher ?? new SqsEventPublisher(queues.client, queues.eventsUrl),
    clock: services.clock,
    options: {
      instanceId,
      pollIntervalMs: 50,
      leaseMs: 30_000,
      headLimit: 10,
      perWalletLimit: 20,
      stuckAttempts: 10,
      ...over.options,
    },
    ...(over.faults === undefined ? {} : { faults: over.faults }),
  });
  workers.push(worker);
  return worker;
}

/** Wallet com `bets` apostas: gera `2 + 2 * bets` eventos na outbox, em ordem. */
async function walletWithEvents(bets: number): Promise<TestWallet> {
  const wallet = await openWallet('1000.00');
  for (let i = 0; i < bets; i += 1) await run(cmd(wallet));
  return wallet;
}

interface OutboxRow {
  id: string;
  seq: string;
  aggregate_id: string;
  published_at: Date | null;
}

const outboxOf = (walletIds: string[]): Promise<OutboxRow[]> =>
  sql<OutboxRow>(
    app,
    `SELECT id, seq::text AS seq, aggregate_id, published_at FROM outbox_messages
      WHERE aggregate_id IN (${walletIds.map(() => '?').join(',')}) ORDER BY outbox_messages.seq`,
    walletIds,
  );

const allPublished = async (walletIds: string[]): Promise<boolean> => {
  const rows = await outboxOf(walletIds);
  return rows.length > 0 && rows.every((row) => row.published_at !== null);
};

interface Received {
  eventId: string;
  aggregateId: string;
}

function parse(messages: { Body?: string | undefined }[]): Received[] {
  return messages.map((message) => {
    const body = JSON.parse(message.Body ?? '{}') as Received;
    return { eventId: body.eventId, aggregateId: body.aggregateId };
  });
}

/** Ordem de chegada por wallet, sem as repetições do mesmo `eventId`. */
function firstSeenByWallet(received: Received[]): Map<string, string[]> {
  const seen = new Set<string>();
  const byWallet = new Map<string, string[]>();
  for (const { eventId, aggregateId } of received) {
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    byWallet.set(aggregateId, [...(byWallet.get(aggregateId) ?? []), eventId]);
  }
  return byWallet;
}

describe('OutboxPublisherWorker (PostgreSQL + LocalStack reais)', () => {
  test('two publishers on the same outbox: nothing lost, per-wallet order kept, duplicates only share the eventId', async () => {
    queues = await createTestQueues();
    await settleForeignOutbox();
    const wallets = await Promise.all([walletWithEvents(5), walletWithEvents(5), walletWithEvents(5), walletWithEvents(5)]);
    const ids = wallets.map((wallet) => wallet.id);
    const expected = await outboxOf(ids);
    expect(expected).toHaveLength(4 * (2 + 2 * 5));

    workerFor('instance-a').start();
    workerFor('instance-b').start();
    await waitFor(() => allPublished(ids), { timeoutMs: 20_000, message: 'outbox to be fully published' });

    const messages = await collect(queues, queues.eventsUrl, (got) => new Set(parse(got).map((m) => m.eventId)).size >= expected.length, 20_000);
    const received = parse(messages);

    // nada perdido
    expect(new Set(received.map((m) => m.eventId))).toEqual(new Set(expected.map((row) => row.id)));
    // duplicatas só com o mesmo eventId (a mensagem inteira é determinada por ele)
    const bodies = new Map<string, string>();
    for (const message of messages) {
      const { eventId } = JSON.parse(message.Body ?? '{}') as Received;
      expect(bodies.get(eventId) ?? message.Body).toBe(message.Body ?? '');
      bodies.set(eventId, message.Body ?? '');
    }
    // ordem por wallet = ordem de `seq`
    const arrival = firstSeenByWallet(received);
    for (const wallet of wallets) {
      const inSeq = expected.filter((row) => row.aggregate_id === wallet.id).map((row) => row.id);
      expect(arrival.get(wallet.id)).toEqual(inSeq);
      await assertLedgerConsistency(app, wallet.id);
    }
    // todos marcados e sem lease residual
    const [leased] = await sql<{ n: string }>(app, `SELECT count(*)::text AS n FROM outbox_messages WHERE aggregate_id IN (${ids.map(() => '?').join(',')}) AND locked_by IS NOT NULL AND published_at IS NULL`, ids);
    expect(Number(leased!.n)).toBe(0);
  });

  test('failure on a wallet head: its later events wait while the other wallets keep publishing', async () => {
    queues = await createTestQueues();
    await settleForeignOutbox();
    const [blocked, healthy] = await Promise.all([walletWithEvents(3), walletWithEvents(3)]);
    const rows = await outboxOf([blocked.id, healthy.id]);
    const blockedRows = rows.filter((row) => row.aggregate_id === blocked.id);
    const head = blockedRows[0]!;

    const real = new SqsEventPublisher(queues.client, queues.eventsUrl);
    let broken = true;
    const flaky: EventPublisher = {
      publishBatch: async (messages: readonly OutboxMessage[]) => {
        // O SQS recusa a cabeça da wallet bloqueada e nada atrás dela chega à fila.
        const held = broken ? messages.filter((message) => message.aggregateId === blocked.id) : [];
        const rest = messages.filter((message) => !held.includes(message));
        const rejected = new Set(broken ? [head.id].filter((id) => messages.some((m) => m.id === id)) : []);
        if (rest.length > 0) for (const id of await real.publishBatch(rest)) rejected.add(id);
        return rejected;
      },
    };
    const worker = workerFor('instance-a', { publisher: flaky });

    await worker.runOnce();
    await worker.runOnce();
    const midway = await outboxOf([blocked.id, healthy.id]);
    expect(midway.filter((row) => row.aggregate_id === healthy.id).every((row) => row.published_at !== null)).toBe(true);
    // a cabeça falhou: nada atrás dela saiu
    expect(midway.filter((row) => row.aggregate_id === blocked.id).every((row) => row.published_at === null)).toBe(true);
    const [retry] = await sql<{ attempts: number; last_error: string | null }>(app, 'SELECT attempts, last_error FROM outbox_messages WHERE id = ?', [head.id]);
    expect(retry!.attempts).toBeGreaterThanOrEqual(1);
    expect(retry!.last_error).toBeTruthy();

    broken = false;
    await waitFor(
      async () => {
        await worker.runOnce();
        return allPublished([blocked.id, healthy.id]);
      },
      { timeoutMs: 15_000, intervalMs: 300, message: 'blocked wallet to resume after backoff' },
    );

    const messages = await collect(queues, queues.eventsUrl, (got) => new Set(parse(got).map((m) => m.eventId)).size >= rows.length, 20_000);
    const arrival = firstSeenByWallet(parse(messages));
    expect(arrival.get(blocked.id)).toEqual(blockedRows.map((row) => row.id)); // a cabeça sai primeiro
    expect(arrival.get(healthy.id)).toEqual(rows.filter((row) => row.aggregate_id === healthy.id).map((row) => row.id));
  });

  test('publisher dies after publishing and before marking: the lease expires and the event is republished', async () => {
    queues = await createTestQueues();
    await settleForeignOutbox();
    const wallet = await walletWithEvents(2);
    const expected = await outboxOf([wallet.id]);

    const faults = new CrashOnceFaultInjector();
    faults.arm('crash_after_publish_before_mark');
    const victim = workerFor('victim', { faults, options: { leaseMs: 1_000 } });
    await expect(victim.runOnce()).rejects.toBeInstanceOf(SimulatedCrashError);

    // publicou, mas não marcou; o lease da vítima ainda vale
    expect((await outboxOf([wallet.id])).every((row) => row.published_at === null)).toBe(true);
    const survivor = workerFor('survivor', { options: { leaseMs: 1_000 } });
    expect(await survivor.runOnce()).toBe(0);

    await sleep(1_200); // o lease expira
    await waitFor(
      async () => {
        await survivor.runOnce();
        return allPublished([wallet.id]);
      },
      { timeoutMs: 10_000, intervalMs: 200, message: 'event to be republished after lease expiry' },
    );

    const messages = await collect(queues, queues.eventsUrl, (got) => new Set(parse(got).map((m) => m.eventId)).size >= expected.length, 15_000);
    const received = parse(messages);
    expect(new Set(received.map((m) => m.eventId))).toEqual(new Set(expected.map((row) => row.id)));
    expect(firstSeenByWallet(received).get(wallet.id)).toEqual(expected.map((row) => row.id));
    await assertLedgerConsistency(app, wallet.id);
  });

  test('a leased head is not claimed by another instance until the lease expires', async () => {
    queues = await createTestQueues();
    await settleForeignOutbox();
    const wallet = await walletWithEvents(1);
    const now = new Date();
    const first = await services.store.claim({ instanceId: 'a', now, leaseMs: 60_000, headLimit: 10, perWalletLimit: 20 });
    const second = await services.store.claim({ instanceId: 'b', now, leaseMs: 60_000, headLimit: 10, perWalletLimit: 20 });
    expect(first.length).toBeGreaterThan(0);
    expect(second.filter((item) => item.message.aggregateId === wallet.id)).toHaveLength(0);
  });
});
