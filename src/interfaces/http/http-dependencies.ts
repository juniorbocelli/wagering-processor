import type { HealthProbe } from '../../application/ports/health.ts';
import type { ProviderIdentityPort } from '../../application/ports/identity.ts';
import type { Logger } from '../../application/ports/observability.ts';
import type { IdGenerator } from '../../application/ports/runtime.ts';
import type { OpenWalletUseCase } from '../../application/use-cases/open-wallet.ts';
import type { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.ts';
import type {
  GetTransactionUseCase,
  GetWalletUseCase,
  ListLedgerUseCase,
} from '../../application/use-cases/queries.ts';
import type { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.ts';

/** Exposição Prometheus: implementada por `PrometheusMetrics`. */
export interface MetricsExposition {
  readonly contentType: string;
  render(): Promise<string>;
}

/**
 * Tudo que a camada HTTP precisa, já composto. Os controllers dependem apenas destes casos de
 * uso e portas — nunca de MikroORM, SQS ou prom-client.
 */
export interface HttpDependencies {
  openWallet: Pick<OpenWalletUseCase, 'execute'>;
  processWagerTransaction: Pick<ProcessWagerTransactionUseCase, 'execute'>;
  getWallet: Pick<GetWalletUseCase, 'execute'>;
  listLedger: Pick<ListLedgerUseCase, 'execute'>;
  getTransaction: Pick<GetTransactionUseCase, 'byId' | 'byExternalId'>;
  reconcileWallet: Pick<ReconcileWalletUseCase, 'execute'>;
  identity: ProviderIdentityPort;
  readiness: readonly HealthProbe[];
  /** Prazo de cada sonda de `/health/ready`; padrão 2 s. */
  readinessTimeoutMs?: number; // check-money:allow
  metrics: MetricsExposition;
  logger: Logger;
  ids: IdGenerator;
}

export const HTTP_DEPENDENCIES = Symbol('HttpDependencies');
