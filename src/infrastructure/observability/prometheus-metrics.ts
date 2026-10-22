import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Metrics } from '../../application/ports/observability.ts';

const LOCK_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Catálogo de métricas Prometheus (ADR-009). Um `Registry` por instância: testes e
 * múltiplas instâncias no mesmo processo não colidem no registro global.
 */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions settled, by final status and kind',
    labelNames: ['status', 'kind'],
    registers: [this.registry],
  });
  private readonly replays = new Counter({
    name: 'idempotency_replays_total',
    help: 'Requests answered with the original result of an already registered operation',
    registers: [this.registry],
  });
  private readonly conflicts = new Counter({
    name: 'idempotency_conflicts_total',
    help: 'Requests rejected for reusing an idempotency key or external id with a different payload',
    registers: [this.registry],
  });
  private readonly inboxDuplicates = new Counter({
    name: 'inbox_duplicates_total',
    help: 'SQS deliveries acknowledged without effect because the message was already processed',
    registers: [this.registry],
  });
  private readonly sqsRetries = new Counter({
    name: 'sqs_retries_total',
    help: 'SQS messages returned to the queue after a transient failure',
    registers: [this.registry],
  });
  private readonly sqsDlq = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'SQS messages explicitly sent to the dead-letter queue, by error code',
    labelNames: ['error_code'],
    registers: [this.registry],
  });
  private readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Time spent waiting for the row lock of a wallet',
    buckets: LOCK_BUCKETS,
    registers: [this.registry],
  });
  private readonly lockTimeouts = new Counter({
    name: 'wallet_lock_timeouts_total',
    help: 'Wallet lock acquisitions that exceeded lock_timeout',
    registers: [this.registry],
  });
  private readonly processingDurationHistogram = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'End-to-end duration of ProcessWagerTransaction (including retries and failures)',
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });
  private readonly stuck = new Counter({
    name: 'outbox_stuck_total',
    help: 'Outbox events that exceeded the attempt threshold and keep being retried',
    registers: [this.registry],
  });
  private readonly retention = new Counter({
    name: 'retention_deleted_total',
    help: 'Rows purged by the retention worker, by table',
    labelNames: ['table'],
    registers: [this.registry],
  });

  /**
   * `outbox_lag_seconds` é lida do banco a cada *scrape* (idade do evento pendente mais
   * antigo); o provedor é injetado quando o worker existe.
   */
  readonly outboxLag: Gauge;
  private lagProvider: () => Promise<number> = () => Promise.resolve(0);

  constructor() {
    this.outboxLag = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age of the oldest unpublished outbox event',
      registers: [this.registry],
      collect: async () => {
        this.outboxLag.set(await this.lagProvider());
      },
    });
  }

  setOutboxLagProvider(provider: () => Promise<number>): void {
    this.lagProvider = provider;
  }

  transactionSettled(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }
  idempotencyReplay(): void {
    this.replays.inc();
  }
  idempotencyConflict(): void {
    this.conflicts.inc();
  }
  inboxDuplicate(): void {
    this.inboxDuplicates.inc();
  }
  sqsRetry(): void {
    this.sqsRetries.inc();
  }
  sqsDeadLettered(errorCode: string): void {
    this.sqsDlq.inc({ error_code: errorCode });
  }
  walletLockWait(seconds: number): void {
    this.lockWait.observe(seconds);
  }
  walletLockTimeout(): void {
    this.lockTimeouts.inc();
  }
  processingDuration(seconds: number): void {
    this.processingDurationHistogram.observe(seconds);
  }
  outboxStuck(): void {
    this.stuck.inc();
  }
  retentionDeleted(table: 'outbox_messages' | 'inbox_messages', rows: number): void {
    this.retention.inc({ table }, rows);
  }

  /** Corpo do endpoint `/metrics` (formato de exposição Prometheus). */
  render(): Promise<string> {
    return this.registry.metrics();
  }
}
