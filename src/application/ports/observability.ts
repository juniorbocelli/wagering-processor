/** Campos estruturados de log. Nunca inclua o payload financeiro completo (§12). */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Logger derivado com campos fixos (`correlationId`, `messageId`, `walletId`, …). */
  child(fields: LogFields): Logger;
}

export const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => NOOP_LOGGER,
};

/**
 * Métricas de negócio e de mensageria (ADR-009). Cada método corresponde a uma série
 * Prometheus; os adapters decidem nomes e labels, a aplicação só sinaliza o fato.
 */
export interface Metrics {
  /** `wager_transactions_total{status,kind}` — uma vez por transação liquidada. */
  transactionSettled(status: string, kind: string): void;
  /** `idempotency_replays_total` */
  idempotencyReplay(): void;
  /** `idempotency_conflicts_total` */
  idempotencyConflict(): void;
  /** `inbox_duplicates_total` */
  inboxDuplicate(): void;
  /** `sqs_retries_total` — mensagem devolvida à fila por falha transitória. */
  sqsRetry(): void;
  /** `sqs_dlq_messages_total` — mensagem enviada explicitamente à DLQ. */
  sqsDeadLettered(errorCode: string): void;
  /** `wallet_lock_wait_seconds` */
  walletLockWait(seconds: number): void; // check-money:allow
  /** `wallet_lock_timeouts_total` */
  walletLockTimeout(): void;
  /** `wager_processing_duration_seconds` */
  processingDuration(seconds: number): void; // check-money:allow
  /** `outbox_stuck_total` — evento que passou do limiar de tentativas e segue sendo retentado. */
  outboxStuck(): void;
  /** `retention_deleted_total{table}` */
  retentionDeleted(table: 'outbox_messages' | 'inbox_messages', rows: number): void; // check-money:allow
}

export const NOOP_METRICS: Metrics = {
  transactionSettled: () => undefined,
  idempotencyReplay: () => undefined,
  idempotencyConflict: () => undefined,
  inboxDuplicate: () => undefined,
  sqsRetry: () => undefined,
  sqsDeadLettered: () => undefined,
  walletLockWait: () => undefined,
  walletLockTimeout: () => undefined,
  processingDuration: () => undefined,
  outboxStuck: () => undefined,
  retentionDeleted: () => undefined,
};
