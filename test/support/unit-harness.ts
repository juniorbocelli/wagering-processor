import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../src/application/ports/persistence.ts';
import type { Clock, IdGenerator } from '../../src/application/ports/runtime.ts';
import { WagerSettlement } from '../../src/application/use-cases/wager-settlement.ts';
import { ProcessWagerTransactionUseCase, type ProcessWagerTransactionCommand } from '../../src/application/use-cases/process-wager-transaction.ts';
import { OpenWalletUseCase } from '../../src/application/use-cases/open-wallet.ts';
import { ReprocessPendingReferenceUseCase } from '../../src/application/use-cases/reprocess-pending-reference.ts';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/application/pending-reference-policy.ts';
import { NOOP_FAULT_INJECTOR } from '../../src/application/ports/runtime.ts';
import { CanonicalJsonSha256Hasher } from '../../src/infrastructure/hashing/canonical-json-sha256-hasher.ts';
import type { Wallet } from '../../src/domain/wallet/wallet.ts';
import type { WagerTransaction } from '../../src/domain/wagering/wager-transaction.ts';
import type { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry.ts';
import type { InboxMessage } from '../../src/domain/messaging/inbox-message.ts';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message.ts';
import { StaleAggregateError } from '../../src/application/ports/persistence.ts';

/**
 * Repositórios em memória **apenas** para provar regras puras de negócio nos testes de
 * unidade. Atomicidade, locks e constraints são provados contra o PostgreSQL real
 * (`test/integration`). Não há rollback aqui — não use para provar atomicidade.
 */
export class InMemoryStore {
  wallets = new Map<string, Wallet>();
  transactions = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  outbox: OutboxMessage[] = [];
  inbox = new Map<string, InboxMessage>();
}

export class FakeClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void { // check-money:allow
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0; // check-money:allow
  next(): string {
    this.counter += 1;
    return `00000000-0000-7000-8000-${this.counter.toString().padStart(12, '0')}`;
  }
}

const inboxKey = (consumer: string, id: string) => `${consumer}\u0000${id}`;

export function buildUnitHarness() {
  const store = new InMemoryStore();
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const hasher = new CanonicalJsonSha256Hasher();

  const uow: UnitOfWork = { run: (work) => work() };

  const wallets: WalletRepository = {
    lockById: async (id) => store.wallets.get(id) ?? null,
    findById: async (id) => store.wallets.get(id) ?? null,
    add: async (wallet) => {
      store.wallets.set(wallet.id, wallet);
      wallet.markPersisted();
    },
    save: async (wallet) => {
      if (wallet.persistedVersion === undefined) throw new StaleAggregateError('Wallet', wallet.id);
      wallet.markPersisted();
    },
  };

  const transactions: WagerTransactionRepository = {
    add: async (tx) => void store.transactions.set(tx.id, tx),
    update: async (tx) => void store.transactions.set(tx.id, tx),
    findById: async (id) => store.transactions.get(id) ?? null,
    findByExternalId: async (providerId, ext) =>
      [...store.transactions.values()].find(
        (t) => t.providerId === providerId && t.externalTransactionId === ext,
      ) ?? null,
    findByIdempotencyOrExternalId: async (providerId, key, ext) =>
      [...store.transactions.values()].filter(
        (t) => t.providerId === providerId && (t.idempotencyKey === key || t.externalTransactionId === ext),
      ),
    listPendingByReference: async (walletId, providerId, ref) =>
      [...store.transactions.values()]
        .filter(
          (t) =>
            t.walletId === walletId &&
            t.providerId === providerId &&
            t.referenceExternalTransactionId === ref &&
            t.status === 'PENDING_REFERENCE',
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    existsProcessedReversalOf: async (referenceId) =>
      [...store.transactions.values()].some(
        (t) =>
          t.referenceTransactionId === referenceId &&
          t.status === 'PROCESSED' &&
          (t.kind === 'REFUND' || t.kind === 'ROLLBACK'),
      ),
  };

  const ledger: LedgerRepository = {
    add: async (entry) => void store.ledger.push(entry),
    findByTransactionId: async (id) => store.ledger.find((e) => e.transactionId === id) ?? null,
    listByWallet: async (walletId) =>
      store.ledger.filter((e) => e.walletId === walletId).sort((a, b) => a.walletVersion - b.walletVersion),
  };

  const inbox: InboxRepository = {
    insertIfAbsent: async (message) => {
      const key = inboxKey(message.consumerName, message.messageId);
      if (store.inbox.has(key)) return false;
      store.inbox.set(key, message);
      return true;
    },
    findPayloadHash: async (consumer, id) => store.inbox.get(inboxKey(consumer, id))?.payloadHash ?? null,
  };

  const outbox: OutboxRepository = { add: async (message) => void store.outbox.push(message) };

  const settlement = new WagerSettlement({
    wallets,
    transactions,
    ledger,
    outbox,
    clock,
    ids,
    faults: NOOP_FAULT_INJECTOR,
    pendingReference: DEFAULT_PENDING_REFERENCE_POLICY,
  });

  return {
    store,
    clock,
    ids,
    process: new ProcessWagerTransactionUseCase({ uow, wallets, transactions, inbox, settlement, hasher, clock, ids }),
    openWallet: new OpenWalletUseCase({ uow, wallets, transactions, ledger, outbox, hasher, clock, ids }),
    reprocess: new ReprocessPendingReferenceUseCase({ uow, wallets, transactions, settlement }),
    eventTypes: () => store.outbox.map((m) => m.eventType),
  };
}

export type UnitHarness = ReturnType<typeof buildUnitHarness>;

let sequence = 0; // check-money:allow

/** Comando válido (BET de 10.00 BRL) com ids externos únicos; `over` sobrescreve qualquer campo. */
export function command(
  wallet: { id: string; playerId: string },
  over: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  sequence += 1;
  const externalTransactionId = over.externalTransactionId ?? `ext-${sequence}`;
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
