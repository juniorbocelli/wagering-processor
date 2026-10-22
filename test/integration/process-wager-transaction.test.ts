import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors.ts';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { assertLedgerConsistency, ThrowingFaultInjector } from '../support/consistency.ts';
import { connect, ensureSchema, sql, uuid } from '../support/db.ts';
import { createFixtures } from '../support/wagering-fixtures.ts';

let app: MikroORM;
let services: WageringServices;
const faults = new ThrowingFaultInjector();

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 30);
  services = buildWageringServices(app, { faults });
});

afterAll(async () => {
  await app.close();
});

const { ctx, openWallet, cmd, run, txOf, balanceOf, count, ledgerCount, outboxCount } = createFixtures(
  () => app,
  () => services,
);

describe('OpenWalletUseCase (PostgreSQL real)', () => {
  test('OPENING is atomic: wallet, transaction, ledger entry (version 1) and event commit together', async () => {
    const wallet = await openWallet('250.00');
    expect(await balanceOf(wallet.id)).toBe('250.00');
    expect(await count('wager_transactions', "wallet_id = ? AND kind = 'OPENING' AND status = 'PROCESSED'", [wallet.id])).toBe(1);
    const [entry] = await sql<{ wallet_version: number; direction: string }>(
      app,
      'SELECT wallet_version, direction FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(entry).toEqual({ wallet_version: 1, direction: 'CREDIT' });
    expect(await outboxCount(wallet.id)).toBe(2); // WalletBalanceChanged + WagerTransactionProcessed
    await assertLedgerConsistency(app, wallet.id);
  });

  test('zero balance: no OPENING, no ledger, no event; first movement is wallet_version 2', async () => {
    const wallet = await openWallet('0.00');
    expect(await count('wager_transactions', 'wallet_id = ?', [wallet.id])).toBe(0);
    expect(await ledgerCount(wallet.id)).toBe(0);
    expect(await outboxCount(wallet.id)).toBe(0);
    await assertLedgerConsistency(app, wallet.id);

    expect(txOf(await run(cmd(wallet, { kind: 'WIN', money: { amount: '30.00', currency: 'BRL' } }))).status).toBe('PROCESSED');
    const [entry] = await sql<{ wallet_version: number }>(app, 'SELECT wallet_version FROM wallet_ledger_entries WHERE wallet_id = ?', [wallet.id]);
    expect(entry?.wallet_version).toBe(2);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('a duplicate (playerId, currency) is WalletAlreadyExistsError and leaves no residue', async () => {
    const playerId = `player-${uuid()}`;
    await services.openWallet.execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } }, ctx());
    await expect(
      services.openWallet.execute({ playerId, initialBalance: { amount: '99.00', currency: 'BRL' } }, ctx()),
    ).rejects.toThrow(WalletAlreadyExistsError);
    expect(await count('wallets', 'player_id = ?', [playerId])).toBe(1);
    // outra moeda para o mesmo jogador é uma wallet distinta
    await services.openWallet.execute({ playerId, initialBalance: { amount: '1.00', currency: 'USD' } }, ctx());
    expect(await count('wallets', 'player_id = ?', [playerId])).toBe(2);
  });
});

describe('atomicity', () => {
  test('a fault after the ledger insert leaves no row in wallet, ledger, transaction, outbox or inbox', async () => {
    const wallet = await openWallet('100.00');
    const command = cmd(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const messageId = `msg-${uuid()}`;
    const events = await outboxCount(wallet.id);

    faults.arm('after_ledger_insert');
    await expect(
      services.processWagerTransaction.execute(command, {
        ...ctx(),
        inbox: { consumerName: 'wager-consumer', messageId },
      }),
    ).rejects.toThrow('injected fault at after_ledger_insert');

    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await count('wager_transactions', 'external_transaction_id = ?', [command.externalTransactionId])).toBe(0);
    expect(await outboxCount(wallet.id)).toBe(events);
    expect(await count('inbox_messages', 'message_id = ?', [messageId])).toBe(0);
    await assertLedgerConsistency(app, wallet.id);

    // nada ficou "meio gravado": o reenvio da mesma operação processa normalmente
    expect(txOf(await run(command)).status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await assertLedgerConsistency(app, wallet.id);
  });

  test('success commits wallet UPDATE, transaction, ledger entry and both events together', async () => {
    const wallet = await openWallet('100.00');
    const tx = txOf(await run(cmd(wallet, { money: { amount: '40.00', currency: 'BRL' } })));
    expect(tx.status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('60.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    const events = await sql<{ event_type: string }>(
      app,
      'SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq',
      [wallet.id],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
    ]);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('LOSS: no ledger entry, no version bump, only WagerTransactionProcessed', async () => {
    const wallet = await openWallet('100.00');
    const events = await outboxCount(wallet.id);
    const loss = txOf(await run(cmd(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } })));
    expect(loss.status).toBe('PROCESSED');
    expect(loss.resultBalance?.toString()).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await outboxCount(wallet.id)).toBe(events + 1);
    const [row] = await sql<{ version: number }>(app, 'SELECT version FROM wallets WHERE id = ?', [wallet.id]);
    expect(row?.version).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('a rejected BET persists the rejection (auditable) without touching balance or ledger', async () => {
    const wallet = await openWallet('10.00');
    const command = cmd(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    const tx = txOf(await run(command));
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    const [row] = await sql<{ status: string; failure_code: string; result_balance_amount: string }>(
      app,
      'SELECT status, failure_code, result_balance_amount FROM wager_transactions WHERE external_transaction_id = ?',
      [command.externalTransactionId],
    );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', result_balance_amount: '10.00' });
    expect(await ledgerCount(wallet.id)).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('identity violations are persisted without disclosing any balance', async () => {
    const wallet = await openWallet('10.00');
    const command = cmd(wallet, { playerId: 'impostor' });
    const tx = txOf(await run(command));
    expect(tx.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    const [row] = await sql<{ result_balance_amount: string | null }>(
      app,
      'SELECT result_balance_amount FROM wager_transactions WHERE external_transaction_id = ?',
      [command.externalTransactionId],
    );
    expect(row?.result_balance_amount).toBeNull();
    await assertLedgerConsistency(app, wallet.id);
  });

  test('unknown wallet: WalletNotFoundError and nothing persisted', async () => {
    const wallet = await openWallet();
    const command = cmd({ id: uuid(), playerId: wallet.playerId });
    await expect(run(command)).rejects.toThrow(WalletNotFoundError);
    expect(await count('wager_transactions', 'external_transaction_id = ?', [command.externalTransactionId])).toBe(0);
  });
});

describe('persistent idempotency', () => {
  test('replay returns the original balance even after later movements', async () => {
    const wallet = await openWallet('100.00');
    const command = cmd(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const first = txOf(await run(command));
    await run(cmd(wallet, { kind: 'WIN', money: { amount: '500.00', currency: 'BRL' } }));

    const replay = await run(command);
    expect(replay.kind).toBe('replay');
    expect(txOf(replay).id).toBe(first.id);
    expect(txOf(replay).resultBalance?.toString()).toBe('70.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('same key with another payload → IDEMPOTENCY_KEY_REUSED; same external id with another key → EXTERNAL_TRANSACTION_ID_REUSED', async () => {
    const wallet = await openWallet('100.00');
    const command = cmd(wallet);
    await run(command);

    const keyReuse = await run({ ...command, money: { amount: '11.00', currency: 'BRL' } }).catch((e: unknown) => e);
    expect((keyReuse as IdempotencyConflictError).code).toBe('IDEMPOTENCY_KEY_REUSED');
    const externalReuse = await run({ ...command, idempotencyKey: 'another-key' }).catch((e: unknown) => e);
    expect((externalReuse as IdempotencyConflictError).code).toBe('EXTERNAL_TRANSACTION_ID_REUSED');
    expect(await balanceOf(wallet.id)).toBe('90.00');
    await assertLedgerConsistency(app, wallet.id);
  });

  test('the same external id with different keys, concurrently: one wins, the others get 409 with no loop', async () => {
    const wallet = await openWallet('100.00');
    const base = cmd(wallet);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => run({ ...base, idempotencyKey: `key-${uuid()}-${i}` })),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && (r.reason as IdempotencyConflictError).code === 'EXTERNAL_TRANSACTION_ID_REUSED',
    );
    expect(fulfilled).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('the same key arriving with a different walletId is caught by the schema (23505) and ends as a conflict', async () => {
    const a = await openWallet('100.00');
    const b = await openWallet('100.00');
    const base = cmd(a);
    const results = await Promise.allSettled([
      run(base),
      run({ ...base, walletId: b.id, playerId: b.playerId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(IdempotencyConflictError);
    expect((await ledgerCount(a.id, 'DEBIT')) + (await ledgerCount(b.id, 'DEBIT'))).toBe(1);
    await assertLedgerConsistency(app, a.id);
    await assertLedgerConsistency(app, b.id);
  });

  test('the same message id delivered 10× concurrently: one effect, one inbox row', async () => {
    const wallet = await openWallet('100.00');
    const command = cmd(wallet);
    const messageId = `msg-${uuid()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        services.processWagerTransaction.execute(command, {
          ...ctx(),
          inbox: { consumerName: 'wager-consumer', messageId },
        }),
      ),
    );
    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.every((r) => ['applied', 'replay', 'duplicate-delivery'].includes(r.kind))).toBe(true);
    expect(await count('inbox_messages', 'message_id = ?', [messageId])).toBe(1);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });
});

describe('reversals (PostgreSQL real)', () => {
  test('REFUND credits once; a second reversal is REJECTED(REFERENCE_ALREADY_REVERSED)', async () => {
    const wallet = await openWallet('100.00');
    const bet = txOf(await run(cmd(wallet, { money: { amount: '30.00', currency: 'BRL' } })));
    const reversal = (kind: 'REFUND' | 'ROLLBACK') =>
      cmd(wallet, { kind, money: bet.money.toJSON(), referenceExternalTransactionId: bet.externalTransactionId });

    const refund = txOf(await run(reversal('REFUND')));
    expect(refund.status).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const second = txOf(await run(reversal('ROLLBACK')));
    expect(second.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await assertLedgerConsistency(app, wallet.id);
  });

  test('a reversal that would leave a negative balance is REJECTED(REVERSAL_INSUFFICIENT_FUNDS) and auditable', async () => {
    const wallet = await openWallet('10.00');
    const win = txOf(await run(cmd(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } })));
    await run(cmd(wallet, { money: { amount: '55.00', currency: 'BRL' } }));
    expect(await balanceOf(wallet.id)).toBe('5.00');

    const command = cmd(wallet, {
      kind: 'ROLLBACK',
      money: win.money.toJSON(),
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const rollback = txOf(await run(command));
    expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await balanceOf(wallet.id)).toBe('5.00');
    expect(await count('wager_transactions', "external_transaction_id = ? AND status = 'REJECTED'", [command.externalTransactionId])).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('two reversals of the same BET concurrently: exactly one is applied', async () => {
    const wallet = await openWallet('100.00');
    const bet = txOf(await run(cmd(wallet, { money: { amount: '30.00', currency: 'BRL' } })));
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(cmd(wallet, { kind: 'REFUND', money: bet.money.toJSON(), referenceExternalTransactionId: bet.externalTransactionId })),
      ),
    );
    const statuses = results.map((r) => txOf(r).status);
    expect(statuses.filter((s) => s === 'PROCESSED')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'REJECTED')).toHaveLength(7);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await assertLedgerConsistency(app, wallet.id);
  });
});

describe('out-of-order references (PostgreSQL real)', () => {
  test('REFUND before BET → PENDING_REFERENCE; the BET resolves it atomically', async () => {
    const wallet = await openWallet('100.00');
    const lateBet = `bet-arrives-late-${uuid()}`;
    const refundCmd = cmd(wallet, {
      kind: 'REFUND',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: lateBet,
    });
    const refund = txOf(await run(refundCmd));
    expect(refund.status).toBe('PENDING_REFERENCE');
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const bet = txOf(await run(cmd(wallet, { externalTransactionId: lateBet })));
    expect(bet.status).toBe('PROCESSED');

    const [row] = await sql<{ status: string; reference_transaction_id: string; result_balance_amount: string }>(
      app,
      'SELECT status, reference_transaction_id, result_balance_amount FROM wager_transactions WHERE external_transaction_id = ? AND provider_id = ?',
      [refundCmd.externalTransactionId, 'provider-a'],
    );
    expect(row).toEqual({ status: 'PROCESSED', reference_transaction_id: bet.id, result_balance_amount: '100.00' });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(3); // OPENING, BET, REFUND
    await assertLedgerConsistency(app, wallet.id);
  });

  test('reprocessing with the TTL exhausted rejects with REFERENCE_NOT_FOUND and emits the event', async () => {
    const impatient = buildWageringServices(app, {
      pendingReference: { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 12, ttlMs: 0 },
    });
    const wallet = await openWallet('100.00');
    const command = cmd(wallet, { kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: `never-${uuid()}` });
    const pending = txOf(await run(command));
    expect(pending.status).toBe('PENDING_REFERENCE');

    await new Promise((resolve) => setTimeout(resolve, 1_100)); // reprocess só atua quando vencida (1 s da política padrão)
    const result = await impatient.reprocessPendingReference.execute(pending.id);
    expect(result.kind).toBe('reprocessed');
    const [row] = await sql<{ status: string; failure_code: string }>(app, 'SELECT status, failure_code FROM wager_transactions WHERE id = ?', [pending.id]);
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    const events = await sql<{ event_type: string }>(app, 'SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq', [wallet.id]);
    expect(events.map((e) => e.event_type).slice(-2)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect((await impatient.reprocessPendingReference.execute(pending.id)).kind).toBe('skipped');
    await assertLedgerConsistency(app, wallet.id);
  });
});
