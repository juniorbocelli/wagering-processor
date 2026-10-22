import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../src/application/errors.ts';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { assertLedgerConsistency } from '../support/consistency.ts';
import { connect, ensureSchema, inTransaction } from '../support/db.ts';
import { createFixtures } from '../support/wagering-fixtures.ts';

/**
 * Concorrência real: `Promise.all` sobre um pool de conexões real do PostgreSQL, contra os
 * mesmos adapters de produção. (Os cenários com 3 processos e SQS chegam no passo 6.)
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

const { ctx, openWallet, cmd, run, txOf, balanceOf, count, ledgerCount } = createFixtures(
  () => app,
  () => services,
);

describe('concurrency (real pool)', () => {
  test('§8 scenario: balance 100, two BET of 80 at once → 1 PROCESSED, 1 REJECTED, balance 20.00, 1 DEBIT (×20)', async () => {
    for (let round = 0; round < 20; round += 1) {
      const wallet = await openWallet('100.00');
      const [a, b] = await Promise.all([
        run(cmd(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
        run(cmd(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
      ]);
      const statuses = [txOf(a).status, txOf(b).status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      expect(await balanceOf(wallet.id)).toBe('20.00');
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
      await assertLedgerConsistency(app, wallet.id);
    }
  });

  test('the same BET 50× in parallel: one PROCESSED, 49 replays, one DEBIT', async () => {
    const wallet = await openWallet('100.00');
    const command = cmd(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const results = await Promise.all(Array.from({ length: 50 }, () => run(command)));
    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'replay')).toHaveLength(49);
    expect(new Set(results.map((r) => txOf(r).id)).size).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('hot wallet: 60 mixed operations never produce a negative balance and keep the chain intact', async () => {
    const wallet = await openWallet('200.00');
    const operations = Array.from({ length: 60 }, (_, i) => {
      const kind = i % 3 === 0 ? 'WIN' : i % 7 === 0 ? 'LOSS' : 'BET';
      const amount = kind === 'LOSS' ? '0.00' : `${(i % 9) + 5}.50`;
      return run(cmd(wallet, { kind, money: { amount, currency: 'BRL' } }));
    });
    const results = await Promise.all(operations);
    expect(results.every((r) => ['PROCESSED', 'REJECTED'].includes(txOf(r).status))).toBe(true);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('distinct wallets proceed in parallel and stay consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 40 }, () => openWallet('100.00')));
    await Promise.all(
      wallets.map(async (wallet) => {
        expect(txOf(await run(cmd(wallet, { money: { amount: '15.00', currency: 'BRL' } }))).status).toBe('PROCESSED');
        expect(txOf(await run(cmd(wallet, { kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } }))).status).toBe('PROCESSED');
      }),
    );
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('90.00');
      await assertLedgerConsistency(app, wallet.id);
    }
  });

  test('a held row lock past lock_timeout becomes a TransientInfrastructureError (55P03), nothing persisted', async () => {
    const quick = buildWageringServices(app, { unitOfWork: { lockTimeout: '300ms', statementTimeout: '5s' } });
    const wallet = await openWallet('100.00');
    const command = cmd(wallet);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = inTransaction(app, async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      locked();
      await hold;
    });
    await holding;
    const error = await quick.processWagerTransaction.execute(command, ctx()).catch((e: unknown) => e);
    release();
    await holder;

    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect(await count('wager_transactions', 'external_transaction_id = ?', [command.externalTransactionId])).toBe(0);
    // reenviar com a mesma key é seguro
    expect(txOf(await run(command)).status).toBe('PROCESSED');
    await assertLedgerConsistency(app, wallet.id);
  });
});
