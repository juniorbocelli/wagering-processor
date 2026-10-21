import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { FAILURE_CODES } from '../../src/domain/wagering/failure-code.ts';
import {
  connect,
  ensureSchema,
  inTransaction,
  insertLedger,
  insertTx,
  insertWallet,
  openEmptyWallet,
  openWalletWithBalance,
  sql,
  txRow,
  uuid,
  walletRow,
  type LedgerRow,
} from '../support/db.ts';

/**
 * Cada constraint/trigger do schema é provada por uma escrita que **deve falhar** (e pelos
 * caminhos que **devem passar**). Cada teste usa wallets próprias; nada é truncado.
 */
let owner: MikroORM;
let app: MikroORM;

beforeAll(async () => {
  await ensureSchema();
  owner = await connect('owner');
  app = await connect('app');
});

afterAll(async () => {
  await owner.close();
  await app.close();
});

const rejects = (promise: Promise<unknown>, pattern: RegExp) => expect(promise).rejects.toThrow(pattern);

const ledger = (
  walletId: string,
  transactionId: string,
  over: Partial<LedgerRow> = {},
): LedgerRow => ({
  id: uuid(),
  walletId,
  currency: 'BRL',
  transactionId,
  direction: 'DEBIT',
  amount: '10.00',
  before: '100.00',
  after: '90.00',
  walletVersion: 2,
  ...over,
});

/** Insere uma transação `PROCESSED` avulsa na wallet e devolve o id. */
async function processedTx(walletId: string, over: Parameters<typeof txRow>[1] = {}): Promise<string> {
  const row = txRow(walletId, over);
  await inTransaction(owner, (em) => insertTx(em, row));
  return row.id;
}

describe('wallets', () => {
  test('negative balance is rejected by CHECK', async () => {
    await rejects(
      inTransaction(owner, (em) => insertWallet(em, walletRow({ balance: '-0.01' }))),
      /ck|check constraint|balance_amount/i,
    );
  });

  test('currency must be 3 uppercase letters', async () => {
    await rejects(
      inTransaction(owner, (em) => insertWallet(em, walletRow({ currency: 'brl' }))),
      /check constraint/i,
    );
  });

  test('duplicate (player_id, currency) is rejected; another currency is allowed', async () => {
    const first = walletRow();
    await inTransaction(owner, (em) => insertWallet(em, first));
    await rejects(
      inTransaction(owner, (em) =>
        insertWallet(em, walletRow({ playerId: first.playerId })),
      ),
      /uq_wallets_player_currency/,
    );
    await inTransaction(owner, (em) =>
      insertWallet(em, walletRow({ playerId: first.playerId, currency: 'USD' })),
    );
  });

  test('wallet opened with zero balance, no ledger and a non-UUID player id passes', async () => {
    const wallet = walletRow({ playerId: 'provider|player#42' });
    await inTransaction(owner, (em) => insertWallet(em, wallet));
    const [row] = await sql<{ player_id: string }>(owner, 'SELECT player_id FROM wallets WHERE id = ?', [wallet.id]);
    expect(row?.player_id).toBe('provider|player#42');
  });

  test('wallet inserted with a balance and no OPENING ledger entry is rejected at commit', async () => {
    await rejects(
      inTransaction(owner, (em) => insertWallet(em, walletRow({ balance: '50.00' }))),
      /no matching opening ledger entry/,
    );
  });

  test('wallet must be inserted with version 1', async () => {
    await rejects(
      inTransaction(owner, (em) => insertWallet(em, walletRow({ version: 2 }))),
      /must be inserted with version 1/,
    );
    await rejects(
      inTransaction(owner, (em) => insertWallet(em, walletRow({ version: 0 }))),
      /check constraint|version/i,
    );
  });

  test('balance changed without a ledger entry is rejected at commit', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) =>
        em.execute('UPDATE wallets SET balance_amount = 5.00, version = 2 WHERE id = ?', [walletId]),
      ),
      /without a matching ledger entry/,
    );
  });

  test('balance change must bump version by exactly 1', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    await rejects(
      inTransaction(owner, async (em) => {
        await insertLedger(em, ledger(walletId, txId)); // lançamento válido: wallet_version = 2
        await em.execute('UPDATE wallets SET balance_amount = 90.00, version = 3 WHERE id = ?', [walletId]);
      }),
      /balance changed but version went 1 -> 3/,
    );
  });

  test('version cannot change while the balance stays the same', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    await rejects(
      inTransaction(owner, (em) => em.execute('UPDATE wallets SET version = 2 WHERE id = ?', [walletId])),
      /version changed without a balance change/,
    );
  });

  test('updating only updated_at (no balance change) passes', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    await inTransaction(owner, (em) => em.execute('UPDATE wallets SET updated_at = now() WHERE id = ?', [walletId]));
  });

  test('identity columns are immutable', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) => em.execute(`UPDATE wallets SET player_id = 'other' WHERE id = ?`, [walletId])),
      /identity columns are immutable/,
    );
  });

  test('a valid debit (ledger + wallet update in one transaction) passes; chain is continuous', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    await inTransaction(owner, async (em) => {
      await insertLedger(em, ledger(walletId, txId));
      await em.execute('UPDATE wallets SET balance_amount = 90.00, version = 2 WHERE id = ?', [walletId]);
    });
    const rows = await sql<{ wallet_version: number; balance_after: string }>(
      owner,
      'SELECT wallet_version, balance_after FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version',
      [walletId],
    );
    expect(rows.map((r) => r.wallet_version)).toEqual([1, 2]);
    expect(rows.at(-1)?.balance_after).toBe('90.00');
  });

  test('wallet opened empty: first ledger entry has wallet_version 2 and passes', async () => {
    const { walletId } = await openEmptyWallet(owner);
    const txId = await processedTx(walletId, { kind: 'WIN' });
    await inTransaction(owner, async (em) => {
      await insertLedger(em, ledger(walletId, txId, { direction: 'CREDIT', before: '0.00', after: '10.00', walletVersion: 2 }));
      await em.execute('UPDATE wallets SET balance_amount = 10.00, version = 2 WHERE id = ?', [walletId]);
    });
  });
});

describe('wallet_ledger_entries', () => {
  test('UPDATE and DELETE are blocked by trigger, even for the owner', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    await rejects(
      sql(owner, 'UPDATE wallet_ledger_entries SET amount = 1.00 WHERE wallet_id = ?', [walletId]),
      /append-only/,
    );
    await rejects(sql(owner, 'DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]), /append-only/);
  });

  test('TRUNCATE is blocked by trigger', async () => {
    await rejects(sql(owner, 'TRUNCATE wallet_ledger_entries'), /append-only/);
  });

  test('wagering_app is denied UPDATE, DELETE and TRUNCATE by privilege', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    await rejects(sql(app, 'UPDATE wallet_ledger_entries SET amount = 1.00 WHERE wallet_id = ?', [walletId]), /permission denied/);
    await rejects(sql(app, 'DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]), /permission denied/);
    await rejects(sql(app, 'TRUNCATE wallet_ledger_entries'), /permission denied/);
  });

  test('wagering_app cannot run DDL', async () => {
    await rejects(sql(app, 'CREATE TABLE app_ddl_probe (id int)'), /permission denied/);
  });

  test('unbalanced arithmetic is rejected by CHECK', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    await rejects(
      inTransaction(owner, (em) => insertLedger(em, ledger(walletId, txId, { after: '80.00' }))),
      /ck_ledger_arithmetic/,
    );
    await rejects(
      inTransaction(owner, (em) =>
        insertLedger(em, ledger(walletId, txId, { direction: 'CREDIT', after: '90.00' })),
      ),
      /ck_ledger_arithmetic/,
    );
  });

  test('negative balance_after and zero amount are rejected by CHECK', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    await rejects(
      inTransaction(owner, (em) =>
        insertLedger(em, ledger(walletId, txId, { amount: '150.00', after: '-50.00' })),
      ),
      /check constraint/i,
    );
    await rejects(
      inTransaction(owner, (em) => insertLedger(em, ledger(walletId, txId, { amount: '0.00', after: '100.00' }))),
      /check constraint/i,
    );
  });

  test('repeated wallet_version is rejected', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    await rejects(
      inTransaction(owner, (em) =>
        insertLedger(em, ledger(walletId, txId, { walletVersion: 1, before: '0.00', after: '-10.00' })),
      ),
      /check constraint|chain broken|uq_ledger_wallet_version/i,
    );
    await rejects(
      inTransaction(owner, (em) =>
        insertLedger(em, ledger(walletId, txId, { walletVersion: 1, direction: 'CREDIT', before: '100.00', after: '110.00' })),
      ),
      /chain broken|uq_ledger_wallet_version/,
    );
  });

  test('broken chain: valid arithmetic starting from a forged previous balance is rejected', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    // 50.00 - 30.00 = 20.00 é aritmeticamente válido, mas o saldo anterior real é 100.00
    await rejects(
      inTransaction(owner, (em) =>
        insertLedger(em, ledger(walletId, txId, { amount: '30.00', before: '50.00', after: '20.00' })),
      ),
      /ledger chain broken/,
    );
  });

  test('broken chain: version gap is rejected', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    await rejects(
      inTransaction(owner, (em) => insertLedger(em, ledger(walletId, txId, { walletVersion: 4 }))),
      /ledger chain broken/,
    );
  });

  test('first entry must start at balance 0 with wallet_version 1 or 2', async () => {
    const empty = await openEmptyWallet(owner);
    const txId = await processedTx(empty.walletId, { kind: 'WIN' });
    await rejects(
      inTransaction(owner, (em) =>
        insertLedger(em, ledger(empty.walletId, txId, { direction: 'CREDIT', before: '0.00', after: '10.00', walletVersion: 3 })),
      ),
      /ledger chain broken/,
    );
    await rejects(
      inTransaction(owner, (em) =>
        insertLedger(em, ledger(empty.walletId, txId, { direction: 'CREDIT', before: '5.00', after: '15.00', walletVersion: 2 })),
      ),
      /ledger chain broken/,
    );
  });

  test('at most one ledger entry per transaction', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    await inTransaction(owner, async (em) => {
      await insertLedger(em, ledger(walletId, txId));
      await em.execute('UPDATE wallets SET balance_amount = 90.00, version = 2 WHERE id = ?', [walletId]);
    });
    await rejects(
      inTransaction(owner, (em) =>
        insertLedger(em, ledger(walletId, txId, { walletVersion: 3, before: '90.00', after: '80.00' })),
      ),
      /uq_ledger_transaction/,
    );
  });

  test('ledger currency must match the wallet currency (composite FK)', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    const txId = await processedTx(walletId);
    await rejects(
      inTransaction(owner, (em) => insertLedger(em, ledger(walletId, txId, { currency: 'USD' }))),
      /fk_ledger_wallet_currency/,
    );
  });

  test('ledger entry for an unknown transaction is rejected at commit (deferred FK)', async () => {
    const { walletId } = await openWalletWithBalance(owner, '100.00');
    await rejects(
      inTransaction(owner, (em) => insertLedger(em, ledger(walletId, uuid()))),
      /foreign key constraint/i,
    );
  });
});

describe('wager_transactions', () => {
  test('duplicate (provider_id, idempotency_key) is rejected', async () => {
    const { walletId } = await openEmptyWallet(owner);
    const first = txRow(walletId);
    await inTransaction(owner, (em) => insertTx(em, first));
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { idempotencyKey: first.idempotencyKey }))),
      /uq_wtx_provider_idempotency/,
    );
    // outro provedor pode reutilizar a mesma key
    await inTransaction(owner, (em) =>
      insertTx(em, txRow(walletId, { idempotencyKey: first.idempotencyKey, providerId: 'provider-b' })),
    );
  });

  test('duplicate (provider_id, external_transaction_id) is rejected', async () => {
    const { walletId } = await openEmptyWallet(owner);
    const first = txRow(walletId);
    await inTransaction(owner, (em) => insertTx(em, first));
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { externalId: first.externalId }))),
      /uq_wtx_provider_external/,
    );
  });

  test('kind outside the closed set is rejected', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { kind: 'TRANSFER' }))),
      /check constraint/i,
    );
  });

  test('amount must be positive, except for LOSS', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { amount: '0.00' }))),
      /ck_wtx_amount_positive/,
    );
    await inTransaction(owner, (em) => insertTx(em, txRow(walletId, { kind: 'LOSS', amount: '0.00' })));
  });

  test.each(['REFUND', 'ROLLBACK'])('%s requires a reference_external_transaction_id', async (kind) => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) =>
        insertTx(em, txRow(walletId, { kind, status: 'PENDING_REFERENCE', referenceExternalId: null })),
      ),
      /ck_wtx_reference_required/,
    );
  });

  test('failure_code is required for REJECTED/FAILED and forbidden otherwise', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { status: 'REJECTED', failureCode: null }))),
      /ck_wtx_failure_code\b/,
    );
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { status: 'PROCESSED', failureCode: 'INSUFFICIENT_FUNDS' }))),
      /ck_wtx_failure_code\b/,
    );
  });

  test('failure_code outside the ADR-007 catalog is rejected', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { status: 'REJECTED', failureCode: 'MADE_UP' }))),
      /ck_wtx_failure_code_catalog/,
    );
  });

  test('processed_at is required exactly when PROCESSED', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { status: 'PROCESSED', processedAt: null }))),
      /ck_wtx_processed_at/,
    );
    await rejects(
      inTransaction(owner, (em) =>
        insertTx(em, txRow(walletId, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', processedAt: new Date() })),
      ),
      /ck_wtx_processed_at/,
    );
  });

  test('a PROCESSED transaction must carry a non-negative observed balance', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { resultBalance: null }))),
      /ck_wtx_processed_has_result/,
    );
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(walletId, { resultBalance: '-0.01' }))),
      /ck_wtx_result_balance_nonneg/,
    );
  });

  test('wager_transactions and wallets can never be deleted or truncated, not even by the owner', async () => {
    const { walletId } = await openEmptyWallet(owner);
    const txId = await processedTx(walletId);
    await rejects(sql(owner, 'DELETE FROM wager_transactions WHERE id = ?', [txId]), /never deleted/);
    await rejects(sql(owner, 'DELETE FROM wallets WHERE id = ?', [walletId]), /never deleted/);
    await rejects(sql(owner, 'TRUNCATE wager_transactions CASCADE'), /never deleted/);
    await rejects(sql(owner, 'TRUNCATE wallets CASCADE'), /never deleted/);
  });

  test('a PROCESSED reversal must have its reference resolved', async () => {
    const { walletId } = await openEmptyWallet(owner);
    await rejects(
      inTransaction(owner, (em) =>
        insertTx(em, txRow(walletId, { kind: 'REFUND', referenceExternalId: 'ext-bet', referenceTransactionId: null })),
      ),
      /ck_wtx_reversal_resolved/,
    );
  });

  test('a reference can be reversed only once (REFUND or ROLLBACK)', async () => {
    const { walletId } = await openEmptyWallet(owner);
    const betId = await processedTx(walletId);
    const reversal = (kind: string) =>
      txRow(walletId, { kind, referenceExternalId: 'ext-bet', referenceTransactionId: betId });
    await inTransaction(owner, (em) => insertTx(em, reversal('REFUND')));
    await rejects(inTransaction(owner, (em) => insertTx(em, reversal('REFUND'))), /uq_wtx_single_reversal/);
    await rejects(inTransaction(owner, (em) => insertTx(em, reversal('ROLLBACK'))), /uq_wtx_single_reversal/);
  });

  test('a REJECTED reversal does not consume the reference', async () => {
    const { walletId } = await openEmptyWallet(owner);
    const betId = await processedTx(walletId);
    const rejected = txRow(walletId, {
      kind: 'REFUND', status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH',
      referenceExternalId: 'ext-bet', referenceTransactionId: betId,
    });
    await inTransaction(owner, (em) => insertTx(em, rejected));
    await inTransaction(owner, (em) =>
      insertTx(em, txRow(walletId, { kind: 'REFUND', referenceExternalId: 'ext-bet', referenceTransactionId: betId })),
    );
  });

  test('only one OPENING per wallet', async () => {
    const { walletId, playerId } = await openWalletWithBalance(owner, '10.00');
    await rejects(
      inTransaction(owner, (em) =>
        insertTx(em, txRow(walletId, { kind: 'OPENING', providerId: 'internal', playerId })),
      ),
      /uq_wtx_single_opening/,
    );
  });

  test('transaction for an unknown wallet is rejected at commit (deferred FK)', async () => {
    await rejects(
      inTransaction(owner, (em) => insertTx(em, txRow(uuid()))),
      /foreign key constraint/i,
    );
  });

  describe.each([
    ['PROCESSED', (walletId: string) => txRow(walletId)],
    ['REJECTED', (walletId: string) => txRow(walletId, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' })],
    ['FAILED', (walletId: string) => txRow(walletId, { status: 'FAILED', failureCode: 'PROCESSING_FAILED' })],
  ])('terminal %s', (_name, make) => {
    test('any UPDATE is rejected', async () => {
      const { walletId } = await openEmptyWallet(owner);
      const row = make(walletId);
      await inTransaction(owner, (em) => insertTx(em, row));
      await rejects(sql(owner, `UPDATE wager_transactions SET reference_attempts = 3 WHERE id = ?`, [row.id]), /is terminal/);
      await rejects(sql(owner, `UPDATE wager_transactions SET status = 'PENDING_REFERENCE', failure_code = NULL, processed_at = NULL WHERE id = ?`, [row.id]), /is terminal/);
    });
  });

  describe('PENDING_REFERENCE', () => {
    const pendingRefund = (walletId: string) =>
      txRow(walletId, { kind: 'REFUND', status: 'PENDING_REFERENCE', referenceExternalId: 'ext-bet' });

    test('identity/payload columns stay immutable', async () => {
      const { walletId } = await openEmptyWallet(owner);
      const row = pendingRefund(walletId);
      await inTransaction(owner, (em) => insertTx(em, row));
      for (const [column, value] of [
        ['amount', '99.00'],
        ['kind', 'ROLLBACK'],
        ['payload_hash', 'b'.repeat(64)],
        ['idempotency_key', 'other'],
        ['reference_external_transaction_id', 'other'],
        ['round_id', 'other'],
      ] as const) {
        await rejects(
          sql(owner, `UPDATE wager_transactions SET ${column} = ? WHERE id = ?`, [value, row.id]),
          /immutable/,
        );
      }
    });

    test('can retry (PENDING_REFERENCE → PENDING_REFERENCE) updating attempts and schedule', async () => {
      const { walletId } = await openEmptyWallet(owner);
      const row = pendingRefund(walletId);
      await inTransaction(owner, (em) => insertTx(em, row));
      await sql(
        owner,
        `UPDATE wager_transactions SET reference_attempts = 1, next_reference_attempt_at = now() + interval '2 seconds' WHERE id = ?`,
        [row.id],
      );
    });

    test('cannot go back to PENDING', async () => {
      const { walletId } = await openEmptyWallet(owner);
      const row = pendingRefund(walletId);
      await inTransaction(owner, (em) => insertTx(em, row));
      await rejects(sql(owner, `UPDATE wager_transactions SET status = 'PENDING' WHERE id = ?`, [row.id]), /cannot transition/);
    });

    test('→ PROCESSED fills reference_transaction_id, result_balance_amount and processed_at', async () => {
      const { walletId } = await openEmptyWallet(owner);
      const betId = await processedTx(walletId);
      const row = pendingRefund(walletId);
      await inTransaction(owner, (em) => insertTx(em, row));
      await sql(
        owner,
        `UPDATE wager_transactions
            SET status = 'PROCESSED', reference_transaction_id = ?, result_balance_amount = 110.00, processed_at = now()
          WHERE id = ?`,
        [betId, row.id],
      );
      const [done] = await sql<{ status: string; result_balance_amount: string }>(
        owner,
        'SELECT status, result_balance_amount FROM wager_transactions WHERE id = ?',
        [row.id],
      );
      expect(done).toEqual({ status: 'PROCESSED', result_balance_amount: '110.00' });
    });

    test('→ PROCESSED without resolving the reference is rejected', async () => {
      const { walletId } = await openEmptyWallet(owner);
      const row = pendingRefund(walletId);
      await inTransaction(owner, (em) => insertTx(em, row));
      await rejects(
        sql(owner, `UPDATE wager_transactions SET status = 'PROCESSED', result_balance_amount = 1.00, processed_at = now() WHERE id = ?`, [row.id]),
        /ck_wtx_reversal_resolved/,
      );
    });

    test('→ REJECTED(REFERENCE_NOT_FOUND) and → FAILED are allowed', async () => {
      const { walletId } = await openEmptyWallet(owner);
      const a = pendingRefund(walletId);
      const b = pendingRefund(walletId);
      await inTransaction(owner, async (em) => {
        await insertTx(em, a);
        await insertTx(em, b);
      });
      await sql(owner, `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND' WHERE id = ?`, [a.id]);
      await sql(owner, `UPDATE wager_transactions SET status = 'FAILED', failure_code = 'PROCESSING_FAILED' WHERE id = ?`, [b.id]);
    });
  });
});

describe('inbox_messages and outbox_messages', () => {
  test('inbox primary key (consumer_name, message_id) deduplicates', async () => {
    const messageId = uuid();
    const insert = () =>
      sql(
        app,
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         VALUES ('wager', ?, ?, now(), now())`,
        [messageId, 'a'.repeat(64)],
      );
    await insert();
    await rejects(insert(), /duplicate key|inbox_messages_pkey/);
  });

  const insertOutbox = (id: string, aggregateId: string) =>
    sql(
      app,
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, next_attempt_at)
       VALUES (?, ?, 'WagerTransactionProcessed', 1, '{"a":1}'::jsonb, now(), now())`,
      [id, aggregateId],
    );

  test('outbox payload and identity columns are immutable; delivery bookkeeping is not', async () => {
    const id = uuid();
    await insertOutbox(id, uuid());
    await rejects(sql(app, `UPDATE outbox_messages SET payload = '{"a":2}'::jsonb WHERE id = ?`, [id]), /immutable/);
    await rejects(sql(app, `UPDATE outbox_messages SET event_type = 'X' WHERE id = ?`, [id]), /immutable/);
    await rejects(sql(app, `UPDATE outbox_messages SET aggregate_id = ? WHERE id = ?`, [uuid(), id]), /immutable/);
    await rejects(sql(app, `UPDATE outbox_messages SET seq = seq + 1000000 WHERE id = ?`, [id]), /immutable|generated/i);
    await sql(app, `UPDATE outbox_messages SET attempts = 1, locked_by = 'i1', published_at = now() WHERE id = ?`, [id]);
  });

  test('outbox seq is assigned by the database in increasing order', async () => {
    const aggregateId = uuid();
    const [a, b] = [uuid(), uuid()];
    await insertOutbox(a, aggregateId);
    await insertOutbox(b, aggregateId);
    const rows = await sql<{ id: string }>(
      owner,
      'SELECT id FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq',
      [aggregateId],
    );
    expect(rows.map((r) => r.id)).toEqual([a, b]);
  });

  test('wagering_app may delete from inbox/outbox (retention) but not from wallets or transactions', async () => {
    const id = uuid();
    await insertOutbox(id, uuid());
    await sql(app, 'DELETE FROM outbox_messages WHERE id = ?', [id]);
    await rejects(sql(app, 'DELETE FROM wallets WHERE id = ?', [uuid()]), /permission denied/);
    await rejects(sql(app, 'DELETE FROM wager_transactions WHERE id = ?', [uuid()]), /permission denied/);
  });
});

describe('FailureCode catalog parity (ADR-007)', () => {
  test('TypeScript catalog equals the CHECK constraint values', async () => {
    const [row] = await sql<{ def: string }>(
      owner,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_wtx_failure_code_catalog'`,
    );
    const inDatabase = [...(row?.def.matchAll(/'([A-Z_]+)'/g) ?? [])].map((m) => m[1]).sort();
    expect(inDatabase).toEqual([...FAILURE_CODES].sort());
  });
});
