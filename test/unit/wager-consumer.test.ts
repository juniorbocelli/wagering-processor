import { afterEach, describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  TransientInfrastructureError,
  ValidationError,
  WalletNotFoundError,
} from '../../src/application/errors.ts';
import type {
  DeadLetterMessage,
  DeadLetterPublisher,
  QueueGateway,
  ReceivedMessage,
  ReceiveOptions,
} from '../../src/application/ports/messaging.ts';
import type { Metrics } from '../../src/application/ports/observability.ts';
import { SimulatedCrashError, type FaultInjector, type FaultPoint } from '../../src/application/ports/runtime.ts';
import type {
  ProcessContext,
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../src/application/use-cases/process-wager-transaction.ts';
import type { WagerTransaction } from '../../src/domain/wagering/wager-transaction.ts';
import {
  classifyError,
  parseEnvelope,
  retryDelaySeconds,
  UNPARSEABLE_DLQ_GROUP,
  WagerTransactionConsumer,
  type WagerConsumerOptions,
} from '../../src/interfaces/sqs/wager-transaction-consumer.ts';
import { waitFor } from '../support/wait.ts';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

const envelope = (messageId: string, over: Record<string, unknown> = {}) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: `ext-${messageId}`,
    idempotencyKey: `provider-a:ext-${messageId}`,
    playerId: 'player-1',
    walletId: WALLET,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...over,
  },
});

describe('parseEnvelope', () => {
  test('accepts the §10 envelope and builds the use-case command', () => {
    const parsed = parseEnvelope(JSON.stringify(envelope('msg-1', { referenceExternalTransactionId: 'ref-1' })));
    expect(parsed).toEqual({
      ok: true,
      value: {
        messageId: 'msg-1',
        command: expect.objectContaining({
          providerId: 'provider-a',
          idempotencyKey: 'provider-a:ext-msg-1',
          walletId: WALLET,
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: 'ref-1',
        }),
      },
    });
  });

  test.each([
    ['not JSON', '{oops'],
    ['an empty body', ''],
    ['an array', '[]'],
    ['an unknown type', JSON.stringify({ ...envelope('m'), type: 'Something' })],
    ['a missing messageId', JSON.stringify({ ...envelope('m'), messageId: undefined })],
    ['a numeric amount (money must be a decimal string)', JSON.stringify(envelope('m', { money: { amount: 25, currency: 'BRL' } }))],
    ['an unknown field in data', JSON.stringify(envelope('m', { extra: true }))],
    ['a missing walletId', JSON.stringify(envelope('m', { walletId: undefined }))],
  ])('rejects %s', (_label, body) => {
    const parsed = parseEnvelope(body);
    expect(parsed.ok).toBe(false);
  });
});

describe('classifyError (ADR-004 §3)', () => {
  test.each([
    [new ValidationError([{ field: 'kind', message: 'x' }]), 'VALIDATION_ERROR'],
    [new WalletNotFoundError(WALLET), 'WALLET_NOT_FOUND'],
    [new IdempotencyConflictError('IDEMPOTENCY_KEY_REUSED', 'provider-a'), 'IDEMPOTENCY_KEY_REUSED'],
    [new IdempotencyConflictError('EXTERNAL_TRANSACTION_ID_REUSED', 'provider-a'), 'EXTERNAL_TRANSACTION_ID_REUSED'],
    [new InboxPayloadMismatchError('c', 'm'), 'INBOX_PAYLOAD_MISMATCH'],
  ])('%p is permanent', (error, errorCode) => {
    expect(classifyError(error)).toEqual({ kind: 'permanent', errorCode });
  });

  test.each([
    ['a transient infrastructure error', new TransientInfrastructureError('db down')],
    ['an unclassified Error', new Error('who knows')],
    ['a thrown string', 'boom'],
    ['undefined', undefined],
  ])('%s is transient — an unknown error is never dead-lettered by default', (_label, error) => {
    expect(classifyError(error)).toEqual({ kind: 'transient' });
  });
});

describe('retryDelaySeconds', () => {
  test('doubles per receive (2 s, 4 s, 8 s…) and is capped at 5 minutes', () => {
    const noJitter = () => 1;
    expect([1, 2, 3, 4].map((n) => retryDelaySeconds(n, 2, 300, noJitter))).toEqual([2, 4, 8, 16]);
    expect(retryDelaySeconds(30, 2, 300, noJitter)).toBe(300);
  });

  test('jitter only shortens the delay (50%–100%) and never goes below 1 s', () => {
    expect(retryDelaySeconds(3, 2, 300, () => 0)).toBe(4);
    expect(retryDelaySeconds(3, 2, 300, () => 1)).toBe(8);
    expect(retryDelaySeconds(1, 2, 300, () => 0)).toBe(1);
  });
});

// ---- consumidor com fila e DLQ em memória (a fila real é exercitada nos testes de integração) ----

class FakeQueue implements QueueGateway {
  readonly batches: ReceivedMessage[][] = [];

  constructor(readonly log: string[] = []) {}

  receive(options: ReceiveOptions): Promise<ReceivedMessage[]> {
    const batch = this.batches.shift();
    if (batch !== undefined) return Promise.resolve(batch);
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
  delete(receiptHandle: string): Promise<void> {
    this.log.push(`delete:${receiptHandle}`);
    return Promise.resolve();
  }
  changeVisibility(receiptHandle: string, seconds: number): Promise<void> { // check-money:allow
    this.log.push(`visibility:${receiptHandle}:${seconds}`);
    return Promise.resolve();
  }
}

class FakeDlq implements DeadLetterPublisher {
  readonly sent: DeadLetterMessage[] = [];
  failing = false;
  constructor(private readonly log: string[]) {}
  send(message: DeadLetterMessage): Promise<void> {
    if (this.failing) return Promise.reject(new Error('dlq unavailable'));
    this.sent.push(message);
    this.log.push(`dlq:${message.attributes.sourceMessageId}`);
    return Promise.resolve();
  }
}

let counter = 0; // check-money:allow
function received(body: string, groupId: string | undefined = 'group-1', receiveCount = 1): ReceivedMessage { // check-money:allow
  counter += 1;
  return { sqsMessageId: `sqs-${counter}`, receiptHandle: `rh-${counter}`, body, groupId, receiveCount };
}

const duplicate: ProcessWagerTransactionResult = { kind: 'duplicate-delivery' };

class CountingMetrics implements Pick<Metrics, 'sqsRetry' | 'sqsDeadLettered'> {
  retries = 0; // check-money:allow
  deadLettered: string[] = [];
  sqsRetry(): void {
    this.retries += 1;
  }
  sqsDeadLettered(errorCode: string): void {
    this.deadLettered.push(errorCode);
  }
}

const FAST: Partial<WagerConsumerOptions> = {
  waitTimeSeconds: 1,
  heartbeatIntervalMs: 60_000,
  gracePeriodMs: 100,
};

function setup(
  execute: (command: ProcessWagerTransactionCommand, ctx: ProcessContext) => Promise<ProcessWagerTransactionResult>,
  options: { faults?: FaultInjector; options?: Partial<WagerConsumerOptions>; log?: string[] } = {},
) {
  const queue = new FakeQueue(options.log);
  const dlq = new FakeDlq(queue.log);
  const metrics = new CountingMetrics();
  const consumer = new WagerTransactionConsumer({
    queue,
    deadLetters: dlq,
    useCase: { execute },
    options: { ...FAST, ...options.options },
    metrics: metrics as unknown as Metrics,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    random: () => 1,
  });
  return { queue, dlq, metrics, consumer };
}

const consumers: WagerTransactionConsumer[] = [];
afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()));
});

function run(
  execute: Parameters<typeof setup>[0],
  options?: Parameters<typeof setup>[1],
) {
  const harness = setup(execute, options);
  consumers.push(harness.consumer);
  return harness;
}

describe('WagerTransactionConsumer', () => {
  test('acknowledges only AFTER the use case commits, with the inbox context of the message', async () => {
    const order: string[] = [];
    let seen: { command: ProcessWagerTransactionCommand; ctx: ProcessContext } | undefined;
    const h = run(
      (command, ctx) => {
        order.push('execute');
        seen = { command, ctx };
        return Promise.resolve(duplicate);
      },
      { log: order },
    );
    const message = received(JSON.stringify(envelope('msg-1')));
    h.queue.batches.push([message]);
    h.consumer.start();

    await waitFor(() => order.includes(`delete:${message.receiptHandle}`));
    expect(order).toEqual(['execute', `delete:${message.receiptHandle}`]);
    expect(seen?.ctx.inbox).toEqual({ consumerName: 'wager-transactions', messageId: 'msg-1' });
    expect(seen?.command.walletId).toBe(WALLET);
  });

  test('replay and duplicate delivery are acknowledged without retries or DLQ', async () => {
    const h = run((_command, ctx) =>
      Promise.resolve(
        ctx.inbox?.messageId === 'msg-replay'
          ? ({ kind: 'replay', transaction: { id: 't-1', status: 'PROCESSED' } as unknown as WagerTransaction })
          : duplicate,
      ),
    );
    const a = received(JSON.stringify(envelope('msg-replay')));
    const b = received(JSON.stringify(envelope('msg-dup')), 'group-2');
    h.queue.batches.push([a, b]);
    h.consumer.start();

    await waitFor(() => h.queue.log.length >= 2);
    expect(h.queue.log.sort()).toEqual([`delete:${a.receiptHandle}`, `delete:${b.receiptHandle}`].sort());
    expect(h.metrics.retries).toBe(0);
    expect(h.dlq.sent).toHaveLength(0);
  });

  test.each([
    ['ValidationError', () => new ValidationError([{ field: 'kind', message: 'OPENING is internal' }]), 'VALIDATION_ERROR'],
    ['WalletNotFoundError', () => new WalletNotFoundError(WALLET), 'WALLET_NOT_FOUND'],
    ['IdempotencyConflictError', () => new IdempotencyConflictError('IDEMPOTENCY_KEY_REUSED', 'provider-a'), 'IDEMPOTENCY_KEY_REUSED'],
    ['InboxPayloadMismatchError', () => new InboxPayloadMismatchError('c', 'm'), 'INBOX_PAYLOAD_MISMATCH'],
  ])('permanent error (%s): explicit DLQ send first, THEN delete, original body and group', async (_name, makeError, code) => {
    const h = run(() => Promise.reject(makeError()));
    const message = received(JSON.stringify(envelope('msg-1')), WALLET, 3);
    h.queue.batches.push([message]);
    h.consumer.start();

    await waitFor(() => h.queue.log.includes(`delete:${message.receiptHandle}`));
    expect(h.queue.log).toEqual([`dlq:${message.sqsMessageId}`, `delete:${message.receiptHandle}`]);
    expect(h.dlq.sent[0]).toMatchObject({
      body: message.body,
      groupId: WALLET,
      deduplicationId: message.sqsMessageId,
      attributes: { errorCode: code, sourceMessageId: message.sqsMessageId, receiveCount: 3 },
    });
    expect(h.metrics.deadLettered).toEqual([code]);
  });

  test('a body that cannot be parsed goes to the DLQ with VALIDATION_ERROR, verbatim; no group → dlq-unparseable', async () => {
    const h = run(() => Promise.resolve(duplicate));
    const message: ReceivedMessage = { ...received('{not json'), groupId: undefined };
    h.queue.batches.push([message]);
    h.consumer.start();

    await waitFor(() => h.queue.log.includes(`delete:${message.receiptHandle}`));
    expect(h.dlq.sent[0]).toMatchObject({
      body: '{not json',
      groupId: UNPARSEABLE_DLQ_GROUP,
      attributes: { errorCode: 'VALIDATION_ERROR' },
    });
  });

  test('DLQ unavailable: the message is NOT deleted and is retried with backoff instead', async () => {
    const h = run(() => Promise.reject(new WalletNotFoundError(WALLET)));
    h.dlq.failing = true;
    const message = received(JSON.stringify(envelope('msg-1')), WALLET, 2);
    h.queue.batches.push([message]);
    h.consumer.start();

    await waitFor(() => h.queue.log.length > 0);
    expect(h.queue.log).toEqual([`visibility:${message.receiptHandle}:4`]);
    expect(h.queue.log.some((entry) => entry.startsWith('delete:'))).toBe(false);
    expect(h.metrics.retries).toBe(1);
  });

  test.each([
    ['transient infrastructure error', () => new TransientInfrastructureError('db down')],
    ['unclassified error', () => new Error('unexpected')],
  ])('%s: no ack, visibility backoff from the receive count', async (_name, makeError) => {
    const h = run(() => Promise.reject(makeError()));
    const message = received(JSON.stringify(envelope('msg-1')), WALLET, 3);
    h.queue.batches.push([message]);
    h.consumer.start();

    await waitFor(() => h.queue.log.length > 0);
    expect(h.queue.log).toEqual([`visibility:${message.receiptHandle}:8`]);
    expect(h.metrics.retries).toBe(1);
    expect(h.dlq.sent).toHaveLength(0);
  });

  test('FIFO order inside a group: after a transient failure the next messages of the group are not run and wait the same backoff as the failed one', async () => {
    const executed: string[] = [];
    const h = run((_command, ctx) => {
      const id = ctx.inbox?.messageId ?? '';
      executed.push(id);
      return id === 'a1' ? Promise.reject(new TransientInfrastructureError('db down')) : Promise.resolve(duplicate);
    });
    const a1 = received(JSON.stringify(envelope('a1')), 'wallet-a');
    const a2 = received(JSON.stringify(envelope('a2')), 'wallet-a');
    const a3 = received(JSON.stringify(envelope('a3')), 'wallet-a');
    const b1 = received(JSON.stringify(envelope('b1')), 'wallet-b');
    h.queue.batches.push([a1, a2, b1, a3]);
    h.consumer.start();

    await waitFor(() => h.queue.log.length >= 4);
    expect(executed.sort()).toEqual(['a1', 'b1']); // a2/a3 never ran
    expect(h.queue.log).toContain(`visibility:${a2.receiptHandle}:2`);
    expect(h.queue.log).toContain(`visibility:${a3.receiptHandle}:2`); // same backoff as the failed head a1
    expect(h.queue.log).toContain(`delete:${b1.receiptHandle}`); // other groups are unaffected
    expect(h.queue.log).not.toContain(`delete:${a2.receiptHandle}`);
  });

  test('messages of the same group run strictly in order', async () => {
    const executed: string[] = [];
    const h = run(async (_command, ctx) => {
      const id = ctx.inbox?.messageId ?? '';
      executed.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, id === 'g1' ? 30 : 1));
      executed.push(`end:${id}`);
      return duplicate;
    });
    h.queue.batches.push([
      received(JSON.stringify(envelope('g1')), 'wallet-a'),
      received(JSON.stringify(envelope('g2')), 'wallet-a'),
    ]);
    h.consumer.start();

    await waitFor(() => executed.length === 4);
    expect(executed).toEqual(['start:g1', 'end:g1', 'start:g2', 'end:g2']);
  });

  test('a crash after the commit and before the ack leaves the message untouched (in flight)', async () => {
    const faults: FaultInjector = {
      trigger(point: FaultPoint) {
        if (point === 'crash_after_commit_before_ack') throw new SimulatedCrashError(point);
      },
    };
    const h = run(() => Promise.resolve(duplicate), { faults });
    const message = received(JSON.stringify(envelope('msg-1')));
    h.queue.batches.push([message]);
    h.consumer.start();

    await waitFor(() => h.consumer.crashed);
    expect(h.queue.log).toEqual([]); // no delete, no visibility change: the redelivery is absorbed by the inbox
  });

  test('stop(): not-yet-started messages are returned to the queue immediately', async () => {
    let release: (() => void) | undefined;
    const h = run((_command, ctx) =>
      ctx.inbox?.messageId === 'slow'
        ? new Promise((resolve) => {
            release = () => resolve(duplicate);
          })
        : Promise.resolve(duplicate),
    );
    const slow = received(JSON.stringify(envelope('slow')), 'wallet-a');
    const queued = received(JSON.stringify(envelope('queued')), 'wallet-a');
    h.queue.batches.push([slow, queued]);
    h.consumer.start();
    await waitFor(() => release !== undefined);

    const stopping = h.consumer.stop();
    await waitFor(() => h.queue.log.includes(`visibility:${queued.receiptHandle}:0`));
    release?.();
    await stopping;

    expect(h.queue.log).toContain(`delete:${slow.receiptHandle}`); // in-flight work completed and acked
    expect(h.queue.log).not.toContain(`delete:${queued.receiptHandle}`);
  });

  test('stop(): work that outlives the grace period is returned to the queue (visibility 0)', async () => {
    let started = false;
    const h = run(() => {
      started = true;
      return new Promise<ProcessWagerTransactionResult>(() => undefined); // never finishes
    });
    const message = received(JSON.stringify(envelope('stuck')));
    h.queue.batches.push([message]);
    h.consumer.start();
    await waitFor(() => started);

    await h.consumer.stop();
    expect(h.queue.log).toEqual([`visibility:${message.receiptHandle}:0`]);
  });
});
