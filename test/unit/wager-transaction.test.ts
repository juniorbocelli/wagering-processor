import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.ts';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction.ts';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../src/domain/wagering/wager-transaction.ts';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wagering/wager-transaction-kind.ts';
import { FAILURE_CODES, isFailureCode } from '../../src/domain/wagering/failure-code.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-21T12:00:00.000Z');
const later = new Date('2026-10-21T12:00:05.000Z');

function props(over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
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
    createdAt: at,
    ...over,
  };
}

const withRef = (kind: typeof Kind.Refund | typeof Kind.Rollback) =>
  props({ kind, referenceExternalTransactionId: 'ext-0' });

describe('WagerTransaction.create', () => {
  test('is born PENDING with no outcome', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
  });

  test('OPENING cannot come from outside', () => {
    expect(() => WagerTransaction.create(props({ kind: Kind.Opening }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.create(props({ kind, referenceExternalTransactionId: '  ' })),
    ).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(withRef(kind))).not.toThrow();
  });

  test('WIN accepts an optional reference', () => {
    expect(() => WagerTransaction.create(props({ kind: Kind.Win }))).not.toThrow();
    expect(() =>
      WagerTransaction.create(props({ kind: Kind.Win, referenceExternalTransactionId: 'ext-0' })),
    ).not.toThrow();
  });

  test('amount must be positive, except LOSS which accepts zero', () => {
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => WagerTransaction.create(props({ kind, money: brl('0') }))).toThrow(
        InvalidWagerTransactionError,
      );
    }
    expect(() => WagerTransaction.create(props({ kind: Kind.Loss, money: brl('0') }))).not.toThrow();
  });

  test('rejects negative amounts and blank identifiers', () => {
    expect(() =>
      WagerTransaction.create(props({ money: Money.rehydrate({ amount: '-1.00', currency: 'BRL' }) })),
    ).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ roundId: ' ' }))).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction.createOpening', () => {
  test('uses the internal provider and the opening:{walletId} key', () => {
    const tx = WagerTransaction.createOpening({
      id: 'tx-open',
      walletId: 'w-9',
      playerId: 'p-9',
      money: brl('100.00'),
      payloadHash: 'b'.repeat(64),
      correlationId: 'corr',
      createdAt: at,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.idempotencyKey).toBe('opening:w-9');
    expect(tx.externalTransactionId).toBe('opening:w-9');
    expect(tx.status).toBe(Status.Pending);
  });
});

describe('WagerTransaction state machine', () => {
  const pending = () => WagerTransaction.create(props());
  const pendingRef = () => {
    const tx = WagerTransaction.create(withRef(Kind.Refund));
    tx.markPendingReference(later);
    return tx;
  };

  test('PENDING → PROCESSED records processedAt, reference and observed balance', () => {
    const tx = pending();
    tx.markProcessed(undefined, later, brl('975.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(later);
    expect(tx.resultBalance?.toString()).toBe('975.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED carries the failure code and no processedAt', () => {
    const tx = pending();
    tx.reject('INSUFFICIENT_FUNDS', brl('20.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.processedAt).toBeUndefined();
    expect(tx.resultBalance?.toString()).toBe('20.00');
  });

  test('PENDING → FAILED', () => {
    const tx = pending();
    tx.fail('PROCESSING_FAILED');
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe('PROCESSING_FAILED');
  });

  test('PENDING → PENDING_REFERENCE schedules the next attempt', () => {
    const tx = WagerTransaction.create(withRef(Kind.Refund));
    tx.markPendingReference(later);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextReferenceAttemptAt).toEqual(later);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
  });

  test('PENDING_REFERENCE → PENDING_REFERENCE counts a new attempt', () => {
    const tx = pendingRef();
    tx.markPendingReference(new Date(later.getTime() + 1000));
    tx.markPendingReference(new Date(later.getTime() + 2000));
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(2);
  });

  test('PENDING_REFERENCE → PROCESSED requires the resolved reference and clears the schedule', () => {
    const tx = pendingRef();
    expect(() => tx.markProcessed(undefined, later, brl('1.00'))).toThrow(InvalidWagerTransactionError);
    tx.markProcessed('tx-ref', later, brl('125.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('tx-ref');
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test('PENDING_REFERENCE → REJECTED(REFERENCE_NOT_FOUND) and → FAILED', () => {
    const a = pendingRef();
    a.reject('REFERENCE_NOT_FOUND');
    expect(a.status).toBe(Status.Rejected);
    expect(a.nextReferenceAttemptAt).toBeUndefined();
    const b = pendingRef();
    b.fail('PROCESSING_FAILED');
    expect(b.status).toBe(Status.Failed);
  });

  const terminalFactories: Array<[string, () => WagerTransaction]> = [
    ['PROCESSED', () => { const t = pending(); t.markProcessed(undefined, later, brl('1.00')); return t; }],
    ['REJECTED', () => { const t = pending(); t.reject('INSUFFICIENT_FUNDS'); return t; }],
    ['FAILED', () => { const t = pending(); t.fail('PROCESSING_FAILED'); return t; }],
  ];

  describe.each(terminalFactories)('from terminal %s every transition throws', (_name, make) => {
    test.each([
      ['markProcessed', (t: WagerTransaction) => t.markProcessed(undefined, later, brl('1.00'))],
      ['markPendingReference', (t: WagerTransaction) => t.markPendingReference(later)],
      ['reject', (t: WagerTransaction) => t.reject('INSUFFICIENT_FUNDS')],
      ['fail', (t: WagerTransaction) => t.fail('PROCESSING_FAILED')],
    ])('%s', (_label, act) => {
      const tx = make();
      const before = tx.status;
      expect(() => act(tx)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(before);
    });
  });

  test('rehydrate restores a terminal state without revalidating transitions', () => {
    const tx = WagerTransaction.rehydrate({
      ...{
        id: 'tx', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k',
        payloadHash: 'h', payloadHashVersion: 1, walletId: 'w', playerId: 'pl', roundId: 'r',
        gameId: 'g', kind: Kind.Bet, money: brl('1.00'), referenceExternalTransactionId: undefined,
        correlationId: 'c', createdAt: at,
      },
      status: Status.Rejected,
      referenceTransactionId: undefined,
      failureCode: 'INSUFFICIENT_FUNDS',
      resultBalance: brl('0'),
      processedAt: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject('INSUFFICIENT_FUNDS')).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction queries', () => {
  const make = (kind: CreateWagerTransactionProps['kind'], extra: Partial<CreateWagerTransactionProps> = {}) =>
    WagerTransaction.create(
      props({
        kind,
        ...(kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: 'ext-0' } : {}),
        ...extra,
      }),
    );

  test('affectsBalance is false only for LOSS', () => {
    expect(make(Kind.Loss).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) {
      expect(make(kind).affectsBalance()).toBe(true);
    }
  });

  test('requiresReference is true only for REFUND and ROLLBACK', () => {
    expect(make(Kind.Refund).requiresReference()).toBe(true);
    expect(make(Kind.Rollback).requiresReference()).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss]) {
      expect(make(kind).requiresReference()).toBe(false);
    }
  });

  test('matchesPayload compares the stored hash', () => {
    const tx = make(Kind.Bet);
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('ledgerDirectionFor: BET debits; WIN and REFUND credit', () => {
    expect(make(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ledgerDirectionFor: LOSS has no direction', () => {
    expect(() => make(Kind.Loss).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('ledgerDirectionFor: ROLLBACK inverts the direction of its reference', () => {
    const rollback = make(Kind.Rollback);
    expect(rollback.ledgerDirectionFor(make(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(make(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(make(Kind.Refund))).toBe(LedgerDirection.Debit);
  });

  test('ledgerDirectionFor: ROLLBACK needs a reference of an allowed kind', () => {
    const rollback = make(Kind.Rollback);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => rollback.ledgerDirectionFor(make(Kind.Loss))).toThrow(InvalidWagerTransactionError);
    expect(() => rollback.ledgerDirectionFor(make(Kind.Rollback))).toThrow(InvalidWagerTransactionError);
  });

  test('isReferenceKindAllowed: REFUND→BET; ROLLBACK→BET|WIN|REFUND; WIN→BET', () => {
    const refund = make(Kind.Refund);
    expect(refund.isReferenceKindAllowed(make(Kind.Bet))).toBe(true);
    for (const kind of [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]) {
      expect(refund.isReferenceKindAllowed(make(kind))).toBe(false);
    }
    const rollback = make(Kind.Rollback);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund]) {
      expect(rollback.isReferenceKindAllowed(make(kind))).toBe(true);
    }
    for (const kind of [Kind.Loss, Kind.Rollback]) {
      expect(rollback.isReferenceKindAllowed(make(kind))).toBe(false);
    }
    expect(make(Kind.Win).isReferenceKindAllowed(make(Kind.Bet))).toBe(true);
    expect(make(Kind.Win).isReferenceKindAllowed(make(Kind.Win))).toBe(false);
    expect(make(Kind.Bet).isReferenceKindAllowed(make(Kind.Bet))).toBe(false);
  });
});

describe('FailureCode catalog', () => {
  test('is closed and free of duplicates', () => {
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length);
    expect(isFailureCode('INSUFFICIENT_FUNDS')).toBe(true);
    expect(isFailureCode('SOMETHING_ELSE')).toBe(false);
    expect(isFailureCode(undefined)).toBe(false);
  });
});

describe('WagerTransaction result balance and kind validation', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('markProcessed and reject refuse a result balance in another currency or negative', () => {
    const negative = Money.rehydrate({ amount: '-1.00', currency: 'BRL' });
    for (const bad of [usd, negative]) {
      const a = WagerTransaction.create(props());
      expect(() => a.markProcessed(undefined, later, bad)).toThrow(InvalidWagerTransactionError);
      expect(a.status).toBe(Status.Pending);
      const b = WagerTransaction.create(props());
      expect(() => b.reject('INSUFFICIENT_FUNDS', bad)).toThrow(InvalidWagerTransactionError);
      expect(b.status).toBe(Status.Pending);
    }
  });

  test('create rejects a kind outside the enum (non-strict deserialization)', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: 'TRANSFER' as unknown as CreateWagerTransactionProps['kind'] })),
    ).toThrow(InvalidWagerTransactionError);
  });
});
