import type { MikroORM } from '@mikro-orm/postgresql';
import { WagerSettlement } from '../application/use-cases/wager-settlement.ts';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.ts';
import { OpenWalletUseCase } from '../application/use-cases/open-wallet.ts';
import { ReprocessPendingReferenceUseCase } from '../application/use-cases/reprocess-pending-reference.ts';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  type PendingReferencePolicy,
} from '../application/pending-reference-policy.ts';
import {
  NOOP_FAULT_INJECTOR,
  type Clock,
  type FaultInjector,
  type IdGenerator,
} from '../application/ports/runtime.ts';
import { NOOP_LOGGER, NOOP_METRICS, type Logger, type Metrics } from '../application/ports/observability.ts';
import {
  GetTransactionUseCase,
  GetWalletUseCase,
  ListLedgerUseCase,
} from '../application/use-cases/queries.ts';
import {
  ReconcileAllWalletsUseCase,
  ReconcileWalletUseCase,
} from '../application/use-cases/reconcile-wallet.ts';
import { CanonicalJsonSha256Hasher } from './hashing/canonical-json-sha256-hasher.ts';
import {
  EntityManagerContext,
  MikroOrmUnitOfWork,
  type UnitOfWorkOptions,
} from './persistence/mikro-orm/mikro-orm-unit-of-work.ts';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './persistence/mikro-orm/repositories.ts';
import { MikroOrmMessagingStore } from './persistence/mikro-orm/messaging-store.ts';
import { MikroOrmReconciliationStore } from './persistence/mikro-orm/reconciliation-store.ts';
import { SystemClock, UuidV7Generator } from './runtime/system-runtime.ts';

export interface WageringServicesOptions {
  clock?: Clock;
  ids?: IdGenerator;
  faults?: FaultInjector;
  metrics?: Metrics;
  logger?: Logger;
  pendingReference?: PendingReferencePolicy;
  unitOfWork?: UnitOfWorkOptions;
  /** Tamanho do lote (keyset) da reconciliação periódica; padrão 500. */
  reconciliationBatchSize?: number; // check-money:allow
}

/**
 * Raiz de composição dos casos de uso sobre PostgreSQL/MikroORM. Reutilizada pela
 * aplicação NestJS e pelos testes de integração/concorrência (mesmos adapters reais).
 */
export function buildWageringServices(orm: MikroORM, options: WageringServicesOptions = {}) {
  const context = new EntityManagerContext(orm);
  const uow = new MikroOrmUnitOfWork(orm, context, options.unitOfWork);
  const wallets = new MikroOrmWalletRepository(context);
  const transactions = new MikroOrmWagerTransactionRepository(context);
  const ledger = new MikroOrmLedgerRepository(context);
  const inbox = new MikroOrmInboxRepository(context);
  const outbox = new MikroOrmOutboxRepository(context);
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new UuidV7Generator();
  const hasher = new CanonicalJsonSha256Hasher();
  const metrics = options.metrics ?? NOOP_METRICS;
  const logger = options.logger ?? NOOP_LOGGER;
  const store = new MikroOrmMessagingStore(orm);
  const reconciliationStore = new MikroOrmReconciliationStore(orm);

  const settlement = new WagerSettlement({
    wallets,
    transactions,
    ledger,
    outbox,
    clock,
    ids,
    faults: options.faults ?? NOOP_FAULT_INJECTOR,
    pendingReference: options.pendingReference ?? DEFAULT_PENDING_REFERENCE_POLICY,
  });

  return {
    uow,
    clock,
    metrics,
    /** Claim/ack da outbox, varredura de referências pendentes e retenção (fora da transação financeira). */
    store,
    repositories: { wallets, transactions, ledger, inbox, outbox },
    hasher,
    processWagerTransaction: new ProcessWagerTransactionUseCase({
      uow,
      wallets,
      transactions,
      inbox,
      settlement,
      hasher,
      clock,
      ids,
      metrics,
    }),
    openWallet: new OpenWalletUseCase({ uow, wallets, transactions, ledger, outbox, hasher, clock, ids }),
    reprocessPendingReference: new ReprocessPendingReferenceUseCase({
      uow,
      wallets,
      transactions,
      settlement,
      clock,
      metrics,
    }),
    getWallet: new GetWalletUseCase({ wallets }),
    listLedger: new ListLedgerUseCase({ wallets, ledger }),
    getTransaction: new GetTransactionUseCase({ transactions }),
    reconcileWallet: new ReconcileWalletUseCase({ store: reconciliationStore, metrics, logger }),
    reconcileAllWallets: new ReconcileAllWalletsUseCase({
      store: reconciliationStore,
      metrics,
      logger,
      clock,
      ...(options.reconciliationBatchSize === undefined ? {} : { batchSize: options.reconciliationBatchSize }),
    }),
  };
}

export type WageringServices = ReturnType<typeof buildWageringServices>;
