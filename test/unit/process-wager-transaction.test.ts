import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors.ts';
import type { ProcessWagerTransactionResult } from '../../src/application/use-cases/process-wager-transaction.ts';
import type { WagerTransaction } from '../../src/domain/wagering/wager-transaction.ts';
import { buildUnitHarness, command, type UnitHarness } from '../support/unit-harness.ts';

const ctx = { correlationId: 'corr-1' };

async function openWallet(h: UnitHarness, balance = '100.00') {
  const wallet = await h.openWallet.execute(
    { playerId: `player-${h.ids.next()}`, initialBalance: { amount: balance, currency: 'BRL' } },
    ctx,
  );
  return wallet;
}

function applied(result: ProcessWagerTransactionResult): WagerTransaction {
  if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
  return result.transaction;
}

const balanceOf = (h: UnitHarness, walletId: string) => h.store.wallets.get(walletId)!.balance.toString();

describe('OpenWalletUseCase', () => {
  test('positive balance creates OPENING, ledger entry (version 1) and WalletBalanceChanged', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h, '100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    const [entry] = h.store.ledger;
    expect(h.store.ledger).toHaveLength(1);
    expect(entry?.walletVersion).toBe(1);
    expect(entry?.direction).toBe('CREDIT');
    const opening = [...h.store.transactions.values()][0]!;
    expect(opening.kind).toBe('OPENING');
    expect(opening.providerId).toBe('internal');
    expect(opening.idempotencyKey).toBe(`opening:${wallet.id}`);
    expect(opening.status).toBe('PROCESSED');
    expect(h.eventTypes()).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
  });

  test('zero balance: no OPENING, no ledger entry, no event', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h, '0.00');
    expect(wallet.version).toBe(1);
    expect(h.store.transactions.size).toBe(0);
    expect(h.store.ledger).toHaveLength(0);
    expect(h.store.outbox).toHaveLength(0);
  });

  test('rejects invalid money and blank player', async () => {
    const h = buildUnitHarness();
    await expect(
      h.openWallet.execute({ playerId: 'p', initialBalance: { amount: '1.001', currency: 'BRL' } }, ctx),
    ).rejects.toThrow(ValidationError);
    await expect(
      h.openWallet.execute({ playerId: '', initialBalance: { amount: '1.00', currency: 'BRL' } }, ctx),
    ).rejects.toThrow(ValidationError);
  });

  test('WalletAlreadyExistsError is a typed 409-class error', () => {
    const error = new WalletAlreadyExistsError('p', 'BRL');
    expect(error.code).toBe('WALLET_ALREADY_EXISTS');
  });
});

describe('BET / WIN / LOSS', () => {
  test('BET debits one entry and publishes WalletBalanceChanged then WagerTransactionProcessed', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const tx = applied(await h.process.execute(command(wallet, { money: { amount: '25.00', currency: 'BRL' } }), ctx));
    expect(tx.status).toBe('PROCESSED');
    expect(tx.resultBalance?.toString()).toBe('75.00');
    expect(balanceOf(h, wallet.id)).toBe('75.00');
    expect(h.store.wallets.get(wallet.id)?.version).toBe(2);
    expect(h.store.ledger.at(-1)?.direction).toBe('DEBIT');
    expect(h.eventTypes()).toEqual([
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
    ]);
  });

  test('BET without enough funds is REJECTED(INSUFFICIENT_FUNDS): no ledger, balance untouched', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h, '50.00');
    const tx = applied(await h.process.execute(command(wallet, { money: { amount: '80.00', currency: 'BRL' } }), ctx));
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.resultBalance?.toString()).toBe('50.00');
    expect(h.store.ledger).toHaveLength(1);
    expect(h.store.wallets.get(wallet.id)?.version).toBe(1);
    expect(h.eventTypes().at(-1)).toBe('WagerTransactionRejected');
  });

  test('a BET that spends exactly the whole balance is accepted', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h, '10.00');
    expect(applied(await h.process.execute(command(wallet), ctx)).status).toBe('PROCESSED');
    expect(balanceOf(h, wallet.id)).toBe('0.00');
  });

  test('WIN credits one entry', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const win = applied(await h.process.execute(command(wallet, { kind: 'WIN', money: { amount: '40.00', currency: 'BRL' } }), ctx));
    expect(win.status).toBe('PROCESSED');
    expect(balanceOf(h, wallet.id)).toBe('140.00');
    expect(h.store.ledger.at(-1)?.direction).toBe('CREDIT');
  });

  test('WIN referencing its BET links referenceTransactionId', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const bet = applied(await h.process.execute(command(wallet), ctx));
    const win = applied(
      await h.process.execute(
        command(wallet, { kind: 'WIN', referenceExternalTransactionId: bet.externalTransactionId }),
        ctx,
      ),
    );
    expect(win.status).toBe('PROCESSED');
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test('LOSS records the result without ledger entry, without version++ and without balance event', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const before = h.store.ledger.length;
    const eventsBefore = h.store.outbox.length;
    const loss = applied(await h.process.execute(command(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }), ctx));
    expect(loss.status).toBe('PROCESSED');
    expect(loss.resultBalance?.toString()).toBe('100.00');
    expect(h.store.ledger).toHaveLength(before);
    expect(h.store.wallets.get(wallet.id)?.version).toBe(1);
    expect(h.eventTypes().slice(eventsBefore)).toEqual(['WagerTransactionProcessed']);
  });
});

describe('identity rules and evaluation order', () => {
  test('player different from the wallet owner → WALLET_PLAYER_MISMATCH', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const tx = applied(await h.process.execute(command(wallet, { playerId: 'someone-else' }), ctx));
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  test('currency different from the wallet currency → CURRENCY_MISMATCH', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const tx = applied(await h.process.execute(command(wallet, { money: { amount: '1.00', currency: 'USD' } }), ctx));
    expect(tx.failureCode).toBe('CURRENCY_MISMATCH');
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  test('first violated rule wins: player mismatch beats currency mismatch and insufficient funds', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h, '1.00');
    const tx = applied(
      await h.process.execute(
        command(wallet, { playerId: 'x', money: { amount: '999.00', currency: 'USD' } }),
        ctx,
      ),
    );
    expect(tx.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  test('unknown wallet → WalletNotFoundError and nothing is persisted', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    await expect(
      h.process.execute(command({ id: '00000000-0000-7000-8000-ffffffffffff', playerId: wallet.playerId }), ctx),
    ).rejects.toThrow(WalletNotFoundError);
    expect(h.store.transactions.size).toBe(1); // somente o OPENING
  });
});

describe('REFUND', () => {
  async function betAndWallet(h: UnitHarness) {
    const wallet = await openWallet(h);
    const bet = applied(await h.process.execute(command(wallet, { money: { amount: '30.00', currency: 'BRL' } }), ctx));
    return { wallet, bet };
  }
  const refundOf = (wallet: { id: string; playerId: string }, bet: WagerTransaction, over = {}) =>
    command(wallet, {
      kind: 'REFUND',
      money: bet.money.toJSON(),
      referenceExternalTransactionId: bet.externalTransactionId,
      ...over,
    });

  test('refunds a PROCESSED BET exactly once', async () => {
    const h = buildUnitHarness();
    const { wallet, bet } = await betAndWallet(h);
    const refund = applied(await h.process.execute(refundOf(wallet, bet), ctx));
    expect(refund.status).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(balanceOf(h, wallet.id)).toBe('100.00');

    const again = applied(await h.process.execute(refundOf(wallet, bet), ctx));
    expect(again.status).toBe('REJECTED');
    expect(again.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  test('amount different from the reference → AMOUNT_MISMATCH', async () => {
    const h = buildUnitHarness();
    const { wallet, bet } = await betAndWallet(h);
    const tx = applied(await h.process.execute(refundOf(wallet, bet, { money: { amount: '29.99', currency: 'BRL' } }), ctx));
    expect(tx.failureCode).toBe('AMOUNT_MISMATCH');
  });

  test('reference from another round → REFERENCE_SCOPE_MISMATCH', async () => {
    const h = buildUnitHarness();
    const { wallet, bet } = await betAndWallet(h);
    const tx = applied(await h.process.execute(refundOf(wallet, bet, { roundId: 'round-2' }), ctx));
    expect(tx.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
  });

  test('REFUND of a WIN → REFERENCE_KIND_NOT_ALLOWED', async () => {
    const h = buildUnitHarness();
    const { wallet } = await betAndWallet(h);
    const win = applied(await h.process.execute(command(wallet, { kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } }), ctx));
    const tx = applied(await h.process.execute(refundOf(wallet, win), ctx));
    expect(tx.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });

  test('REFUND of a REJECTED BET → REFERENCE_NOT_PROCESSED', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h, '5.00');
    const bet = applied(await h.process.execute(command(wallet, { money: { amount: '50.00', currency: 'BRL' } }), ctx));
    expect(bet.status).toBe('REJECTED');
    const tx = applied(await h.process.execute(refundOf(wallet, bet), ctx));
    expect(tx.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });
});

describe('ROLLBACK', () => {
  test('rolls back a BET (credit) and a WIN (debit); direction is the inverse of the reference', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const bet = applied(await h.process.execute(command(wallet, { money: { amount: '30.00', currency: 'BRL' } }), ctx));
    const win = applied(await h.process.execute(command(wallet, { kind: 'WIN', money: { amount: '20.00', currency: 'BRL' } }), ctx));
    expect(balanceOf(h, wallet.id)).toBe('90.00');

    const rollbackBet = applied(
      await h.process.execute(
        command(wallet, { kind: 'ROLLBACK', money: bet.money.toJSON(), referenceExternalTransactionId: bet.externalTransactionId }),
        ctx,
      ),
    );
    expect(rollbackBet.status).toBe('PROCESSED');
    expect(h.store.ledger.at(-1)?.direction).toBe('CREDIT');
    expect(balanceOf(h, wallet.id)).toBe('120.00');

    const rollbackWin = applied(
      await h.process.execute(
        command(wallet, { kind: 'ROLLBACK', money: win.money.toJSON(), referenceExternalTransactionId: win.externalTransactionId }),
        ctx,
      ),
    );
    expect(rollbackWin.status).toBe('PROCESSED');
    expect(h.store.ledger.at(-1)?.direction).toBe('DEBIT');
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  test('a reversal that would make the balance negative is REJECTED(REVERSAL_INSUFFICIENT_FUNDS)', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h, '10.00');
    const win = applied(await h.process.execute(command(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } }), ctx));
    applied(await h.process.execute(command(wallet, { money: { amount: '55.00', currency: 'BRL' } }), ctx));
    expect(balanceOf(h, wallet.id)).toBe('5.00');

    const rollback = applied(
      await h.process.execute(
        command(wallet, { kind: 'ROLLBACK', money: win.money.toJSON(), referenceExternalTransactionId: win.externalTransactionId }),
        ctx,
      ),
    );
    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(balanceOf(h, wallet.id)).toBe('5.00');
  });

  test('ROLLBACK of a LOSS is not allowed', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const loss = applied(await h.process.execute(command(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }), ctx));
    const tx = applied(
      await h.process.execute(
        command(wallet, { kind: 'ROLLBACK', money: { amount: '1.00', currency: 'BRL' }, referenceExternalTransactionId: loss.externalTransactionId }),
        ctx,
      ),
    );
    expect(tx.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });

  test('a reference cannot be reversed twice, not even by a different reversal kind', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const bet = applied(await h.process.execute(command(wallet), ctx));
    const refund = applied(
      await h.process.execute(
        command(wallet, { kind: 'REFUND', money: bet.money.toJSON(), referenceExternalTransactionId: bet.externalTransactionId }),
        ctx,
      ),
    );
    expect(refund.status).toBe('PROCESSED');
    const rollback = applied(
      await h.process.execute(
        command(wallet, { kind: 'ROLLBACK', money: bet.money.toJSON(), referenceExternalTransactionId: bet.externalTransactionId }),
        ctx,
      ),
    );
    expect(rollback.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });
});

describe('out-of-order references (§7.1)', () => {
  test('REFUND before its BET waits as PENDING_REFERENCE and resolves when the BET is processed', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const refund = applied(
      await h.process.execute(
        command(wallet, { kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: 'bet-late' }),
        ctx,
      ),
    );
    expect(refund.status).toBe('PENDING_REFERENCE');
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(h.clock.now().getTime() + 1_000);
    expect(balanceOf(h, wallet.id)).toBe('100.00');
    expect(h.eventTypes().at(-1)).toBe('WagerTransactionPendingReference');

    const bet = applied(
      await h.process.execute(command(wallet, { externalTransactionId: 'bet-late' }), ctx),
    );
    expect(bet.status).toBe('PROCESSED');
    expect(refund.status).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(balanceOf(h, wallet.id)).toBe('100.00'); // -10 (BET) +10 (REFUND)
    expect(h.store.ledger.map((e) => e.walletVersion)).toEqual([1, 2, 3]);
  });

  test('a chain resolves in cascade: ROLLBACK waiting for a REFUND waiting for a BET', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const rollback = applied(
      await h.process.execute(
        command(wallet, { kind: 'ROLLBACK', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: 'refund-x' }),
        ctx,
      ),
    );
    const refund = applied(
      await h.process.execute(
        command(wallet, {
          externalTransactionId: 'refund-x',
          kind: 'REFUND',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: 'bet-x',
        }),
        ctx,
      ),
    );
    expect([rollback.status, refund.status]).toEqual(['PENDING_REFERENCE', 'PENDING_REFERENCE']);

    applied(await h.process.execute(command(wallet, { externalTransactionId: 'bet-x' }), ctx));
    expect(refund.status).toBe('PROCESSED');
    expect(rollback.status).toBe('PROCESSED');
    // BET -10, REFUND +10, ROLLBACK(refund) -10
    expect(balanceOf(h, wallet.id)).toBe('90.00');
  });

  test('ROLLBACK arriving AFTER its REFUND (itself pending) waits instead of being rejected', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const refund = applied(
      await h.process.execute(
        command(wallet, {
          externalTransactionId: 'refund-z',
          kind: 'REFUND',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: 'bet-z',
        }),
        ctx,
      ),
    );
    const rollback = applied(
      await h.process.execute(
        command(wallet, { kind: 'ROLLBACK', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: 'refund-z' }),
        ctx,
      ),
    );
    expect([refund.status, rollback.status]).toEqual(['PENDING_REFERENCE', 'PENDING_REFERENCE']);

    applied(await h.process.execute(command(wallet, { externalTransactionId: 'bet-z' }), ctx));
    expect([refund.status, rollback.status]).toEqual(['PROCESSED', 'PROCESSED']);
    expect(balanceOf(h, wallet.id)).toBe('90.00');
    expect(h.store.ledger.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
  });

  test('a dependent waiting on a pending reference that never resolves ends REFERENCE_NOT_PROCESSED', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    applied(
      await h.process.execute(
        command(wallet, {
          externalTransactionId: 'refund-w',
          kind: 'REFUND',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: 'bet-never',
        }),
        ctx,
      ),
    );
    const rollback = applied(
      await h.process.execute(
        command(wallet, { kind: 'ROLLBACK', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: 'refund-w' }),
        ctx,
      ),
    );
    h.clock.advance(15 * 60_000);
    await h.reprocess.execute(rollback.id);
    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });

  test('malformed walletId is a ValidationError (never reaches PostgreSQL)', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    await expect(
      h.process.execute(command({ id: 'not-a-uuid', playerId: wallet.playerId }), ctx),
    ).rejects.toThrow(ValidationError);
  });

  test('a dependent that turns out invalid is rejected instead of processed', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const refund = applied(
      await h.process.execute(
        command(wallet, { kind: 'REFUND', money: { amount: '99.00', currency: 'BRL' }, referenceExternalTransactionId: 'bet-y' }),
        ctx,
      ),
    );
    applied(await h.process.execute(command(wallet, { externalTransactionId: 'bet-y' }), ctx));
    expect(refund.status).toBe('REJECTED');
    expect(refund.failureCode).toBe('AMOUNT_MISMATCH');
    expect(h.eventTypes()).toContain('WagerTransactionRejected');
  });

  test('reprocess: still missing → new backoff, no new event; TTL exhausted → REFERENCE_NOT_FOUND', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const refund = applied(
      await h.process.execute(
        command(wallet, { kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: 'never-arrives' }),
        ctx,
      ),
    );
    const events = h.store.outbox.length;

    h.clock.advance(1_000);
    expect((await h.reprocess.execute(refund.id)).kind).toBe('reprocessed');
    expect(refund.status).toBe('PENDING_REFERENCE');
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(h.clock.now().getTime() + 2_000);
    expect(h.store.outbox).toHaveLength(events);

    h.clock.advance(15 * 60_000);
    await h.reprocess.execute(refund.id);
    expect(refund.status).toBe('REJECTED');
    expect(refund.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(h.eventTypes().at(-1)).toBe('WagerTransactionRejected');

    expect((await h.reprocess.execute(refund.id)).kind).toBe('skipped');
  });

  test('reprocess rejects after the maximum number of attempts, even before the TTL', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const refund = applied(
      await h.process.execute(
        command(wallet, { kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: 'nope' }),
        ctx,
      ),
    );
    for (let i = 0; i < 12 && refund.status === 'PENDING_REFERENCE'; i += 1) {
      h.clock.advance(60_000); // vence o backoff (teto de 60 s) sem alcançar o TTL de 15 min
      await h.reprocess.execute(refund.id);
    }
    expect(refund.status).toBe('REJECTED');
    expect(refund.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(refund.referenceAttempts).toBe(11);
  });

  test('reprocess of an unknown transaction is skipped', async () => {
    const h = buildUnitHarness();
    expect(await h.reprocess.execute('missing')).toEqual({ kind: 'skipped', transaction: null });
  });
});

describe('idempotency', () => {
  test('replay returns the original result and balance, with no new effects', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const cmd = command(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const first = applied(await h.process.execute(cmd, ctx));
    applied(await h.process.execute(command(wallet, { kind: 'WIN', money: { amount: '500.00', currency: 'BRL' } }), ctx));

    const ledgerSize = h.store.ledger.length;
    const events = h.store.outbox.length;
    const replay = await h.process.execute(cmd, ctx);
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('unreachable');
    expect(replay.transaction.id).toBe(first.id);
    expect(replay.transaction.resultBalance?.toString()).toBe('70.00'); // saldo da época, não o atual
    expect(h.store.ledger).toHaveLength(ledgerSize);
    expect(h.store.outbox).toHaveLength(events);
  });

  test('replay of a REJECTED transaction keeps the failureCode', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h, '5.00');
    const cmd = command(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    applied(await h.process.execute(cmd, ctx));
    const replay = await h.process.execute(cmd, ctx);
    expect(replay.kind === 'replay' && replay.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('same key with a different payload is IDEMPOTENCY_KEY_REUSED (conflict, not replay)', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const cmd = command(wallet);
    applied(await h.process.execute(cmd, ctx));
    const error = await h.process
      .execute({ ...cmd, money: { amount: '11.00', currency: 'BRL' } }, ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(balanceOf(h, wallet.id)).toBe('90.00');
  });

  test('same external id with another key is EXTERNAL_TRANSACTION_ID_REUSED, without loops', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const cmd = command(wallet);
    applied(await h.process.execute(cmd, ctx));
    const error = await h.process.execute({ ...cmd, idempotencyKey: 'another-key' }, ctx).catch((e: unknown) => e);
    expect((error as IdempotencyConflictError).code).toBe('EXTERNAL_TRANSACTION_ID_REUSED');
  });

  test('numerically equal amounts ("25" vs "25.00") hash the same: it is a replay', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const cmd = command(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    applied(await h.process.execute(cmd, ctx));
    const replay = await h.process.execute({ ...cmd, money: { amount: '25', currency: 'BRL' } }, ctx);
    expect(replay.kind).toBe('replay');
  });

  test('keys are scoped by provider', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const a = command(wallet, { externalTransactionId: 'same-id', idempotencyKey: 'same-key' });
    const b = { ...a, providerId: 'provider-b' };
    expect(applied(await h.process.execute(a, ctx)).status).toBe('PROCESSED');
    expect(applied(await h.process.execute(b, ctx)).status).toBe('PROCESSED');
    expect(balanceOf(h, wallet.id)).toBe('80.00');
  });
});

describe('inbox (SQS entry)', () => {
  test('redelivery of the same message produces a single effect', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const cmd = command(wallet);
    const inbox = { consumerName: 'wager-consumer', messageId: 'msg-1' };
    expect((await h.process.execute(cmd, { ...ctx, inbox })).kind).toBe('applied');
    // outra mensagem (messageId diferente) com a mesma operação → idempotência (replay)
    expect((await h.process.execute(cmd, { ...ctx, inbox: { ...inbox, messageId: 'msg-2' } })).kind).toBe('replay');
    expect(balanceOf(h, wallet.id)).toBe('90.00');
    expect(h.store.ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  });

  test('inbox hit short-circuits when the transaction is not yet visible to the fast path', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const cmd = command(wallet);
    const inbox = { consumerName: 'wager-consumer', messageId: 'msg-dup' };
    await h.process.execute(cmd, { ...ctx, inbox });
    h.store.transactions.delete([...h.store.transactions.values()].at(-1)!.id); // simula leitura sem a linha
    const second = await h.process.execute(cmd, { ...ctx, inbox });
    expect(second.kind).toBe('duplicate-delivery');
  });

  test('the same message id redelivered with different content is INBOX_PAYLOAD_MISMATCH', async () => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const inbox = { consumerName: 'wager-consumer', messageId: 'msg-x' };
    await h.process.execute(command(wallet), { ...ctx, inbox });
    await expect(h.process.execute(command(wallet), { ...ctx, inbox })).rejects.toThrow(InboxPayloadMismatchError);
  });
});

describe('command validation', () => {
  const violations = async (over: Record<string, unknown>) => {
    const h = buildUnitHarness();
    const wallet = await openWallet(h);
    const error = await h.process
      .execute({ ...command(wallet), ...over } as never, ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).violations.map((v) => v.field);
  };

  test('OPENING cannot be submitted', async () => {
    expect(await violations({ kind: 'OPENING' })).toContain('kind');
  });
  test('unknown kind', async () => {
    expect(await violations({ kind: 'JACKPOT' })).toContain('kind');
  });
  test('numeric or malformed amounts', async () => {
    expect(await violations({ money: { amount: 25, currency: 'BRL' } })).toContain('money');
    expect(await violations({ money: { amount: '1e3', currency: 'BRL' } })).toContain('money');
    expect(await violations({ money: { amount: '-5.00', currency: 'BRL' } })).toContain('money');
    expect(await violations({ money: { amount: '1.234', currency: 'BRL' } })).toContain('money');
  });
  test('zero amount is invalid for BET', async () => {
    expect(await violations({ money: { amount: '0.00', currency: 'BRL' } })).toContain('money');
  });
  test('REFUND/ROLLBACK require a reference', async () => {
    expect(await violations({ kind: 'REFUND' })).toContain('referenceExternalTransactionId');
    expect(await violations({ kind: 'ROLLBACK', referenceExternalTransactionId: null })).toContain('referenceExternalTransactionId');
  });
  test('BET cannot carry a reference; nobody references itself', async () => {
    expect(await violations({ referenceExternalTransactionId: 'x' })).toContain('referenceExternalTransactionId');
    expect(
      await violations({ kind: 'WIN', externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
    ).toContain('referenceExternalTransactionId');
  });
  test('blank identifiers', async () => {
    expect(await violations({ roundId: '  ' })).toContain('roundId');
  });
  test('oversized or NUL-bearing opaque text is a permanent validation error, not a DB error', async () => {
    expect(await violations({ providerId: 'p'.repeat(65) })).toContain('providerId');
    expect(await violations({ externalTransactionId: 'e'.repeat(129) })).toContain('externalTransactionId');
    expect(await violations({ gameId: 'g\u0000x' })).toContain('gameId');
    expect(await violations({ idempotencyKey: 'k'.repeat(256) })).toContain('idempotencyKey');
    expect(
      await violations({ kind: 'WIN', referenceExternalTransactionId: 'r'.repeat(129) }),
    ).toContain('referenceExternalTransactionId');
  });
});
