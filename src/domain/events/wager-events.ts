import type { MoneyProps } from '../money/money.ts';
import type { FailureCode } from '../wagering/failure-code.ts';
import type { WagerTransaction } from '../wagering/wager-transaction.ts';
import type { Wallet } from '../wallet/wallet.ts';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.ts';
import type { LedgerDirection } from '../ledger/ledger-direction.ts';
import { IntegrationEvent, type EventContext } from './integration-event.ts';
import { DomainError } from '../shared/domain-error.ts';

/** Evento não pôde ser montado porque a transação ainda não está no estado que o evento exige. */
export class InvalidEventError extends DomainError {
  readonly code = 'INVALID_EVENT';

  constructor(message: string) {
    super(message);
  }
}

interface TransactionIdentityData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

function identityOf(tx: WagerTransaction): TransactionIdentityData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new InvalidEventError(`Cannot build event: ${what} is missing`);
  }
  return value;
}

export interface WagerTransactionProcessedData extends TransactionIdentityData {
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps;
  walletVersion: number; // check-money:allow
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (saldo inalterado, `walletVersion` atual). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...identityOf(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balanceAfter: wallet.balance.toJSON(),
        walletVersion: wallet.version,
        processedAt: required(tx.processedAt, 'processedAt').toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionIdentityData {
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, rejectedAt: Date, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...identityOf(tx),
        failureCode: required(tx.failureCode, 'failureCode'),
        rejectedAt: rejectedAt.toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number; // check-money:allow
}

/** Publicado somente quando o saldo muda (literal do §11). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceExternalTransactionId: required(
          tx.referenceExternalTransactionId,
          'referenceExternalTransactionId',
        ),
        nextAttemptAt: required(tx.nextReferenceAttemptAt, 'nextReferenceAttemptAt').toISOString(),
      },
    });
  }
}
