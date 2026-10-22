import {
  StaleAggregateError,
  type InboxRepository,
  type LedgerRepository,
  type OutboxRepository,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../../application/ports/persistence.ts';
import { Wallet } from '../../../domain/wallet/wallet.ts';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction.ts';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry.ts';
import type { InboxMessage } from '../../../domain/messaging/inbox-message.ts';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.ts';
import {
  inboxMapper,
  ledgerEntryMapper,
  outboxMapper,
  wagerTransactionMapper,
  walletMapper,
} from './mappers/mappers.ts';
import {
  LedgerEntryRecordSchema,
  OutboxRecordSchema,
  WagerTransactionRecordSchema,
  WalletRecordSchema,
  type LedgerEntryRecord,
  type WagerTransactionRecord,
  type WalletRecord,
} from './schemas/records.ts';
import { EntityManagerContext, LockMode } from './mikro-orm-unit-of-work.ts';

/**
 * Os repositórios escrevem com statements imediatos (`em.insert` / `nativeUpdate`):
 * a ordem das escritas dentro da transação é a ordem das chamadas (as FKs são
 * `DEFERRABLE INITIALLY DEFERRED`, então a ordem entre tabelas é livre de qualquer forma).
 * Leituras usam `refresh: true` para nunca servir uma linha obsoleta do Identity Map.
 * Toda escrita exige uma transação ativa (`UnitOfWork.run`): fora dela falha em vez de
 * gravar em autocommit.
 */

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async lockById(id: string): Promise<Wallet | null> {
    const em = this.context.requireTransactional();
    const record = await em.findOne(
      WalletRecordSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return this.hydrate(record);
  }

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.context.current().findOne(WalletRecordSchema, { id }, { refresh: true });
    return this.hydrate(record);
  }

  async add(wallet: Wallet): Promise<void> {
    await this.context.requireTransactional().insert(WalletRecordSchema, walletMapper.toRecord(wallet));
    wallet.markPersisted();
  }

  async save(wallet: Wallet): Promise<void> {
    const expected = wallet.persistedVersion;
    if (expected === undefined) {
      throw new Error(`Wallet ${wallet.id} was never persisted; use add()`);
    }
    const record = walletMapper.toRecord(wallet);
    const affected = await this.context.requireTransactional().nativeUpdate(
      WalletRecordSchema,
      { id: wallet.id, version: expected },
      { balanceAmount: record.balanceAmount, version: record.version, updatedAt: record.updatedAt },
    );
    if (affected !== 1) {
      throw new StaleAggregateError('Wallet', wallet.id);
    }
    wallet.markPersisted();
  }

  private hydrate(record: WalletRecord | null): Wallet | null {
    return record === null ? null : walletMapper.toDomain(record);
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async add(tx: WagerTransaction): Promise<void> {
    await this.context
      .requireTransactional()
      .insert(WagerTransactionRecordSchema, wagerTransactionMapper.toRecord(tx));
  }

  /**
   * Só uma transação ainda em `PENDING_REFERENCE` pode ser atualizada: o predicado detecta
   * resolução concorrente (e o trigger do banco barra qualquer outra transição).
   */
  async update(tx: WagerTransaction): Promise<void> {
    const record = wagerTransactionMapper.toRecord(tx);
    const affected = await this.context.requireTransactional().nativeUpdate(
      WagerTransactionRecordSchema,
      { id: tx.id, status: 'PENDING_REFERENCE' },
      {
        status: record.status,
        failureCode: record.failureCode,
        referenceTransactionId: record.referenceTransactionId,
        resultBalanceAmount: record.resultBalanceAmount,
        processedAt: record.processedAt,
        referenceAttempts: record.referenceAttempts,
        nextReferenceAttemptAt: record.nextReferenceAttemptAt,
      },
    );
    if (affected !== 1) {
      throw new StaleAggregateError('WagerTransaction', tx.id);
    }
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.one(await this.context.current().findOne(WagerTransactionRecordSchema, { id }, { refresh: true }));
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.one(
      await this.context
        .current()
        .findOne(WagerTransactionRecordSchema, { providerId, externalTransactionId }, { refresh: true }),
    );
  }

  async findByIdempotencyOrExternalId(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const records = await this.context.current().find(
      WagerTransactionRecordSchema,
      { providerId, $or: [{ idempotencyKey }, { externalTransactionId }] },
      { refresh: true },
    );
    return records.map((record: WagerTransactionRecord) => wagerTransactionMapper.toDomain(record));
  }

  async listPendingByReference(
    walletId: string,
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const records = await this.context.current().find(
      WagerTransactionRecordSchema,
      { walletId, providerId, referenceExternalTransactionId, status: 'PENDING_REFERENCE' },
      { orderBy: { createdAt: 'asc', id: 'asc' }, refresh: true },
    );
    return records.map((record: WagerTransactionRecord) => wagerTransactionMapper.toDomain(record));
  }

  async existsProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    const count = await this.context.current().count(WagerTransactionRecordSchema, {
      referenceTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  private one(record: WagerTransactionRecord | null): WagerTransaction | null {
    return record === null ? null : wagerTransactionMapper.toDomain(record);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async add(entry: WalletLedgerEntry): Promise<void> {
    await this.context.requireTransactional().insert(LedgerEntryRecordSchema, ledgerEntryMapper.toRecord(entry));
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null> {
    const record = await this.context
      .current()
      .findOne(LedgerEntryRecordSchema, { transactionId }, { refresh: true });
    return record === null ? null : ledgerEntryMapper.toDomain(record);
  }

  async listByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
    const records = await this.context
      .current()
      .find(LedgerEntryRecordSchema, { walletId }, { orderBy: { walletVersion: 'asc' }, refresh: true });
    return records.map((record: LedgerEntryRecord) => ledgerEntryMapper.toDomain(record));
  }

  async listPage(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> { // check-money:allow
    const records = await this.context.current().find(
      LedgerEntryRecordSchema,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit, refresh: true },
    );
    return records.map((record: LedgerEntryRecord) => ledgerEntryMapper.toDomain(record));
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const record = inboxMapper.toRecord(message);
    const result = await this.context.requireTransactional().execute<{ affectedRows: number }>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [record.consumerName, record.messageId, record.payloadHash, record.receivedAt, record.processedAt],
      'run',
    );
    return result.affectedRows === 1;
  }

  async findPayloadHash(consumerName: string, messageId: string): Promise<string | null> {
    const rows = await this.context.current().execute<{ payload_hash: string }[]>(
      'SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      [consumerName, messageId],
    );
    return rows[0]?.payload_hash ?? null;
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async add(message: OutboxMessage): Promise<void> {
    await this.context.requireTransactional().insert(OutboxRecordSchema, outboxMapper.toRecord(message));
  }
}
