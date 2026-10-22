/**
 * Erros de contrato e de infraestrutura da camada de aplicação (ADR-007 §3). O `code` é
 * estável e legível por máquina; HTTP e SQS o traduzem sem depender da mensagem.
 * Não são persistidos: uma requisição inválida não produz transação.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface Violation {
  field: string;
  message: string;
}

export class ValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly violations: readonly Violation[]) {
    super(`Invalid request: ${violations.map((v) => `${v.field}: ${v.message}`).join('; ')}`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`A wallet for player ${playerId} in ${currency} already exists`);
  }
}

export type IdempotencyConflictCode = 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_TRANSACTION_ID_REUSED';

/** Mesma key com payload diferente, ou mesmo id externo com outra key: conflito, nunca replay. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(
    readonly code: IdempotencyConflictCode,
    readonly providerId: string,
  ) {
    super(
      code === 'IDEMPOTENCY_KEY_REUSED'
        ? 'The idempotency key was already used with a different payload'
        : 'The external transaction id was already used with a different idempotency key',
    );
  }
}

/** Mesmo `messageId` reentregue com conteúdo diferente: erro permanente (DLQ). */
export class InboxPayloadMismatchError extends ApplicationError {
  readonly code = 'INBOX_PAYLOAD_MISMATCH';

  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(`Message ${messageId} was redelivered with a different payload`);
  }
}

/** Falha transitória (lock timeout, conexão, deadlock esgotado): reenviar com a mesma key é seguro. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** `55P03`: `lock_timeout` esgotado esperando o lock da wallet. Continua sendo transitório. */
export class LockTimeoutError extends TransientInfrastructureError {
  constructor(options?: { cause?: unknown }) {
    super('Timed out waiting for a database lock', options);
  }
}

// ---- erros de driver, já traduzidos pelo adapter de persistência --------------------------

/** `23505`: violação de `UNIQUE`. `constraint` identifica qual (ex.: `uq_wtx_provider_external`). */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`Unique constraint violated${constraint === undefined ? '' : `: ${constraint}`}`, options);
  }
}

/** `23514` / `23503` / `23000`: o schema barrou uma escrita que o código deveria ter evitado (bug). */
export class IntegrityViolationError extends ApplicationError {
  readonly code = 'INTEGRITY_VIOLATION';

  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown; detail?: string },
  ) {
    super(
      `Database integrity constraint violated${constraint === undefined ? '' : `: ${constraint}`}` +
        (options?.detail === undefined ? '' : ` — ${options.detail}`),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
  }
}

/** `40P01` (deadlock) / `40001` (serialização): a transação inteira pode ser repetida. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';

  constructor(options?: { cause?: unknown }, message = 'Transaction aborted by a concurrency conflict') {
    super(message, options);
  }
}

/**
 * `UPDATE … WHERE version = ?` não afetou nenhuma linha (defesa secundária do lock). É um
 * conflito de concorrência: a transação inteira pode ser repetida.
 */
export class StaleAggregateError extends ConcurrencyConflictError {
  constructor(aggregate: string, id: string) {
    super(undefined, `${aggregate} ${id} was modified concurrently`);
  }
}
