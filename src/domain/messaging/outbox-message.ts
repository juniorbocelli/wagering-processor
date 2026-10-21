import { DomainError } from '../shared/domain-error.ts';
import type { IntegrationEvent } from '../events/integration-event.ts';

export class InvalidOutboxStateError extends DomainError {
  readonly code = 'INVALID_OUTBOX_STATE';

  constructor(message: string) {
    super(message);
  }
}

export interface OutboxMessageState {
  /** = `eventId` do envelope. */
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number; // check-money:allow
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number; // check-money:allow
  nextAttemptAt: Date;
  lockedUntil: Date | undefined;
  lockedBy: string | undefined;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const BACKOFF_MAX_EXPONENT = 20;

/**
 * Backoff exponencial (2 s, 4 s, 8 s…) com teto de 5 min e *jitter* de até 50% para
 * baixo. `random` é injetável para testes determinísticos.
 */
export function outboxBackoffMs(attempts: number, random: () => number): number { // check-money:allow
  const exponential = BACKOFF_BASE_MS * 2 ** Math.min(attempts, BACKOFF_MAX_EXPONENT);
  const capped = Math.min(exponential, BACKOFF_CAP_MS);
  return (capped - random() * (capped / 2)) | 0;
}

/**
 * Evento de integração pendente de publicação. Nunca é descartado: após falhas,
 * `scheduleRetry` apenas adia a próxima tentativa (teto de 5 min — ADR-004 §4).
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly eventVersion: number, // check-money:allow
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number, // check-money:allow
    private _nextAttemptAt: Date,
    private _lockedUntil: Date | undefined,
    private _lockedBy: string | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  /** Pronta para publicar imediatamente (`nextAttemptAt = occurredAt`). */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      Object.freeze({ ...envelope }) as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.eventVersion,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.lockedUntil,
      state.lockedBy,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number { // check-money:allow
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get lockedUntil(): Date | undefined {
    return this._lockedUntil;
  }
  get lockedBy(): string | undefined {
    return this._lockedBy;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente, com a próxima tentativa vencida e sem lease ativo. */
  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      this._nextAttemptAt.getTime() <= now.getTime() &&
      (this._lockedUntil === undefined || this._lockedUntil.getTime() < now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError('Outbox message is already published');
    }
    this._publishedAt = at;
    this._lockedUntil = undefined;
    this._lockedBy = undefined;
    this._lastError = undefined;
  }

  /** Incrementa `attempts`, calcula o próximo `nextAttemptAt` (backoff) e libera o lease. */
  scheduleRetry(now: Date, error?: string, random: () => number = Math.random): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError('Cannot retry a published outbox message');
    }
    this._nextAttemptAt = new Date(now.getTime() + outboxBackoffMs(this._attempts, random));
    this._attempts += 1;
    this._lockedUntil = undefined;
    this._lockedBy = undefined;
    this._lastError = error === undefined ? undefined : error.slice(0, 512);
  }
}
