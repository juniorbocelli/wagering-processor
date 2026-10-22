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
import { SystemClock, UuidV7Generator } from './runtime/system-runtime.ts';

export interface WageringServicesOptions {
  clock?: Clock;
  ids?: IdGenerator;
  faults?: FaultInjector;
  pendingReference?: PendingReferencePolicy;
  unitOfWork?: UnitOfWorkOptions;
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
    }),
    openWallet: new OpenWalletUseCase({ uow, wallets, transactions, ledger, outbox, hasher, clock, ids }),
    reprocessPendingReference: new ReprocessPendingReferenceUseCase({
      uow,
      wallets,
      transactions,
      settlement,
    }),
  };
}

export type WageringServices = ReturnType<typeof buildWageringServices>;
