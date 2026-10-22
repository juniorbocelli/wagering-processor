import { Money } from '../../../../domain/money/money.ts';
import { Wallet } from '../../../../domain/wallet/wallet.ts';
import { WagerTransaction } from '../../../../domain/wagering/wager-transaction.ts';
import { WalletLedgerEntry } from '../../../../domain/ledger/wallet-ledger-entry.ts';
import { InboxMessage, InvalidInboxStateError } from '../../../../domain/messaging/inbox-message.ts';
import { OutboxMessage } from '../../../../domain/messaging/outbox-message.ts';
import { isFailureCode, type FailureCode } from '../../../../domain/wagering/failure-code.ts';
import { isLedgerDirection, type LedgerDirection } from '../../../../domain/ledger/ledger-direction.ts';
import {
  isWagerTransactionKind,
  isWagerTransactionStatus,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../../domain/wagering/wager-transaction-kind.ts';
import type {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../schemas/records.ts';

/** Colunas `NUMERIC(19,2)` chegam como string canônica; nunca passam por `number`. */
const moneyOf = (amount: string, currency: string): Money => Money.rehydrate({ amount, currency });

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

function parseKind(raw: string): WagerTransactionKind {
  if (!isWagerTransactionKind(raw)) {
    throw new Error(`Corrupted WagerTransactionRecord: unknown kind "${raw}"`);
  }
  return raw;
}

function parseStatus(raw: string): WagerTransactionStatus {
  if (!isWagerTransactionStatus(raw)) {
    throw new Error(`Corrupted WagerTransactionRecord: unknown status "${raw}"`);
  }
  return raw;
}

function parseFailureCode(raw: string | null): FailureCode | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isFailureCode(raw)) {
    throw new Error(`Corrupted WagerTransactionRecord: unknown failureCode "${raw}"`);
  }
  return raw;
}

function parseDirection(raw: string): LedgerDirection {
  if (!isLedgerDirection(raw)) {
    throw new Error(`Corrupted LedgerEntryRecord: unknown direction "${raw}"`);
  }
  return raw;
}

export const walletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: moneyOf(record.balanceAmount, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceAmount: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },
};

export const wagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      payloadHashVersion: record.payloadHashVersion,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: parseKind(record.kind),
      money: moneyOf(record.amount, record.currency),
      referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
      correlationId: record.correlationId,
      createdAt: record.createdAt,
      status: parseStatus(record.status),
      referenceTransactionId: orUndefined(record.referenceTransactionId),
      failureCode: parseFailureCode(record.failureCode),
      resultBalance:
        record.resultBalanceAmount === null
          ? undefined
          : moneyOf(record.resultBalanceAmount, record.currency),
      processedAt: orUndefined(record.processedAt),
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: orUndefined(record.nextReferenceAttemptAt),
    });
  },

  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      payloadHashVersion: tx.payloadHashVersion,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toString(),
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      resultBalanceAmount: tx.resultBalance?.toString() ?? null,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
      correlationId: tx.correlationId,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
    };
  },
};

export const ledgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: parseDirection(record.direction),
      money: moneyOf(record.amount, record.currency),
      balanceBefore: moneyOf(record.balanceBefore, record.currency),
      balanceAfter: moneyOf(record.balanceAfter, record.currency),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      currency: entry.money.currency,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },
};

export const inboxMapper = {
  toDomain(record: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: record.messageId,
      consumerName: record.consumerName,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt,
    });
  },

  /**
   * A linha só existe se a transação de negócio comitou (ADR-004 §2): persistir exige a
   * mensagem já marcada como processada (o use case a marca na própria transação).
   */
  toRecord(message: InboxMessage): InboxRecord {
    if (message.processedAt === undefined) {
      throw new InvalidInboxStateError('Only processed inbox messages can be persisted');
    }
    return {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt,
    };
  },
};

export const outboxMapper = {
  toDomain(record: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      eventVersion: record.eventVersion,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      lockedUntil: orUndefined(record.lockedUntil),
      lockedBy: orUndefined(record.lockedBy),
      publishedAt: orUndefined(record.publishedAt),
      lastError: orUndefined(record.lastError),
    });
  },

  toRecord(message: OutboxMessage): OutboxRecord {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      eventVersion: message.eventVersion,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      lockedUntil: message.lockedUntil ?? null,
      lockedBy: message.lockedBy ?? null,
      publishedAt: message.publishedAt ?? null,
      lastError: message.lastError ?? null,
    };
  },
};
