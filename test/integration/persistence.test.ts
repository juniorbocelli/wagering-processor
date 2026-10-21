import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { StaleAggregateError } from '../../src/application/ports/persistence.ts';
import { Money } from '../../src/domain/money/money.ts';
import { Wallet } from '../../src/domain/wallet/wallet.ts';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.ts';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind.ts';
import { InboxMessage } from '../../src/domain/messaging/inbox-message.ts';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.ts';
import { WalletBalanceChanged } from '../../src/domain/events/wager-events.ts';
import {
  EntityManagerContext,
  MikroOrmUnitOfWork,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work.ts';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/repositories.ts';
import { connect, ensureSchema, sql, uuid } from '../support/db.ts';

/**
 * Smoke Bun × MikroORM (risco do ADR-005): round-trip de cada Record pelo adapter real,
 * como `wagering_app` (papel de runtime), contra PostgreSQL real.
 */
let app: MikroORM;
let uow: MikroOrmUnitOfWork;
let wallets: MikroOrmWalletRepository;
let transactions: MikroOrmWagerTransactionRepository;
let ledger: MikroOrmLedgerRepository;
let inbox: MikroOrmInboxRepository;
let outbox: MikroOrmOutboxRepository;

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 10);
  const context = new EntityManagerContext(app);
  uow = new MikroOrmUnitOfWork(app, context);
  wallets = new MikroOrmWalletRepository(context);
  transactions = new MikroOrmWagerTransactionRepository(context);
  ledger = new MikroOrmLedgerRepository(context);
  inbox = new MikroOrmInboxRepository(context);
  outbox = new MikroOrmOutboxRepository(context);
});

afterAll(async () => {
  await app.close();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = () => new Date();

/** Inbox só é persistida já processada (ADR-004 §2): marcada na própria transação de negócio. */
function processedInbox(props: Parameters<typeof InboxMessage.receive>[0]): InboxMessage {
  const message = InboxMessage.receive(props);
  message.markProcessed(props.receivedAt);
  return message;
}

/** Abre wallet com saldo + OPENING + lançamento + evento na outbox, na mesma transação. */
async function openWallet(initial: string) {
  const walletId = uuid();
  const openingTxId = uuid();
  const at = now();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: `player-${walletId}`,
    initialBalance: brl(initial),
    at,
    opening: { transactionId: openingTxId, entryId: uuid() },
  });
  await uow.run(async () => {
    await wallets.add(wallet);
    if (openingEntry !== undefined) {
      const opening = WagerTransaction.createOpening({
        id: openingTxId,
        walletId,
        playerId: wallet.playerId,
        money: brl(initial),
        payloadHash: 'c'.repeat(64),
        correlationId: 'corr-open',
        createdAt: at,
      });
      opening.markProcessed(undefined, at, wallet.balance);
      await transactions.add(opening);
      await ledger.add(openingEntry);
      await outbox.add(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, openingEntry, {
            eventId: uuid(), correlationId: 'corr-open', occurredAt: at,
          }),
        ),
      );
    }
  });
  return { walletId, openingTxId, wallet };
}

function newBet(walletId: string, playerId: string, amount: string) {
  const id = uuid();
  return WagerTransaction.create({
    id,
    providerId: 'provider-a',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `provider-a:ext-${id}`,
    payloadHash: 'd'.repeat(64),
    walletId,
    playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl(amount),
    correlationId: 'corr-bet',
    createdAt: now(),
  });
}

describe('round-trip of every Record', () => {
  test('wallet, OPENING transaction, ledger entry and outbox message', async () => {
    const { walletId, openingTxId, wallet } = await openWallet('100.00');

    const loaded = await wallets.findById(walletId);
    expect(loaded?.balance.toString()).toBe('100.00');
    expect(loaded?.currency).toBe('BRL');
    expect(loaded?.version).toBe(1);
    expect(loaded?.playerId).toBe(wallet.playerId);

    const opening = await transactions.findById(openingTxId);
    expect(opening?.kind).toBe(Kind.Opening);
    expect(opening?.status).toBe('PROCESSED');
    expect(opening?.providerId).toBe('internal');
    expect(opening?.money.toString()).toBe('100.00');
    expect(opening?.resultBalance?.toString()).toBe('100.00');
    expect(opening?.processedAt).toBeInstanceOf(Date);
    expect(opening?.referenceTransactionId).toBeUndefined();

    const entries = await ledger.listByWallet(walletId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.walletVersion).toBe(1);
    expect(entries[0]?.balanceBefore.toString()).toBe('0.00');
    expect(entries[0]?.balanceAfter.toString()).toBe('100.00');
    expect((await ledger.findByTransactionId(openingTxId))?.id).toBe(entries[0]!.id);

    const [row] = await sql<{ event_type: string; payload: { data: { balanceAfter: { amount: string } } }; seq: string }>(
      app,
      `SELECT event_type, payload, seq FROM outbox_messages WHERE aggregate_id = ?`,
      [walletId],
    );
    expect(row?.event_type).toBe('WalletBalanceChanged');
    expect(row?.payload.data.balanceAfter.amount).toBe('100.00');
  });

  test('monetary columns are hydrated as strings, never as number', async () => {
    const { walletId } = await openWallet('1234.50');
    const em = app.em.fork();
    const [raw] = await em.execute<{ balance_amount: unknown }[]>('SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
    expect(typeof raw?.balance_amount).toBe('string');
    const wallet = await wallets.findById(walletId);
    expect(wallet?.balance.toString()).toBe('1234.50');
  });

  test('wallet opened with zero balance has no ledger and no OPENING', async () => {
    const { walletId } = await openWallet('0');
    expect(await ledger.listByWallet(walletId)).toEqual([]);
    expect((await wallets.findById(walletId))?.version).toBe(1);
  });

  test('null columns round-trip as undefined; a PENDING_REFERENCE transaction round-trips', async () => {
    const { walletId, wallet } = await openWallet('50.00');
    const id = uuid();
    const refund = WagerTransaction.create({
      id,
      providerId: 'provider-a',
      externalTransactionId: `ext-${id}`,
      idempotencyKey: `key-${id}`,
      payloadHash: 'e'.repeat(64),
      walletId,
      playerId: wallet.playerId,
      roundId: 'r',
      gameId: 'g',
      kind: Kind.Refund,
      referenceExternalTransactionId: 'ext-missing',
      money: brl('5.00'),
      correlationId: 'corr',
      createdAt: now(),
    });
    const next = new Date(Date.now() + 1000);
    refund.markPendingReference(next);
    await uow.run(() => transactions.add(refund));

    const loaded = await transactions.findByExternalId('provider-a', `ext-${id}`);
    expect(loaded?.status).toBe('PENDING_REFERENCE');
    expect(loaded?.referenceExternalTransactionId).toBe('ext-missing');
    expect(loaded?.referenceTransactionId).toBeUndefined();
    expect(loaded?.failureCode).toBeUndefined();
    expect(loaded?.resultBalance).toBeUndefined();
    expect(loaded?.nextReferenceAttemptAt?.getTime()).toBe(next.getTime());

    // transição persistida: PENDING_REFERENCE → REJECTED(REFERENCE_NOT_FOUND)
    loaded!.reject('REFERENCE_NOT_FOUND', wallet.balance);
    await uow.run(() => transactions.update(loaded!));
    const rejected = await transactions.findById(id);
    expect(rejected?.status).toBe('REJECTED');
    expect(rejected?.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(rejected?.nextReferenceAttemptAt).toBeUndefined();
  });

  test('single lookup by idempotency key OR external id', async () => {
    const { walletId, wallet } = await openWallet('50.00');
    const bet = newBet(walletId, wallet.playerId, '1.00');
    bet.markProcessed(undefined, now(), wallet.balance);
    await uow.run(() => transactions.add(bet));

    expect(await transactions.findByIdempotencyOrExternalId('provider-a', bet.idempotencyKey, 'other')).toHaveLength(1);
    expect(await transactions.findByIdempotencyOrExternalId('provider-a', 'other', bet.externalTransactionId)).toHaveLength(1);
    expect(await transactions.findByIdempotencyOrExternalId('provider-a', 'x', 'y')).toHaveLength(0);
    expect(await transactions.findByIdempotencyOrExternalId('provider-b', bet.idempotencyKey, 'y')).toHaveLength(0);
  });
});

describe('UnitOfWork', () => {
  test('debit: wallet UPDATE, transaction, ledger entry and event commit together', async () => {
    const { walletId, wallet } = await openWallet('100.00');
    const bet = newBet(walletId, wallet.playerId, '80.00');
    await uow.run(async () => {
      const locked = await wallets.lockById(walletId);
      const entry = locked!.debit({ entryId: uuid(), transactionId: bet.id, money: bet.money, at: now() });
      bet.markProcessed(undefined, now(), locked!.balance);
      await transactions.add(bet);
      await ledger.add(entry);
      await wallets.save(locked!);
      await outbox.add(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(locked!, entry, { eventId: uuid(), correlationId: 'c', occurredAt: now() }),
        ),
      );
    });
    const after = await wallets.findById(walletId);
    expect(after?.balance.toString()).toBe('20.00');
    expect(after?.version).toBe(2);
    const entries = await ledger.listByWallet(walletId);
    expect(entries.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT']);
    expect(entries.at(-1)?.walletVersion).toBe(2);
  });

  test('an error after the inserts rolls everything back (wallet, tx, ledger, outbox, inbox)', async () => {
    const { walletId, wallet } = await openWallet('100.00');
    const bet = newBet(walletId, wallet.playerId, '30.00');
    const messageId = uuid();
    await expect(
      uow.run(async () => {
        const locked = await wallets.lockById(walletId);
        await inbox.insertIfAbsent(
          processedInbox({ messageId, consumerName: 'wager', payloadHash: 'f'.repeat(64), receivedAt: now() }),
        );
        const entry = locked!.debit({ entryId: uuid(), transactionId: bet.id, money: bet.money, at: now() });
        bet.markProcessed(undefined, now(), locked!.balance);
        await transactions.add(bet);
        await ledger.add(entry);
        await wallets.save(locked!);
        await outbox.add(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(locked!, entry, { eventId: uuid(), correlationId: 'c', occurredAt: now() }),
          ),
        );
        throw new Error('injected failure after the ledger insert');
      }),
    ).rejects.toThrow('injected failure');

    expect((await wallets.findById(walletId))?.balance.toString()).toBe('100.00');
    expect(await transactions.findById(bet.id)).toBeNull();
    expect(await ledger.listByWallet(walletId)).toHaveLength(1);
    const [{ count } = { count: '-1' }] = await sql<{ count: string }>(
      app,
      `SELECT (SELECT count(*) FROM outbox_messages WHERE aggregate_id = ?) AS count`,
      [walletId],
    );
    expect(count).toBe('1'); // somente o evento de abertura
    const rows = await sql(app, `SELECT 1 FROM inbox_messages WHERE message_id = ?`, [messageId]);
    expect(rows).toHaveLength(0);
  });

  test('the DB rejects, at commit, a balance change without its ledger entry', async () => {
    const { walletId } = await openWallet('100.00');
    await expect(
      uow.run(async () => {
        const locked = await wallets.lockById(walletId);
        locked!.debit({ entryId: uuid(), transactionId: uuid(), money: brl('10.00'), at: now() });
        await wallets.save(locked!); // sem gravar o lançamento
      }),
    ).rejects.toThrow(/without a matching ledger entry/);
    expect((await wallets.findById(walletId))?.balance.toString()).toBe('100.00');
  });

  test('lockById is FOR UPDATE: a second transaction on the same wallet waits for the first', async () => {
    const { walletId } = await openWallet('100.00');
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstLocked!: () => void;
    const firstHasLock = new Promise<void>((resolve) => (firstLocked = resolve));

    const first = uow.run(async () => {
      await wallets.lockById(walletId);
      order.push('first:locked');
      firstLocked();
      await firstHolds;
      order.push('first:commit');
    });
    await firstHasLock;
    const second = uow.run(async () => {
      await wallets.lockById(walletId);
      order.push('second:locked');
    });
    await Bun.sleep(300);
    expect(order).toEqual(['first:locked']); // segunda continua bloqueada no FOR UPDATE
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:locked', 'first:commit', 'second:locked']);
  });

  test('lockById on different wallets does not block (no global lock)', async () => {
    const a = await openWallet('10.00');
    const b = await openWallet('10.00');
    let releaseA!: () => void;
    const aHolds = new Promise<void>((resolve) => (releaseA = resolve));
    let aLocked!: () => void;
    const aHasLock = new Promise<void>((resolve) => (aLocked = resolve));
    const first = uow.run(async () => {
      await wallets.lockById(a.walletId);
      aLocked();
      await aHolds;
    });
    await aHasLock;
    await uow.run(async () => {
      expect(await wallets.lockById(b.walletId)).not.toBeNull();
    });
    releaseA();
    await first;
  });

  test('lockById outside a transaction is a programming error; unknown wallet yields null', async () => {
    await expect(wallets.lockById(uuid())).rejects.toThrow(/active UnitOfWork/);
    expect(await uow.run(() => wallets.lockById(uuid()))).toBeNull();
  });

  test('save detects a concurrent modification (UPDATE … WHERE version = ?)', async () => {
    const { walletId } = await openWallet('100.00');
    const stale = await wallets.findById(walletId); // lido sem lock
    await uow.run(async () => {
      const locked = await wallets.lockById(walletId);
      const txId = uuid();
      const at = now();
      const entry = locked!.credit({ entryId: uuid(), transactionId: txId, money: brl('5.00'), at });
      const tx = WagerTransaction.create({
        id: txId, providerId: 'provider-a', externalTransactionId: `e-${txId}`, idempotencyKey: `k-${txId}`,
        payloadHash: 'a'.repeat(64), walletId, playerId: locked!.playerId, roundId: 'r', gameId: 'g',
        kind: Kind.Win, money: brl('5.00'), correlationId: 'c', createdAt: at,
      });
      tx.markProcessed(undefined, at, locked!.balance);
      await transactions.add(tx);
      await ledger.add(entry);
      await wallets.save(locked!);
    });
    await expect(
      uow.run(async () => {
        stale!.credit({ entryId: uuid(), transactionId: uuid(), money: brl('1.00'), at: now() });
        await wallets.save(stale!);
      }),
    ).rejects.toThrow(StaleAggregateError);
  });

  test('nested run reuses the current transaction', async () => {
    const { walletId } = await openWallet('10.00');
    await expect(
      uow.run(async () => {
        await uow.run(async () => {
          await wallets.lockById(walletId);
        });
        throw new Error('outer failure');
      }),
    ).rejects.toThrow('outer failure');
  });
});

describe('writes require an active transaction', () => {
  test('every mutating repository method fails outside UnitOfWork.run', async () => {
    const { wallet } = await openWallet('10.00');
    const bet = newBet(wallet.id, wallet.playerId, '1.00');
    const entry = (await ledger.listByWallet(wallet.id))[0]!;
    const inboxMessage = processedInbox({ messageId: uuid(), consumerName: 'wager', payloadHash: 'a'.repeat(64), receivedAt: now() });
    const event = OutboxMessage.enqueue(
      WalletBalanceChanged.from(wallet, entry, { eventId: uuid(), correlationId: 'c', occurredAt: now() }),
    );
    const { wallet: fresh } = Wallet.open({ id: uuid(), playerId: 'p', initialBalance: brl('0'), at: now() });
    const attempts = [
      wallets.add(fresh),
      wallets.save(wallet),
      transactions.add(bet),
      transactions.update(bet),
      ledger.add(entry),
      inbox.insertIfAbsent(inboxMessage),
      outbox.add(event),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toThrow(/active UnitOfWork/);
    }
  });

  test('save of a never-persisted wallet is a programming error', async () => {
    const { wallet } = Wallet.open({ id: uuid(), playerId: 'p', initialBalance: brl('0'), at: now() });
    await expect(uow.run(() => wallets.save(wallet))).rejects.toThrow(/never persisted/);
  });

  test('inbox repository refuses unprocessed messages', async () => {
    const message = InboxMessage.receive({ messageId: uuid(), consumerName: 'wager', payloadHash: 'a'.repeat(64), receivedAt: now() });
    await expect(uow.run(() => inbox.insertIfAbsent(message))).rejects.toThrow(/processed inbox messages/);
  });

  test('UnitOfWork rejects malformed timeout durations', () => {
    const context = new EntityManagerContext(app);
    expect(() => new MikroOrmUnitOfWork(app, context, { lockTimeout: "3s'; DROP TABLE wallets;--", statementTimeout: '5s' })).toThrow(/Invalid PostgreSQL duration/);
    expect(() => new MikroOrmUnitOfWork(app, context, { lockTimeout: '3s', statementTimeout: '5000ms' })).not.toThrow();
  });
});

describe('InboxRepository', () => {
  test('insertIfAbsent reports duplicates and keeps the first hash', async () => {
    const messageId = uuid();
    const receive = (hash: string) =>
      processedInbox({ messageId, consumerName: 'wager', payloadHash: hash.repeat(64), receivedAt: now() });
    expect(await uow.run(() => inbox.insertIfAbsent(receive('a')))).toBe(true);
    expect(await uow.run(() => inbox.insertIfAbsent(receive('b')))).toBe(false);
    const [row] = await sql<{ payload_hash: string }>(app, 'SELECT payload_hash FROM inbox_messages WHERE message_id = ?', [messageId]);
    expect(row?.payload_hash).toBe('a'.repeat(64));
  });

  test('concurrent deliveries of the same message: exactly one wins', async () => {
    const messageId = uuid();
    const receive = () =>
      processedInbox({ messageId, consumerName: 'wager', payloadHash: 'a'.repeat(64), receivedAt: now() });
    const results = await Promise.all(Array.from({ length: 10 }, () => uow.run(() => inbox.insertIfAbsent(receive()))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
