import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { LogFields, Logger, Metrics } from '../../src/application/ports/observability.ts';
import { NOOP_METRICS } from '../../src/application/ports/observability.ts';
import { RECONCILIATION_ADVISORY_LOCK_KEY } from '../../src/infrastructure/persistence/mikro-orm/reconciliation-store.ts';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { PeriodicReconciliationWorker } from '../../src/interfaces/workers/periodic-reconciliation-worker.ts';
import { assertLedgerConsistency } from '../support/consistency.ts';
import { connect, ensureSchema, sql } from '../support/db.ts';
import { createFixtures } from '../support/wagering-fixtures.ts';
import { waitFor } from '../support/wait.ts';

let app: MikroORM;
let superuser: MikroORM;
let services: WageringServices;
const logs: { message: string; fields: LogFields | undefined }[] = [];
let divergences = 0;
const sweeps: { divergent: number; at: Date }[] = [];

const logger: Logger = {
  debug: () => undefined,
  info: (message, fields) => void logs.push({ message, fields }),
  warn: () => undefined,
  error: (message, fields) => void logs.push({ message, fields }),
  child: () => logger,
};
const metrics: Metrics = {
  ...NOOP_METRICS,
  reconciliationDivergence: () => void (divergences += 1),
  reconciliationSweepCompleted: (divergent, at) => void sweeps.push({ divergent, at }),
};

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 20);
  superuser = await connect('superuser', 2);
  services = buildWageringServices(app, { metrics, logger, reconciliationBatchSize: 2 });
});

afterAll(async () => {
  await app.close();
  await superuser.close();
});

const { openWallet, cmd, run } = createFixtures(
  () => app,
  () => services,
);

/**
 * Corrompe o saldo materializado como só um superusuário consegue: desabilita o trigger
 * diferido que o protege. `delta` aceita sinal; o mesmo helper desfaz a corrupção ao final.
 */
async function tamper(walletId: string, column: 'balance_amount' | 'version', delta: string): Promise<void> {
  await superuser.em.fork().transactional(async (em) => {
    await em.execute('ALTER TABLE wallets DISABLE TRIGGER trg_wallet_balance_has_ledger');
    await em.execute(`UPDATE wallets SET ${column} = ${column} + ?::numeric WHERE id = ?`, [delta, walletId]);
    await em.execute('ALTER TABLE wallets ENABLE TRIGGER trg_wallet_balance_has_ledger');
  });
}

describe('ReconcileWalletUseCase (PostgreSQL real)', () => {
  test('consistent wallet: zero difference, no divergence signal', async () => {
    const wallet = await openWallet('100.00');
    await run(cmd(wallet, { money: { amount: '30.00', currency: 'BRL' } }));
    const before = divergences;

    const report = await services.reconcileWallet.execute(wallet.id);
    expect(report).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
    });
    expect(divergences).toBe(before);
  });

  test('wallet opened with zero balance has an empty ledger and is consistent', async () => {
    const wallet = await openWallet('0.00');
    expect(await services.reconcileWallet.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 0,
      storedBalance: { amount: '0.00', currency: 'BRL' },
    });
  });

  test('a provoked balance divergence is flagged, logged and counted — and never corrected', async () => {
    const wallet = await openWallet('100.00');
    await tamper(wallet.id, 'balance_amount', '5.00');
    try {
      const before = divergences;
      const report = await services.reconcileWallet.execute(wallet.id);
      expect(report).toMatchObject({
        consistent: false,
        storedBalance: { amount: '105.00', currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: '5.00', currency: 'BRL' },
      });
      expect(divergences).toBe(before + 1);
      expect(
        logs.some((entry) => entry.message.includes('divergence') && entry.fields?.['walletId'] === wallet.id),
      ).toBe(true);

      // idempotente e sem correção: a segunda consulta vê a mesma divergência
      const [row] = await sql<{ balance_amount: string }>(app, 'SELECT balance_amount FROM wallets WHERE id = ?', [wallet.id]);
      expect(row?.balance_amount).toBe('105.00');
      expect((await services.reconcileWallet.execute(wallet.id)).consistent).toBe(false);
    } finally {
      await tamper(wallet.id, 'balance_amount', '-5.00');
    }
    await assertLedgerConsistency(app, wallet.id);
  });

  test('a version that does not match the last ledger entry is a divergence too', async () => {
    const wallet = await openWallet('100.00');
    await tamper(wallet.id, 'version', '1');
    try {
      const report = await services.reconcileWallet.execute(wallet.id);
      expect(report).toMatchObject({ consistent: false, versionConsistent: false, chainIntact: true });
      expect(report.difference.amount).toBe('0.00');
    } finally {
      await tamper(wallet.id, 'version', '-1');
    }
  });
});

describe('PeriodicReconciliationWorker', () => {
  test('the sweep covers every wallet in keyset batches and detects the divergence on the next round', async () => {
    const wallets = [await openWallet('10.00'), await openWallet('20.00'), await openWallet('30.00')];
    const worker = new PeriodicReconciliationWorker({ useCase: services.reconcileAllWallets, logger });

    const clean = await worker.runOnce();
    expect(clean.ran).toBe(true);
    expect(clean.checked).toBeGreaterThanOrEqual(3); // lote de 2: vários lotes por keyset
    for (const wallet of wallets) expect(clean.divergentWalletIds).not.toContain(wallet.id);

    const target = wallets[1]!;
    await tamper(target.id, 'balance_amount', '1.00');
    try {
      const next = await worker.runOnce();
      expect(next.divergentWalletIds).toContain(target.id);
      expect(next.divergentWalletIds).not.toContain(wallets[0]!.id);
      expect(sweeps.at(-1)?.divergent).toBe(next.divergentWalletIds.length);
    } finally {
      await tamper(target.id, 'balance_amount', '-1.00');
    }
    const healed = await worker.runOnce();
    expect(healed.divergentWalletIds).not.toContain(target.id);
  });

  test('only one sweep runs at a time in the cluster (advisory lock): the other skips the round', async () => {
    const before = sweeps.length;
    const skipped = await app.em.fork().transactional(async (em) => {
      await em.execute('SELECT pg_advisory_xact_lock(?)', [RECONCILIATION_ADVISORY_LOCK_KEY]); // "outra instância" varrendo
      return services.reconcileAllWallets.execute();
    });
    expect(skipped).toEqual({ ran: false, checked: 0, divergentWalletIds: [] });
    expect(sweeps.length).toBe(before); // rodada pulada não conta como sucesso

    const afterRelease = await services.reconcileAllWallets.execute();
    expect(afterRelease.ran).toBe(true); // lock liberado no fim da transação
  });

  test('two simultaneous sweeps never run in parallel and never fail', async () => {
    const results = await Promise.all([services.reconcileAllWallets.execute(), services.reconcileAllWallets.execute()]);
    expect(results.some((result) => result.ran)).toBe(true);
  });

  test('start/stop loop runs a sweep immediately and stops cleanly', async () => {
    const before = sweeps.length;
    const worker = new PeriodicReconciliationWorker({
      useCase: services.reconcileAllWallets,
      options: { intervalMs: 60_000 },
      logger,
    });
    worker.start();
    await waitFor(() => sweeps.length > before, { message: 'the first sweep' });
    await worker.stop();
  });
});
