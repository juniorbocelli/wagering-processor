import { NOOP_LOGGER, type Logger } from '../../application/ports/observability.ts';
import type { ReconcileAllWalletsUseCase, SweepSummary } from '../../application/use-cases/reconcile-wallet.ts';
import { PollingLoop } from './polling-loop.ts';

export interface PeriodicReconciliationOptions {
  intervalMs: number;
}

/** Padrão do ADR-012: varredura a cada 5 minutos. */
export const DEFAULT_PERIODIC_RECONCILIATION_OPTIONS: PeriodicReconciliationOptions = {
  intervalMs: 5 * 60_000,
};

export interface PeriodicReconciliationWorkerDependencies {
  useCase: Pick<ReconcileAllWalletsUseCase, 'execute'>;
  options?: PeriodicReconciliationOptions;
  logger?: Logger;
}

/**
 * Varre todas as wallets a cada intervalo (ADR-012). Roda em **cada** instância sem
 * coordenação externa: o advisory lock do caso de uso garante uma varredura por vez no
 * cluster; as demais instâncias apenas pulam a rodada. Detecta e nunca corrige.
 */
export class PeriodicReconciliationWorker {
  private readonly options: PeriodicReconciliationOptions;
  private readonly loop: PollingLoop;

  constructor(private readonly deps: PeriodicReconciliationWorkerDependencies) {
    this.options = deps.options ?? DEFAULT_PERIODIC_RECONCILIATION_OPTIONS;
    this.loop = new PollingLoop({
      name: 'periodic-reconciliation',
      intervalMs: this.options.intervalMs,
      tick: async () => {
        await this.runOnce();
        return false;
      },
      logger: (deps.logger ?? NOOP_LOGGER).child({ worker: 'periodic-reconciliation' }),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  runOnce(): Promise<SweepSummary> {
    return this.deps.useCase.execute();
  }
}
