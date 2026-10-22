import { hostname } from 'node:os';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { NOOP_LOGGER, type Logger } from './application/ports/observability.ts';
import { NOOP_FAULT_INJECTOR, type FaultInjector } from './application/ports/runtime.ts';
import { createSqsClient, resolveQueueUrl, SqsDeadLetterPublisher, SqsEventPublisher, SqsQueue } from './infrastructure/messaging/sqs/sqs.ts';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics.ts';
import type { WageringServices } from './infrastructure/wagering-services.ts';
import { WagerTransactionConsumer, type WagerConsumerOptions } from './interfaces/sqs/wager-transaction-consumer.ts';
import {
  DEFAULT_OUTBOX_PUBLISHER_OPTIONS,
  OutboxPublisherWorker,
  type OutboxPublisherOptions,
} from './interfaces/workers/outbox-publisher-worker.ts';
import {
  DEFAULT_PENDING_REFERENCE_WORKER_OPTIONS,
  PendingReferenceWorker,
  type PendingReferenceWorkerOptions,
} from './interfaces/workers/pending-reference-worker.ts';
import { DEFAULT_RETENTION_OPTIONS, RetentionWorker, type RetentionOptions } from './interfaces/workers/retention-worker.ts';

export interface MessagingConfig {
  wagerQueueName: string;
  deadLetterQueueName: string;
  eventsQueueName: string;
  consumer: Partial<WagerConsumerOptions>;
  outbox: Omit<OutboxPublisherOptions, 'instanceId'>;
  pendingReference: PendingReferenceWorkerOptions;
  retention: RetentionOptions;
}

type Env = Record<string, string | undefined>;

export function intFromEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

/** Configuração de mensageria a partir do ambiente (padrões dos ADR-004 e ADR-011). */
export function loadMessagingConfig(env: Env = process.env): MessagingConfig {
  return {
    wagerQueueName: env['WAGER_QUEUE_NAME'] ?? 'wager-transactions.fifo',
    deadLetterQueueName: env['WAGER_DLQ_NAME'] ?? 'wager-transactions-dlq.fifo',
    eventsQueueName: env['EVENTS_QUEUE_NAME'] ?? 'wallet-events.fifo',
    consumer: {
      visibilityTimeoutSeconds: intFromEnv(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
      gracePeriodMs: intFromEnv(env, 'SHUTDOWN_GRACE_MS', 20_000),
    },
    outbox: {
      ...DEFAULT_OUTBOX_PUBLISHER_OPTIONS,
      pollIntervalMs: intFromEnv(env, 'OUTBOX_POLL_INTERVAL_MS', DEFAULT_OUTBOX_PUBLISHER_OPTIONS.pollIntervalMs),
      leaseMs: intFromEnv(env, 'OUTBOX_LEASE_MS', DEFAULT_OUTBOX_PUBLISHER_OPTIONS.leaseMs),
    },
    pendingReference: {
      ...DEFAULT_PENDING_REFERENCE_WORKER_OPTIONS,
      pollIntervalMs: intFromEnv(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', DEFAULT_PENDING_REFERENCE_WORKER_OPTIONS.pollIntervalMs),
    },
    retention: {
      intervalMs: intFromEnv(env, 'RETENTION_INTERVAL_MS', DEFAULT_RETENTION_OPTIONS.intervalMs),
      outboxRetentionHours: intFromEnv(env, 'OUTBOX_RETENTION_HOURS', DEFAULT_RETENTION_OPTIONS.outboxRetentionHours),
      inboxRetentionDays: intFromEnv(env, 'INBOX_RETENTION_DAYS', DEFAULT_RETENTION_OPTIONS.inboxRetentionDays),
      batchSize: intFromEnv(env, 'RETENTION_BATCH_SIZE', DEFAULT_RETENTION_OPTIONS.batchSize),
    },
  };
}

export interface MessagingRuntimeOptions {
  services: WageringServices;
  config?: MessagingConfig;
  sqs?: SQSClient;
  logger?: Logger;
  faults?: FaultInjector;
  /** Identificador desta instância no lease da outbox; padrão `host:pid:sufixo`. */
  instanceId?: string;
}

/**
 * Raiz de composição da mensageria: consumidor SQS + workers (outbox, referências
 * pendentes, retenção), todos rodando em **cada** instância sem coordenação externa.
 */
export interface MessagingRuntime {
  consumer: WagerTransactionConsumer;
  outboxPublisher: OutboxPublisherWorker;
  pendingReference: PendingReferenceWorker;
  retention: RetentionWorker;
  start(): void;
  /** Encerramento gracioso (SIGTERM): consumidor primeiro, depois os workers. */
  stop(): Promise<void>;
}

export async function buildMessagingRuntime(options: MessagingRuntimeOptions): Promise<MessagingRuntime> {
  const { services } = options;
  const config = options.config ?? loadMessagingConfig();
  const sqs = options.sqs ?? createSqsClient();
  const logger = options.logger ?? NOOP_LOGGER;
  const faults = options.faults ?? NOOP_FAULT_INJECTOR;
  const instanceId = options.instanceId ?? `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;

  const [wagerUrl, dlqUrl, eventsUrl] = await Promise.all([
    resolveQueueUrl(sqs, config.wagerQueueName),
    resolveQueueUrl(sqs, config.deadLetterQueueName),
    resolveQueueUrl(sqs, config.eventsQueueName),
  ]);

  if (services.metrics instanceof PrometheusMetrics) {
    services.metrics.setOutboxLagProvider(() => services.store.lagSeconds());
  }

  const consumer = new WagerTransactionConsumer({
    queue: new SqsQueue(sqs, wagerUrl),
    deadLetters: new SqsDeadLetterPublisher(sqs, dlqUrl),
    useCase: services.processWagerTransaction,
    options: config.consumer,
    metrics: services.metrics,
    logger,
    faults,
  });
  const outboxPublisher = new OutboxPublisherWorker({
    store: services.store,
    publisher: new SqsEventPublisher(sqs, eventsUrl),
    clock: services.clock,
    options: { ...config.outbox, instanceId },
    metrics: services.metrics,
    logger,
    faults,
  });
  const pendingReference = new PendingReferenceWorker({
    scanner: services.store,
    reprocess: services.reprocessPendingReference,
    clock: services.clock,
    options: config.pendingReference,
    logger,
  });
  const retention = new RetentionWorker({
    store: services.store,
    clock: services.clock,
    options: config.retention,
    metrics: services.metrics,
    logger,
  });

  return {
    consumer,
    outboxPublisher,
    pendingReference,
    retention,
    start() {
      consumer.start();
      outboxPublisher.start();
      pendingReference.start();
      retention.start();
    },
    async stop() {
      await consumer.stop();
      await Promise.all([outboxPublisher.stop(), pendingReference.stop(), retention.stop()]);
    },
  };
}
