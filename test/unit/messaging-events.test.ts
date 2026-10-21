import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.ts';
import { InboxMessage, InvalidInboxStateError } from '../../src/domain/messaging/inbox-message.ts';
import {
  InvalidOutboxStateError,
  OutboxMessage,
  outboxBackoffMs,
} from '../../src/domain/messaging/outbox-message.ts';
import { Wallet } from '../../src/domain/wallet/wallet.ts';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.ts';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domain/events/wager-events.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-10-21T12:00:00.000Z');
const ctx = {
  eventId: 'evt-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: now,
};

function bet(extra: Record<string, unknown> = {}) {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    correlationId: 'corr-1',
    createdAt: now,
    ...extra,
  });
}

describe('InboxMessage', () => {
  const receive = () =>
    InboxMessage.receive({ messageId: 'm1', consumerName: 'wager', payloadHash: 'h', receivedAt: now });

  test('is received unprocessed and can be marked processed once', () => {
    const msg = receive();
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(now);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(now);
    expect(() => msg.markProcessed(now)).toThrow(InvalidInboxStateError);
  });

  test('rejects empty identifiers', () => {
    expect(() =>
      InboxMessage.receive({ messageId: '', consumerName: 'c', payloadHash: 'h', receivedAt: now }),
    ).toThrow(InvalidInboxStateError);
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1', playerId: 'p', currency: 'BRL', balance: brl('75.00'), version: 2, createdAt: now, updatedAt: now,
    });
    const tx = bet();
    tx.markProcessed(undefined, now, wallet.balance);
    return WagerTransactionProcessed.from(tx, wallet, ctx);
  };

  test('enqueue copies the event envelope and is immediately due', () => {
    const msg = OutboxMessage.enqueue(event());
    expect(msg.id).toBe('evt-1');
    expect(msg.aggregateId).toBe('wallet-1');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.eventVersion).toBe(1);
    expect(msg.payload['eventType']).toBe('WagerTransactionProcessed');
    expect(msg.attempts).toBe(0);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(now)).toBe(true);
    expect(msg.isDue(new Date(now.getTime() - 1))).toBe(false);
  });

  test('scheduleRetry is deterministic with an injected random source', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.scheduleRetry(now, 'boom', () => 0); // sem jitter: 2 s
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt.getTime()).toBe(now.getTime() + 2_000);
    expect(msg.lastError).toBe('boom');
    msg.scheduleRetry(now, undefined, () => 0); // 4 s
    expect(msg.nextAttemptAt.getTime()).toBe(now.getTime() + 4_000);
    expect(msg.isDue(now)).toBe(false);
    expect(msg.isDue(new Date(now.getTime() + 4_000))).toBe(true);
  });

  test('backoff doubles, jitters downwards by at most 50% and is capped at 5 minutes', () => {
    expect([0, 1, 2, 3].map((n) => outboxBackoffMs(n, () => 0))).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(outboxBackoffMs(0, () => 0.999999)).toBeGreaterThanOrEqual(1_000);
    expect(outboxBackoffMs(0, () => 0.999999)).toBeLessThan(2_000);
    expect(outboxBackoffMs(30, () => 0)).toBe(300_000);
    expect(outboxBackoffMs(1_000, () => 0)).toBe(300_000);
  });

  test('a lease blocks isDue until it expires', () => {
    const msg = OutboxMessage.rehydrate({
      ...{ id: 'e', aggregateId: 'w', eventType: 'X', eventVersion: 1, payload: {}, occurredAt: now, attempts: 0, nextAttemptAt: now, lastError: undefined, publishedAt: undefined },
      lockedUntil: new Date(now.getTime() + 30_000),
      lockedBy: 'instance-1',
    });
    expect(msg.isDue(now)).toBe(false);
    expect(msg.isDue(new Date(now.getTime() + 30_001))).toBe(true);
  });

  test('markPublished is terminal and clears the lease', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(now);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(now)).toBe(false);
    expect(() => msg.markPublished(now)).toThrow(InvalidOutboxStateError);
    expect(() => msg.scheduleRetry(now)).toThrow(InvalidOutboxStateError);
  });
});

describe('Integration events', () => {
  test('WagerTransactionProcessed carries MoneyProps strings and the envelope fields', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1', playerId: 'player-1', currency: 'BRL', balance: brl('975.00'), version: 3, createdAt: now, updatedAt: now,
    });
    const tx = bet();
    tx.markProcessed(undefined, now, wallet.balance);
    const json = WagerTransactionProcessed.from(tx, wallet, ctx).toJSON();
    expect(json).toMatchObject({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: now.toISOString(),
      version: 1,
    });
    expect(json.data).toMatchObject({
      transactionId: 'tx-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '975.00', currency: 'BRL' },
      referenceTransactionId: null,
      walletVersion: 3,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('causationId is omitted when absent', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1', playerId: 'p', currency: 'BRL', balance: brl('1.00'), version: 1, createdAt: now, updatedAt: now,
    });
    const tx = bet();
    tx.markProcessed(undefined, now, wallet.balance);
    const noCausation = { eventId: 'evt-2', correlationId: 'corr-1', occurredAt: now };
    const json = WagerTransactionProcessed.from(tx, wallet, noCausation).toJSON();
    expect('causationId' in json).toBe(false);
  });

  test('WagerTransactionRejected exposes the failure code', () => {
    const tx = bet();
    tx.reject('INSUFFICIENT_FUNDS');
    const json = WagerTransactionRejected.from(tx, now, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(json.data.rejectedAt).toBe(now.toISOString());
  });

  test('WalletBalanceChanged follows the literal §11 data shape', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1', playerId: 'p', initialBalance: brl('100.00'), at: now,
      opening: { transactionId: 'tx-open', entryId: 'e-open' },
    });
    const entry = wallet.debit({ entryId: 'e1', transactionId: 'tx-1', money: brl('25.00'), at: now });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(openingEntry).toBeDefined();
    expect(json.aggregateId).toBe('wallet-1');
    expect(json.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('WagerTransactionPendingReference carries the reference and next attempt', () => {
    const tx = bet({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0', id: 'tx-r' });
    tx.markPendingReference(new Date(now.getTime() + 1000));
    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.data).toMatchObject({
      transactionId: 'tx-r',
      referenceExternalTransactionId: 'ext-0',
      nextAttemptAt: new Date(now.getTime() + 1000).toISOString(),
      money: { amount: '25.00', currency: 'BRL' },
    });
  });
});
