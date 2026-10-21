import { EntitySchema } from '@mikro-orm/core';

/**
 * Modelos de persistência (ADR-005 §1): `EntitySchema` sem decorators e sem reflexão de
 * tipos, separados do domínio. Valores monetários são `string` (NUMERIC(19,2)) — o
 * `Record` nunca expõe `number` monetário. O domínio nunca vê estes tipos: mappers
 * convertem `Record ⇄ Domínio`.
 *
 * Colunas de data: `timestamptz`. `version`/contadores são `integer` (não monetários).
 */

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  version: number; // check-money:allow
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  payloadHashVersion: number; // check-money:allow
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultBalanceAmount: string | null;
  referenceAttempts: number; // check-money:allow
  nextReferenceAttemptAt: Date | null;
  correlationId: string;
  createdAt: Date;
  processedAt: Date | null;
}

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  currency: string;
  transactionId: string;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number; // check-money:allow
  createdAt: Date;
}

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date;
}

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number; // check-money:allow
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number; // check-money:allow
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  publishedAt: Date | null;
  lastError: string | null;
}

const money = { type: 'decimal', precision: 19, scale: 2 } as const;
const timestamptz = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletRecordSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', fieldName: 'player_id', length: 128 },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceAmount: { ...money, fieldName: 'balance_amount' },
    version: { type: 'integer' },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
    updatedAt: { ...timestamptz, fieldName: 'updated_at' },
  },
});

export const WagerTransactionRecordSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id', length: 64 },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id', length: 128 },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', length: 255 },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    payloadHashVersion: { type: 'smallint', fieldName: 'payload_hash_version' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id', length: 128 },
    roundId: { type: 'string', fieldName: 'round_id', length: 128 },
    gameId: { type: 'string', fieldName: 'game_id', length: 128 },
    kind: { type: 'string', length: 16 },
    amount: money,
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      length: 128,
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string', length: 20 },
    failureCode: { type: 'string', fieldName: 'failure_code', length: 64, nullable: true },
    resultBalanceAmount: { ...money, fieldName: 'result_balance_amount', nullable: true },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: { ...timestamptz, fieldName: 'next_reference_attempt_at', nullable: true },
    correlationId: { type: 'string', fieldName: 'correlation_id', length: 128 },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
    processedAt: { ...timestamptz, fieldName: 'processed_at', nullable: true },
  },
});

export const LedgerEntryRecordSchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', length: 6 },
    amount: money,
    balanceBefore: { ...money, fieldName: 'balance_before' },
    balanceAfter: { ...money, fieldName: 'balance_after' },
    walletVersion: { type: 'integer', fieldName: 'wallet_version' },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
  },
});

export const InboxRecordSchema = new EntitySchema<InboxRecord>({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', length: 64, primary: true },
    messageId: { type: 'string', fieldName: 'message_id', length: 128, primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    receivedAt: { ...timestamptz, fieldName: 'received_at' },
    processedAt: { ...timestamptz, fieldName: 'processed_at' },
  },
});

/** `seq` (identity) é gerenciada pelo banco e lida apenas por SQL bruto (ADR-004 §4). */
export const OutboxRecordSchema = new EntitySchema<OutboxRecord>({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type', length: 64 },
    eventVersion: { type: 'smallint', fieldName: 'event_version' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { ...timestamptz, fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamptz, fieldName: 'next_attempt_at' },
    lockedUntil: { ...timestamptz, fieldName: 'locked_until', nullable: true },
    lockedBy: { type: 'string', fieldName: 'locked_by', length: 128, nullable: true },
    publishedAt: { ...timestamptz, fieldName: 'published_at', nullable: true },
    lastError: { type: 'string', fieldName: 'last_error', length: 512, nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletRecordSchema,
  WagerTransactionRecordSchema,
  LedgerEntryRecordSchema,
  InboxRecordSchema,
  OutboxRecordSchema,
];
