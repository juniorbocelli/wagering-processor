import type { RetentionStore } from '../../application/ports/messaging.ts';
import { NOOP_LOGGER, NOOP_METRICS, type Logger, type Metrics } from '../../application/ports/observability.ts';
import type { Clock } from '../../application/ports/runtime.ts';
import { PollingLoop } from './polling-loop.ts';

export interface RetentionOptions {
  intervalMs: number;
  outboxRetentionHours: number;
  inboxRetentionDays: number;
  batchSize: number;
}

/** Padrões do ADR-011. */
export const DEFAULT_RETENTION_OPTIONS: RetentionOptions = {
  intervalMs: 10 * 60_000,
  outboxRetentionHours: 72,
  inboxRetentionDays: 7,
  batchSize: 1000,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionWorkerDependencies {
  store: RetentionStore;
  clock: Clock;
  options?: RetentionOptions;
  metrics?: Metrics;
  logger?: Logger;
}

export interface RetentionResult {
  outbox: number;
  inbox: number;
}

/**
 * Expurgo limitado de inbox e outbox (ADR-011): lotes curtos (outbox com `FOR UPDATE SKIP LOCKED`),
 * repetidos enquanto o lote vier cheio. **Nunca** apaga pendentes: o predicado exige
 * `published_at` (outbox); na inbox toda linha existente já representa trabalho comitado.
 */
export class RetentionWorker {
  private readonly options: RetentionOptions;
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly loop: PollingLoop;

  constructor(private readonly deps: RetentionWorkerDependencies) {
    this.options = deps.options ?? DEFAULT_RETENTION_OPTIONS;
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.logger = (deps.logger ?? NOOP_LOGGER).child({ worker: 'retention' });
    this.loop = new PollingLoop({
      name: 'retention',
      intervalMs: this.options.intervalMs,
      tick: async () => {
        await this.runOnce();
        return false;
      },
      logger: this.logger,
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  async runOnce(): Promise<RetentionResult> {
    const now = this.deps.clock.now().getTime();
    const outboxCutoff = new Date(now - this.options.outboxRetentionHours * HOUR_MS);
    const inboxCutoff = new Date(now - this.options.inboxRetentionDays * DAY_MS);

    const outbox = await this.drain((size) => this.deps.store.purgePublishedOutbox(outboxCutoff, size));
    const inbox = await this.drain((size) => this.deps.store.purgeProcessedInbox(inboxCutoff, size));

    if (outbox > 0) this.metrics.retentionDeleted('outbox_messages', outbox);
    if (inbox > 0) this.metrics.retentionDeleted('inbox_messages', inbox);
    if (outbox > 0 || inbox > 0) this.logger.info('retention purge completed', { outbox, inbox });
    return { outbox, inbox };
  }

  private async drain(purge: (batchSize: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await purge(this.options.batchSize);
      total += deleted;
      if (deleted < this.options.batchSize) return total;
    }
  }
}
