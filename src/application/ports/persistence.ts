import type { Wallet } from '../../domain/wallet/wallet.ts';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.ts';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.ts';
import type { InboxMessage } from '../../domain/messaging/inbox-message.ts';
import type { OutboxMessage } from '../../domain/messaging/outbox-message.ts';

/**
 * Fronteira transacional (ADR-005 §3): tudo que os repositórios fizerem dentro de `run`
 * participa de **uma** transação SQL; exceção → rollback integral. Repositórios usados
 * fora de `run` fazem leituras avulsas, sem lock.
 */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** Violação de escrita concorrente detectada pelo `UPDATE … WHERE version = ?` (defesa secundária). */
export class StaleAggregateError extends Error {
  constructor(aggregate: string, id: string) {
    super(`${aggregate} ${id} was modified concurrently`);
    this.name = 'StaleAggregateError';
  }
}

export interface WalletRepository {
  /** `SELECT … FOR UPDATE` (ADR-002): primeira leitura da wallet na transação. */
  lockById(id: string): Promise<Wallet | null>;
  findById(id: string): Promise<Wallet | null>;
  add(wallet: Wallet): Promise<void>;
  /** `UPDATE … WHERE id = ? AND version = <versão carregada>`; lança {@link StaleAggregateError}. */
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  add(tx: WagerTransaction): Promise<void>;
  /** Persiste uma transição de `PENDING_REFERENCE` (colunas mutáveis apenas). */
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Lookup único da idempotência (ADR-003 §3): por key **ou** por id externo do provedor. */
  findByIdempotencyOrExternalId(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  /** Lançamentos de uma wallet em ordem de `walletVersion`. */
  listByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
}

export interface InboxRepository {
  /** `INSERT … ON CONFLICT DO NOTHING`; `false` se já existia (entrega duplicada). */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
}
