import type { EventPublisher, OutboxStore, ClaimedOutboxMessage } from '../../application/ports/messaging.ts';
import { NOOP_LOGGER, NOOP_METRICS, type Logger, type Metrics } from '../../application/ports/observability.ts';
import { NOOP_FAULT_INJECTOR, type Clock, type FaultInjector } from '../../application/ports/runtime.ts';
import { PollingLoop } from './polling-loop.ts';

export interface OutboxPublisherOptions {
  instanceId: string;
  pollIntervalMs: number;
  /** Quanto tempo uma reivindicação vale antes de outra instância poder assumir. */
  leaseMs: number;
  /** Wallets (cabeças) reivindicadas por ciclo. */
  headLimit: number;
  /** Eventos reservados por wallet em um ciclo. */
  perWalletLimit: number;
  /** Tentativas a partir das quais o evento entra em `outbox_stuck_total` (segue sendo retentado). */
  stuckAttempts: number;
}

export const DEFAULT_OUTBOX_PUBLISHER_OPTIONS: Omit<OutboxPublisherOptions, 'instanceId'> = {
  pollIntervalMs: 300,
  leaseMs: 30_000,
  headLimit: 10,
  perWalletLimit: 20,
  stuckAttempts: 10,
};

/**
 * Eventos por chamada ao SQS. `SendMessageBatch` aceita e recusa as entradas individualmente:
 * num lote, o evento *i+1* poderia ser aceito enquanto o *i* é recusado e reenviado depois,
 * invertendo a ordem por wallet na fila FIFO. Com uma entrada por chamada, uma falha significa
 * que nada posterior da wallet foi enviado. Wallets distintas seguem em paralelo.
 */
const SQS_BATCH_SIZE = 1;

export interface OutboxPublisherDependencies {
  store: OutboxStore;
  publisher: EventPublisher;
  clock: Clock;
  options: OutboxPublisherOptions;
  metrics?: Metrics;
  logger?: Logger;
  faults?: FaultInjector;
  /** Jitter do backoff; injetável para testes determinísticos. */
  random?: () => number;
}

/**
 * Publisher da outbox (ADR-004 §4); roda em **todas** as instâncias. Cada ciclo:
 *
 *   1. `claim`: reivindica a cabeça de cada wallet livre + os seguintes (lease);
 *   2. publica, por wallet e em ordem de `seq`, em lotes de até 10 (`SendMessageBatch`);
 *   3. marca como publicados os confirmados; na primeira falha de uma wallet, agenda o
 *      retry daquele evento e apenas devolve o lease dos seguintes (continuam atrás dele).
 *
 * Nunca descarta: o evento que falha repetidamente só adia a próxima tentativa (teto de
 * 5 min) e passa a contar em `outbox_stuck_total`. Garantia: at-least-once, ordenado por
 * wallet; duplicatas têm o mesmo `eventId`.
 */
export class OutboxPublisherWorker {
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly faults: FaultInjector;
  private readonly loop: PollingLoop;

  constructor(private readonly deps: OutboxPublisherDependencies) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.logger = (deps.logger ?? NOOP_LOGGER).child({ worker: 'outbox-publisher', instanceId: deps.options.instanceId });
    this.faults = deps.faults ?? NOOP_FAULT_INJECTOR;
    this.loop = new PollingLoop({
      name: 'outbox-publisher',
      intervalMs: deps.options.pollIntervalMs,
      tick: async () => (await this.runOnce()) > 0,
      logger: this.logger,
    });
  }

  get crashed(): boolean {
    return this.loop.crashed;
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Um ciclo de claim → publish → mark. Devolve quantos eventos foram reivindicados. */
  async runOnce(): Promise<number> {
    const { options } = this.deps;
    const claimed = await this.deps.store.claim({
      instanceId: options.instanceId,
      now: this.deps.clock.now(),
      leaseMs: options.leaseMs,
      headLimit: options.headLimit,
      perWalletLimit: options.perWalletLimit,
    });
    if (claimed.length === 0) return 0;

    const byWallet = new Map<string, ClaimedOutboxMessage[]>();
    for (const item of claimed) {
      const list = byWallet.get(item.message.aggregateId);
      if (list === undefined) byWallet.set(item.message.aggregateId, [item]);
      else list.push(item);
    }
    // Wallets diferentes em paralelo; dentro de uma wallet, estritamente em ordem.
    await Promise.all([...byWallet.values()].map((items) => this.publishWallet(items)));
    return claimed.length;
  }

  private async publishWallet(items: ClaimedOutboxMessage[]): Promise<void> {
    const { store, publisher, options } = this.deps;
    const pending = items.map((item) => item.message);

    for (let offset = 0; offset < pending.length; offset += SQS_BATCH_SIZE) {
      const chunk = pending.slice(offset, offset + SQS_BATCH_SIZE);
      let rejected: ReadonlySet<string>;
      let failure: string | undefined;
      try {
        rejected = await publisher.publishBatch(chunk);
        if (rejected.size > 0) failure = 'rejected by SQS';
      } catch (error) {
        rejected = new Set(chunk.map((message) => message.id));
        failure = error instanceof Error ? error.message : String(error);
      }

      // Entre publicar e marcar: um crash aqui deixa o lease valer até expirar (republicação).
      this.faults.trigger('crash_after_publish_before_mark');

      const firstFailed = chunk.findIndex((message) => rejected.has(message.id));
      const confirmed = firstFailed === -1 ? chunk : chunk.slice(0, firstFailed);
      const marked = await store.markPublished(
        confirmed.map((message) => message.id),
        options.instanceId,
        this.deps.clock.now(),
      );
      if (marked < confirmed.length) {
        // Lease vencido durante a publicação: outra instância assumiu e republicará (mesmo eventId).
        this.logger.warn('outbox lease lost before marking events as published', {
          expected: confirmed.length,
          marked,
        });
      }
      if (firstFailed === -1) continue;

      // A cabeça falhou: só ela é reagendada; o resto da wallet fica atrás dela.
      const head = chunk[firstFailed];
      if (head !== undefined) {
        head.scheduleRetry(this.deps.clock.now(), failure, this.deps.random);
        await store.saveRetry(head, options.instanceId);
        if (head.attempts === options.stuckAttempts) this.metrics.outboxStuck();
        this.logger.warn('outbox event publication failed; wallet is held behind it', {
          walletId: head.aggregateId,
          eventId: head.id,
          eventType: head.eventType,
          attempts: head.attempts,
          error: failure,
        });
      }
      const rest = [...chunk.slice(firstFailed + 1), ...pending.slice(offset + SQS_BATCH_SIZE)];
      await store.releaseLease(
        rest.map((message) => message.id),
        options.instanceId,
      );
      return;
    }
  }
}
