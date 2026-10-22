import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { FaultInjector, FaultPoint } from '../../src/application/ports/runtime.ts';
import { sql } from './db.ts';

/**
 * Invariante final de todo teste de integração (§13): `wallet.balance == saldo reconstruído
 * pelo ledger`, mais a corrente contínua (`balance_before = balance_after` anterior,
 * `wallet_version` sem saltos) e `wallet.version = coalesce(último wallet_version, 1)`.
 * Tudo calculado em SQL `NUMERIC` — nunca em `number`.
 */
export async function assertLedgerConsistency(orm: MikroORM, walletId: string): Promise<void> {
  const [wallet] = await sql<{ balance_amount: string; version: number }>(
    orm,
    'SELECT balance_amount, version FROM wallets WHERE id = ?',
    [walletId],
  );
  expect(wallet).toBeDefined();

  const [totals] = await sql<{ calculated: string; entries: string; last_version: number | null }>(
    orm,
    `SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS calculated,
            count(*)::text AS entries,
            max(wallet_version) AS last_version
       FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  );
  expect(Number(totals!.entries)).toBeGreaterThanOrEqual(0);
  expect(await sql(orm, 'SELECT ?::numeric = ?::numeric AS equal', [wallet!.balance_amount, totals!.calculated])).toEqual([
    { equal: true },
  ]);
  expect(wallet!.version).toBe(totals!.last_version ?? 1);
  expect(await sql(orm, 'SELECT ?::numeric >= 0 AS non_negative', [wallet!.balance_amount])).toEqual([
    { non_negative: true },
  ]);

  const broken = await sql(
    orm,
    `SELECT wallet_version FROM (
       SELECT wallet_version, balance_before,
              lag(balance_after) OVER (ORDER BY wallet_version) AS prev_after,
              lag(wallet_version) OVER (ORDER BY wallet_version) AS prev_version
         FROM wallet_ledger_entries WHERE wallet_id = ?) chain
      WHERE (prev_after IS NOT NULL AND balance_before <> prev_after)
         OR (prev_version IS NOT NULL AND wallet_version <> prev_version + 1)`,
    [walletId],
  );
  expect(broken).toEqual([]);
}

/** Injetor de falhas de teste: dispara uma exceção uma única vez no ponto armado. */
export class ThrowingFaultInjector implements FaultInjector {
  private armed = new Set<FaultPoint>();

  arm(point: FaultPoint): void {
    this.armed.add(point);
  }

  trigger(point: FaultPoint): void {
    if (this.armed.delete(point)) {
      throw new Error(`injected fault at ${point}`);
    }
  }
}
