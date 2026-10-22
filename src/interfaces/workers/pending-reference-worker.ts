import type { PendingReferenceScanner } from '../../application/ports/messaging.ts';
import { NOOP_LOGGER, type Logger } from '../../application/ports/observability.ts';
import type { Clock } from '../../application/ports/runtime.ts';
import type { ReprocessPendingReferenceUseCase } from '../../application/use-cases/reprocess-pending-reference.ts';
import { PollingLoop } from './polling-loop.ts';

export interface PendingReferenceWorkerOptions {
  pollIntervalMs: number;
  /** Transações varridas por ciclo. */
  batchSize: number;
  /** Reprocessamentos simultâneos (wallets distintas não se bloqueiam). */
  concurrency: number;
}

export const DEFAULT_PENDING_REFERENCE_WORKER_OPTIONS: PendingReferenceWorkerOptions = {
  pollIntervalMs: 500,
  batchSize: 50,
  concurrency: 5,
};

export interface PendingReferenceWorkerDependencies {
  scanner: PendingReferenceScanner;
  reprocess: ReprocessPendingReferenceUseCase;
  clock: Clock;
  options?: PendingReferenceWorkerOptions;
  logger?: Logger;
}

/**
 * Reprocessa transações `PENDING_REFERENCE` com a tentativa vencida (ADR-004 §5, ADR-008).
 * Roda em **todas** as instâncias sem coordenação: o caso de uso relê a transação sob o
 * lock da wallet e só tenta se ela ainda estiver pendente **e** vencida — duas instâncias
 * varrendo o mesmo item não consomem tentativas em dobro. Limite de tentativas / TTL
 * esgotado → `REJECTED(REFERENCE_NOT_FOUND)` + evento, decidido pela política em `settle`.
 */
export class PendingReferenceWorker {
  private readonly options: PendingReferenceWorkerOptions;
  private readonly logger: Logger;
  private readonly loop: PollingLoop;

  constructor(private readonly deps: PendingReferenceWorkerDependencies) {
    this.options = deps.options ?? DEFAULT_PENDING_REFERENCE_WORKER_OPTIONS;
    this.logger = (deps.logger ?? NOOP_LOGGER).child({ worker: 'pending-reference' });
    this.loop = new PollingLoop({
      name: 'pending-reference',
      intervalMs: this.options.pollIntervalMs,
      tick: async () => (await this.runOnce()) >= this.options.batchSize,
      logger: this.logger,
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Um ciclo de varredura; devolve quantas transações estavam vencidas. */
  async runOnce(): Promise<number> {
    const ids = await this.deps.scanner.listDueIds(this.deps.clock.now(), this.options.batchSize);
    for (let offset = 0; offset < ids.length; offset += this.options.concurrency) {
      const slice = ids.slice(offset, offset + this.options.concurrency);
      await Promise.all(slice.map((id) => this.reprocessOne(id)));
    }
    return ids.length;
  }

  private async reprocessOne(transactionId: string): Promise<void> {
    try {
      const result = await this.deps.reprocess.execute(transactionId);
      if (result.kind === 'reprocessed') {
        this.logger.info('pending reference reprocessed', {
          transactionId,
          walletId: result.transaction.walletId,
          providerId: result.transaction.providerId,
          status: result.transaction.status,
          attempts: result.transaction.referenceAttempts,
        });
      }
    } catch (error) {
      // Transitório (lock, conexão): continua vencida e é tentada de novo no próximo ciclo.
      this.logger.warn('pending reference reprocessing failed', {
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
