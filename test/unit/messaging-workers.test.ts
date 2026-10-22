import { describe, expect, test } from 'bun:test';
import type {
  ClaimedOutboxMessage,
  EventPublisher,
  OutboxStore,
  RetentionStore,
} from '../../src/application/ports/messaging.ts';
import { NOOP_METRICS, type Metrics } from '../../src/application/ports/observability.ts';
import { SimulatedCrashError, type FaultInjector, type FaultPoint } from '../../src/application/ports/runtime.ts';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.ts';
import { EnvFaultInjector, faultInjectorFromEnv } from '../../src/infrastructure/fault-injection.ts';
import {
  OutboxPublisherWorker,
  type OutboxPublisherOptions,
} from '../../src/interfaces/workers/outbox-publisher-worker.ts';
import { PollingLoop } from '../../src/interfaces/workers/polling-loop.ts';
import { RetentionWorker } from '../../src/interfaces/workers/retention-worker.ts';
import { buildUnitHarness, FakeClock } from '../support/unit-harness.ts';
import { waitFor } from '../support/wait.ts';

// ---- outbox publisher ---------------------------------------------------------------------

const OPTIONS: OutboxPublisherOptions = {
  instanceId: 'instance-1',
  pollIntervalMs: 10,
  leaseMs: 30_000,
  headLimit: 10,
  perWalletLimit: 20,
  stuckAttempts: 10,
};

let seqCounter = 0n;
function event(aggregateId: string, id: string, attempts = 0): ClaimedOutboxMessage { // check-money:allow
  seqCounter += 1n;
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    seq: seqCounter,
    message: OutboxMessage.rehydrate({
      id,
      aggregateId,
      eventType: 'WalletBalanceChanged',
      eventVersion: 1,
      payload: { eventId: id },
      occurredAt: at,
      attempts,
      nextAttemptAt: at,
      lockedUntil: new Date(at.getTime() + 30_000),
      lockedBy: OPTIONS.instanceId,
      publishedAt: undefined,
      lastError: undefined,
    }),
  };
}

class FakeOutboxStore implements OutboxStore {
  claimed: ClaimedOutboxMessage[] = [];
  published: string[] = [];
  retried: OutboxMessage[] = [];
  released: string[] = [];

  claim(): Promise<ClaimedOutboxMessage[]> {
    const next = this.claimed;
    this.claimed = [];
    return Promise.resolve(next);
  }
  markPublished(ids: readonly string[]): Promise<number> {
    this.published.push(...ids);
    return Promise.resolve(ids.length);
  }
  saveRetry(message: OutboxMessage): Promise<void> {
    this.retried.push(message);
    return Promise.resolve();
  }
  releaseLease(ids: readonly string[]): Promise<void> {
    this.released.push(...ids);
    return Promise.resolve();
  }
  lagSeconds(): Promise<number> { // check-money:allow
    return Promise.resolve(0);
  }
}

class FakePublisher implements EventPublisher {
  readonly batches: string[][] = [];
  rejected = new Set<string>();
  failure: Error | undefined;

  publishBatch(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>> {
    this.batches.push(messages.map((m) => m.id));
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(new Set(messages.filter((m) => this.rejected.has(m.id)).map((m) => m.id)));
  }
}

function outbox(overrides: { faults?: FaultInjector; metrics?: Metrics } = {}) {
  const store = new FakeOutboxStore();
  const publisher = new FakePublisher();
  const clock = new FakeClock();
  const worker = new OutboxPublisherWorker({
    store,
    publisher,
    clock,
    options: OPTIONS,
    random: () => 0,
    ...(overrides.faults === undefined ? {} : { faults: overrides.faults }),
    ...(overrides.metrics === undefined ? {} : { metrics: overrides.metrics }),
  });
  return { store, publisher, clock, worker };
}

describe('OutboxPublisherWorker', () => {
  test('publishes each wallet in seq order, one event per SQS call, and marks only what SQS accepted', async () => {
    const { store, publisher, worker } = outbox();
    const a = Array.from({ length: 12 }, (_, i) => event('wallet-a', `a${i + 1}`));
    const b = [event('wallet-b', 'b1'), event('wallet-b', 'b2')];
    store.claimed = [...a, ...b];

    expect(await worker.runOnce()).toBe(14);

    const batchesOf = (prefix: string) => publisher.batches.filter((ids) => ids[0]?.startsWith(prefix));
    expect(batchesOf('a')).toEqual(a.map((e) => [e.message.id]));
    expect(batchesOf('b')).toEqual([['b1'], ['b2']]);
    expect(store.published.sort()).toEqual([...a, ...b].map((e) => e.message.id).sort());
    expect(store.retried).toEqual([]);
    expect(store.released).toEqual([]);
  });

  test('a failure on the head holds the whole wallet behind it; other wallets are unaffected', async () => {
    const { store, publisher, worker } = outbox();
    publisher.rejected = new Set(['a1']);
    store.claimed = [event('wallet-a', 'a1'), event('wallet-a', 'a2'), event('wallet-a', 'a3'), event('wallet-b', 'b1')];

    await worker.runOnce();

    expect(store.published).toEqual(['b1']);
    expect(store.retried.map((m) => [m.id, m.attempts])).toEqual([['a1', 1]]);
    expect(store.retried[0]?.nextAttemptAt.getTime()).toBeGreaterThan(new FakeClock().now().getTime());
    expect(store.released.sort()).toEqual(['a2', 'a3']); // lease only: they stay behind a1
  });

  test('a failure in the middle publishes the earlier events, retries that one, releases the rest', async () => {
    const { store, publisher, worker } = outbox();
    publisher.rejected = new Set(['a2']);
    store.claimed = [event('wallet-a', 'a1'), event('wallet-a', 'a2'), event('wallet-a', 'a3')];

    await worker.runOnce();

    expect(store.published).toEqual(['a1']);
    expect(store.retried.map((m) => m.id)).toEqual(['a2']);
    expect(store.released).toEqual(['a3']);
  });

  test('a failure in an earlier event releases the lease of the later events of the wallet', async () => {
    const { store, publisher, worker } = outbox();
    publisher.rejected = new Set(['a3']);
    const a = Array.from({ length: 12 }, (_, i) => event('wallet-a', `a${i + 1}`));
    store.claimed = a;

    await worker.runOnce();

    expect(publisher.batches).toHaveLength(3); // a1 and a2 sent and accepted, a3 sent and rejected, rest not sent
    expect(store.published).toEqual(['a1', 'a2']);
    expect(store.retried.map((m) => m.id)).toEqual(['a3']);
    expect(store.released.sort()).toEqual(['a10', 'a11', 'a12', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']);
  });

  test('an exception from SQS fails the head of the wallet and never drops the event', async () => {
    const { store, publisher, worker } = outbox();
    publisher.failure = new Error('SQS unavailable');
    store.claimed = [event('wallet-a', 'a1'), event('wallet-a', 'a2')];

    await worker.runOnce();

    expect(store.published).toEqual([]);
    expect(store.retried.map((m) => [m.id, m.lastError])).toEqual([['a1', 'SQS unavailable']]);
    expect(store.released).toEqual(['a2']);
  });

  test('outbox_stuck_total is signalled once, when the attempt threshold is crossed', async () => {
    let stuck = 0; // check-money:allow
    const metrics: Metrics = { ...NOOP_METRICS, outboxStuck: () => void (stuck += 1) };
    const { store, publisher, worker } = outbox({ metrics });
    publisher.rejected = new Set(['a1']);

    store.claimed = [event('wallet-a', 'a1', 8)]; // 8 → 9: below the threshold
    await worker.runOnce();
    expect(stuck).toBe(0);

    store.claimed = [event('wallet-a', 'a1', 9)]; // 9 → 10: crosses it
    await worker.runOnce();
    expect(stuck).toBe(1);

    store.claimed = [event('wallet-a', 'a1', 10)]; // 10 → 11: still retried, not counted again
    await worker.runOnce();
    expect(stuck).toBe(1);
    expect(store.retried.at(-1)?.attempts).toBe(11); // never discarded
  });

  test('a crash between publishing and marking leaves the lease untouched (republished later)', async () => {
    const faults: FaultInjector = {
      trigger(point: FaultPoint) {
        if (point === 'crash_after_publish_before_mark') throw new SimulatedCrashError(point);
      },
    };
    const { store, publisher, worker } = outbox({ faults });
    store.claimed = [event('wallet-a', 'a1')];

    await expect(worker.runOnce()).rejects.toBeInstanceOf(SimulatedCrashError);
    expect(publisher.batches).toEqual([['a1']]); // it was sent...
    expect(store.published).toEqual([]); // ...but never marked, retried or released
    expect(store.retried).toEqual([]);
    expect(store.released).toEqual([]);
  });

  test('an empty claim publishes nothing', async () => {
    const { publisher, worker } = outbox();
    expect(await worker.runOnce()).toBe(0);
    expect(publisher.batches).toEqual([]);
  });

  test('the polling loop keeps draining and halts without cleanup on a simulated crash', async () => {
    const faults: FaultInjector = {
      trigger(point: FaultPoint) {
        throw new SimulatedCrashError(point);
      },
    };
    const { store, worker } = outbox({ faults });
    store.claimed = [event('wallet-a', 'a1')];
    worker.start();
    await waitFor(() => worker.crashed);
    await worker.stop();
    expect(store.published).toEqual([]);
  });
});

// ---- retenção -----------------------------------------------------------------------------

class FakeRetentionStore implements RetentionStore {
  outboxCalls: { cutoff: Date; batchSize: number }[] = [];
  inboxCalls: { cutoff: Date; batchSize: number }[] = [];
  constructor(
    private outboxBatches: number[], // check-money:allow
    private inboxBatches: number[], // check-money:allow
  ) {}
  purgePublishedOutbox(cutoff: Date, batchSize: number): Promise<number> { // check-money:allow
    this.outboxCalls.push({ cutoff, batchSize });
    return Promise.resolve(this.outboxBatches.shift() ?? 0);
  }
  purgeProcessedInbox(cutoff: Date, batchSize: number): Promise<number> { // check-money:allow
    this.inboxCalls.push({ cutoff, batchSize });
    return Promise.resolve(this.inboxBatches.shift() ?? 0);
  }
}

describe('RetentionWorker', () => {
  const options = { intervalMs: 60_000, outboxRetentionHours: 72, inboxRetentionDays: 7, batchSize: 100 };

  test('cutoffs follow the retention windows (72 h outbox, 7 d inbox) and full batches repeat until a short one', async () => {
    const clock = new FakeClock();
    const store = new FakeRetentionStore([100, 100, 30], [5]);
    const deleted: [string, number][] = []; // check-money:allow
    const metrics: Metrics = { ...NOOP_METRICS, retentionDeleted: (table, rows) => void deleted.push([table, rows]) };
    const worker = new RetentionWorker({ store, clock, options, metrics });

    expect(await worker.runOnce()).toEqual({ outbox: 230, inbox: 5 });

    expect(store.outboxCalls).toHaveLength(3);
    expect(store.inboxCalls).toHaveLength(1);
    const now = clock.now().getTime();
    expect(store.outboxCalls[0]?.cutoff.getTime()).toBe(now - 72 * 3_600_000);
    expect(store.inboxCalls[0]?.cutoff.getTime()).toBe(now - 7 * 86_400_000);
    expect(store.outboxCalls.every((call) => call.batchSize === 100)).toBe(true);
    expect(deleted).toEqual([
      ['outbox_messages', 230],
      ['inbox_messages', 5],
    ]);
  });

  test('nothing eligible: a single query per table and no metric', async () => {
    const store = new FakeRetentionStore([], []);
    let observed = false;
    const metrics: Metrics = { ...NOOP_METRICS, retentionDeleted: () => void (observed = true) };
    const worker = new RetentionWorker({ store, clock: new FakeClock(), options, metrics });
    expect(await worker.runOnce()).toEqual({ outbox: 0, inbox: 0 });
    expect(store.outboxCalls).toHaveLength(1);
    expect(store.inboxCalls).toHaveLength(1);
    expect(observed).toBe(false);
  });
});

// ---- laço de polling e injetor de ambiente ---------------------------------------------------

describe('PollingLoop', () => {
  test('a failing cycle is logged and the loop keeps going; stop() waits for the current cycle', async () => {
    let cycles = 0; // check-money:allow
    const errors: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: string) => void errors.push(message),
      child: () => logger,
    };
    const loop = new PollingLoop({
      name: 'test',
      intervalMs: 5,
      logger,
      tick: () => {
        cycles += 1;
        return cycles === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(false);
      },
    });
    loop.start();
    await waitFor(() => cycles >= 3);
    await loop.stop();
    const after = cycles;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cycles).toBe(after); // stopped for good
    expect(errors).toEqual(['worker cycle failed']);
  });
});

describe('fault injection from the environment', () => {
  test('without FAULT_INJECTION it is the production no-op', () => {
    expect(() => faultInjectorFromEnv({}).trigger('crash_after_commit_before_ack')).not.toThrow();
    expect(() => faultInjectorFromEnv({ FAULT_INJECTION: '' }).trigger('crash_after_publish_before_mark')).not.toThrow();
  });

  test('only the configured point kills the process', () => {
    const kills: string[] = [];
    const injector = new EnvFaultInjector('crash_after_commit_before_ack', () => void kills.push('killed'));
    injector.trigger('crash_after_publish_before_mark');
    injector.trigger('after_ledger_insert');
    expect(kills).toEqual([]);
    injector.trigger('crash_after_commit_before_ack');
    expect(kills).toEqual(['killed']);
  });

  test('an unknown point is a configuration error, not a silent no-op', () => {
    expect(() => faultInjectorFromEnv({ FAULT_INJECTION: 'explode' })).toThrow(/Unknown FAULT_INJECTION/);
  });
});

// ---- reprocessamento: só quando vencido ------------------------------------------------------

describe('ReprocessPendingReferenceUseCase — due check', () => {
  test('an early run is skipped and consumes no attempt; once due it is retried', async () => {
    const h = buildUnitHarness();
    const wallet = await h.openWallet.execute(
      { playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'c' },
    );
    const result = await h.process.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'refund-1',
        idempotencyKey: 'provider-a:refund-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'never',
      },
      { correlationId: 'c' },
    );
    if (result.kind !== 'applied') throw new Error('expected applied');
    const refund = result.transaction;
    expect(refund.status).toBe('PENDING_REFERENCE');

    expect((await h.reprocess.execute(refund.id)).kind).toBe('skipped'); // backoff (1 s) not elapsed
    expect(refund.referenceAttempts).toBe(0);

    h.clock.advance(1_000);
    expect((await h.reprocess.execute(refund.id)).kind).toBe('reprocessed');
    expect(refund.referenceAttempts).toBe(1);

    // a second instance arriving right after sees the new backoff and does not burn an attempt
    expect((await h.reprocess.execute(refund.id)).kind).toBe('skipped');
    expect(refund.referenceAttempts).toBe(1);
  });
});
