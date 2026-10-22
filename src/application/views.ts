import type { MoneyProps } from '../domain/money/money.ts';
import type { Wallet } from '../domain/wallet/wallet.ts';
import type { WagerTransaction } from '../domain/wagering/wager-transaction.ts';
import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry.ts';

/**
 * Modelos de leitura devolvidos pelos casos de uso. Valores monetários são sempre
 * `MoneyProps` (string decimal + moeda), nunca `number`; datas são ISO-8601.
 */

export interface WalletView {
  /** Mesmo valor de `walletId`; `id` segue o contrato do §9 do edital. */
  id: string;
  walletId: string;
  playerId: string;
  balance: MoneyProps;
  version: number; // check-money:allow
  createdAt: string;
  updatedAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    walletId: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  status: string;
  kind: string;
  amount: MoneyProps;
  failureCode: string | null;
  /**
   * Saldo observado ao decidir (replay fiel, §7.7). `null` enquanto a transação aguarda a
   * referência e nas rejeições em que não há saldo divulgável (ADR-007).
   */
  balance: MoneyProps | null;
  referenceTransactionId: string | null;
  processedAt: string | null;
}

export function toTransactionView(transaction: WagerTransaction): TransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    status: transaction.status,
    kind: transaction.kind,
    amount: transaction.money.toJSON(),
    failureCode: transaction.failureCode ?? null,
    balance: transaction.resultBalance?.toJSON() ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

export interface LedgerEntryView {
  entryId: string;
  transactionId: string;
  direction: string;
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number; // check-money:allow
  createdAt: string;
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    entryId: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  /** Cursor opaco da próxima página; `null` na última. */
  nextCursor: string | null;
}
