import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../src/application/use-cases/process-wager-transaction.ts';
import type { WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { sql, uuid } from './db.ts';

export interface TestWallet {
  id: string;
  playerId: string;
}

/**
 * Fixtures dos testes que exercitam os casos de uso contra o PostgreSQL real. Cada teste
 * cria as próprias wallets (UUIDs novos): nada é truncado, a execução é repetível.
 */
export function createFixtures(getApp: () => MikroORM, services: () => WageringServices) {
  let counter = 0; // check-money:allow

  const ctx = () => ({ correlationId: `corr-${uuid()}` });

  async function openWallet(balance = '100.00', currency = 'BRL'): Promise<TestWallet> {
    const wallet = await services().openWallet.execute(
      { playerId: `player-${uuid()}`, initialBalance: { amount: balance, currency } },
      ctx(),
    );
    return { id: wallet.id, playerId: wallet.playerId };
  }

  function cmd(wallet: TestWallet, over: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
    counter += 1;
    const externalTransactionId = over.externalTransactionId ?? `ext-${uuid()}-${counter}`;
    return {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...over,
    };
  }

  const run = (command: ProcessWagerTransactionCommand) => services().processWagerTransaction.execute(command, ctx());

  function txOf(result: ProcessWagerTransactionResult) {
    if (result.kind === 'duplicate-delivery') throw new Error('unexpected duplicate-delivery');
    return result.transaction;
  }

  async function balanceOf(walletId: string): Promise<string> {
    const [row] = await sql<{ balance_amount: string }>(getApp(), 'SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
    return row!.balance_amount;
  }

  async function count(table: string, where: string, params: unknown[]): Promise<number> { // check-money:allow
    const [row] = await sql<{ n: string }>(getApp(), `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params);
    return Number(row!.n);
  }

  const ledgerCount = (walletId: string, direction?: 'DEBIT' | 'CREDIT') =>
    direction === undefined
      ? count('wallet_ledger_entries', 'wallet_id = ?', [walletId])
      : count('wallet_ledger_entries', 'wallet_id = ? AND direction = ?', [walletId, direction]);

  const outboxCount = (walletId: string) => count('outbox_messages', 'aggregate_id = ?', [walletId]);

  return { ctx, openWallet, cmd, run, txOf, balanceOf, count, ledgerCount, outboxCount };
}
