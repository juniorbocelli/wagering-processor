import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm/orm-config.ts';

/**
 * Suporte aos testes de integração: PostgreSQL **real** (`bun run infra:up`), banco
 * `wagering_test`. Cada teste cria as próprias linhas (UUIDs novos); nenhuma tabela é
 * truncada, para permitir execução determinística e repetível.
 */
const HOST = process.env['TEST_POSTGRES_HOST'] ?? 'localhost:5432';

export const TEST_URLS = {
  owner:
    process.env['TEST_MIGRATION_DATABASE_URL'] ??
    `postgres://wagering_owner:wagering_owner@${HOST}/wagering_test`,
  app:
    process.env['TEST_DATABASE_URL'] ??
    `postgres://wagering_app:wagering_app@${HOST}/wagering_test`,
  superuser:
    process.env['TEST_SUPERUSER_DATABASE_URL'] ?? `postgres://postgres:postgres@${HOST}/wagering_test`,
} as const;

export type TestRole = keyof typeof TEST_URLS;

export async function connect(role: TestRole, poolMax = 5): Promise<MikroORM> {
  return MikroORM.init(buildOrmConfig({ clientUrl: TEST_URLS[role], poolMax }));
}

/** Aplica as migrations pendentes como `wagering_owner` (idempotente). */
export async function ensureSchema(): Promise<void> {
  const owner = await connect('owner', 2);
  try {
    await owner.migrator.up();
  } finally {
    await owner.close();
  }
}

export const uuid = (): string => crypto.randomUUID();

/** Statement avulso (autocommit). */
export async function sql<T = Record<string, unknown>>(
  orm: MikroORM,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await orm.em.fork().execute(text, params)) as T[];
}

/** Transação explícita: os triggers diferidos disparam no COMMIT (ao final do callback). */
export async function inTransaction<T>(
  orm: MikroORM,
  work: (em: EntityManager) => Promise<T>,
): Promise<T> {
  return orm.em.fork().transactional(work);
}

// ---- builders de linhas válidas (SQL direto, para provar o schema sem passar pelo domínio)

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}

export function walletRow(over: Partial<WalletRow> = {}): WalletRow {
  return { id: uuid(), playerId: `player-${uuid()}`, currency: 'BRL', balance: '0.00', version: 1, ...over };
}

export async function insertWallet(em: EntityManager, w: WalletRow): Promise<void> {
  await em.execute(
    `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, now(), now())`,
    [w.id, w.playerId, w.currency, w.balance, w.version],
  );
}

export interface TxRow {
  id: string;
  providerId: string;
  externalId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultBalance: string | null;
  processedAt: Date | null;
}

export function txRow(walletId: string, over: Partial<TxRow> = {}): TxRow {
  const id = uuid();
  const status = over.status ?? 'PROCESSED';
  return {
    id,
    providerId: 'provider-a',
    externalId: `ext-${id}`,
    idempotencyKey: `key-${id}`,
    walletId,
    playerId: 'player-x',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    referenceExternalId: null,
    referenceTransactionId: null,
    status,
    failureCode: null,
    resultBalance: status === 'PROCESSED' ? '0.00' : null,
    processedAt: status === 'PROCESSED' ? new Date() : null,
    ...over,
  };
}

export async function insertTx(em: EntityManager, t: TxRow): Promise<void> {
  await em.execute(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code, result_balance_amount, correlation_id, created_at, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'round', 'game', ?, ?, ?, ?, ?, ?, ?, ?, 'corr', now(), ?)`,
    [
      t.id, t.providerId, t.externalId, t.idempotencyKey, 'a'.repeat(64), t.walletId, t.playerId,
      t.kind, t.amount, t.currency, t.referenceExternalId, t.referenceTransactionId, t.status,
      t.failureCode, t.resultBalance, t.processedAt,
    ],
  );
}

export interface LedgerRow {
  id: string;
  walletId: string;
  currency: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  before: string;
  after: string;
  walletVersion: number;
}

export async function insertLedger(em: EntityManager, l: LedgerRow): Promise<void> {
  await em.execute(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, currency, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [l.id, l.walletId, l.currency, l.transactionId, l.direction, l.amount, l.before, l.after, l.walletVersion],
  );
}

export interface OpenedFixture {
  walletId: string;
  playerId: string;
  openingTxId: string;
}

/** Wallet aberta com saldo, `OPENING` processado e lançamento `wallet_version = 1`, atomicamente. */
export async function openWalletWithBalance(
  orm: MikroORM,
  balance = '100.00',
  currency = 'BRL',
): Promise<OpenedFixture> {
  const wallet = walletRow({ balance, currency });
  const opening = txRow(wallet.id, {
    kind: 'OPENING',
    providerId: 'internal',
    amount: balance,
    currency,
    playerId: wallet.playerId,
    idempotencyKey: `opening:${wallet.id}`,
    externalId: `opening:${wallet.id}`,
  });
  await inTransaction(orm, async (em) => {
    await insertWallet(em, wallet);
    await insertTx(em, opening);
    await insertLedger(em, {
      id: uuid(), walletId: wallet.id, currency, transactionId: opening.id,
      direction: 'CREDIT', amount: balance, before: '0.00', after: balance, walletVersion: 1,
    });
  });
  return { walletId: wallet.id, playerId: wallet.playerId, openingTxId: opening.id };
}

/** Wallet aberta com saldo zero: sem `OPENING` e sem lançamento (ADR-002). */
export async function openEmptyWallet(orm: MikroORM, currency = 'BRL'): Promise<OpenedFixture> {
  const wallet = walletRow({ currency });
  await inTransaction(orm, (em) => insertWallet(em, wallet));
  return { walletId: wallet.id, playerId: wallet.playerId, openingTxId: '' };
}
