import { DomainError } from '../shared/domain-error.ts';
import { Money } from '../money/money.ts';
import { LedgerDirection, invertDirection } from '../ledger/ledger-direction.ts';
import type { FailureCode } from './failure-code.ts';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction-kind.ts';

/** Tentativa de transicionar uma transação terminal (ou por caminho inválido). Erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(
    readonly from: WagerTransactionStatus,
    readonly attempted: string,
  ) {
    super(`Cannot ${attempted} a transaction in status ${from}`);
  }
}

/** Dados de criação que violam as regras de modelagem (kind, valor, referência). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(message: string) {
    super(message);
  }
}

export const INTERNAL_PROVIDER_ID = 'internal';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  payloadHashVersion: number; // check-money:allow
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  /** Saldo da wallet observado ao concluir; devolvido fielmente em replays. */
  resultBalance: Money | undefined;
  processedAt: Date | undefined;
  referenceAttempts: number; // check-money:allow
  nextReferenceAttemptAt: Date | undefined;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  payloadHashVersion?: number; // check-money:allow
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  correlationId: string;
  createdAt: Date;
}

/** Tipos de referência aceitos por cada kind (regra §7.3 e WIN com referência opcional). */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<string, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/** Direção do lançamento de cada kind que move saldo por conta própria. */
const OWN_DIRECTION: Readonly<Partial<Record<WagerTransactionKind, LedgerDirection>>> = {
  [WagerTransactionKind.Opening]: LedgerDirection.Credit,
  [WagerTransactionKind.Bet]: LedgerDirection.Debit,
  [WagerTransactionKind.Win]: LedgerDirection.Credit,
  [WagerTransactionKind.Refund]: LedgerDirection.Credit,
};

function isNonBlank(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Transação de aposta de um provedor. Máquina de estados (terminais: PROCESSED,
 * REJECTED, FAILED):
 *
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly payloadHashVersion: number, // check-money:allow
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** id no provedor — não o id interno */
    readonly referenceExternalTransactionId: string | undefined,
    readonly correlationId: string,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _resultBalance: Money | undefined,
    private _processedAt: Date | undefined,
    private _referenceAttempts: number, // check-money:allow
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. `OPENING` só existe via {@link createOpening}. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.validatedPending(props);
  }

  /** Crédito de abertura da wallet: provider `internal`, key `opening:{walletId}`. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    const key = `opening:${props.walletId}`;
    return WagerTransaction.validatedPending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      correlationId: props.correlationId,
      createdAt: props.createdAt,
    });
  }

  /** Reconstrução a partir da persistência — não revalida regras de transição. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.payloadHashVersion,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.resultBalance,
      state.processedAt,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static validatedPending(props: CreateWagerTransactionProps): WagerTransaction {
    if (!(Object.values(WagerTransactionKind) as string[]).includes(props.kind)) {
      throw new InvalidWagerTransactionError(`Unknown kind: "${String(props.kind)}"`);
    }
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !isNonBlank(props.referenceExternalTransactionId)) {
      throw new InvalidWagerTransactionError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('Amount must not be negative');
    }
    if (!props.money.isPositive() && props.kind !== WagerTransactionKind.Loss) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a positive amount`);
    }
    for (const [name, value] of [
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['idempotencyKey', props.idempotencyKey],
      ['walletId', props.walletId],
      ['playerId', props.playerId],
      ['roundId', props.roundId],
      ['gameId', props.gameId],
    ] as const) {
      if (!isNonBlank(value)) {
        throw new InvalidWagerTransactionError(`${name} must not be blank`);
      }
    }
    return WagerTransaction.rehydrate({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      payloadHashVersion: props.payloadHashVersion ?? 1,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      correlationId: props.correlationId,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      resultBalance: undefined,
      processedAt: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get referenceAttempts(): number { // check-money:allow
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  /** Aplicada. REFUND/ROLLBACK exigem a referência já resolvida. */
  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    resultBalance: Money,
  ): void {
    this.assertNotTerminal('process');
    this.assertResultBalance(resultBalance);
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        `${this.kind} cannot be processed without a resolved reference`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  /**
   * Referência ainda ausente: entra (ou permanece) em PENDING_REFERENCE e agenda a
   * próxima tentativa. Chamado de PENDING é o aceite; de PENDING_REFERENCE, uma nova
   * tentativa (incrementa `referenceAttempts`).
   */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal('mark as pending reference');
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._referenceAttempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  /** Violação de regra de negócio. Não altera saldo; `resultBalance` é o saldo observado. */
  reject(code: FailureCode, resultBalance?: Money): void {
    this.assertNotTerminal('reject');
    if (resultBalance !== undefined) this.assertResultBalance(resultBalance);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Erro permanente não-negocial sobre transação já persistida. */
  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** `false` para LOSS (registra o resultado sem mover saldo). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** `true` para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** O kind da referência é aceito por esta transação? (REFUND→BET; ROLLBACK→BET|WIN|REFUND; WIN→BET) */
  isReferenceKindAllowed(reference: WagerTransaction): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind]?.includes(reference.kind) ?? false;
  }

  /**
   * Direção do lançamento. ROLLBACK inverte a direção da referência (exige-a).
   * LOSS não movimenta saldo e, portanto, não tem direção.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Rollback) {
      if (reference === undefined) {
        throw new InvalidWagerTransactionError('ROLLBACK requires its reference to derive the direction');
      }
      if (!this.isReferenceKindAllowed(reference)) {
        throw new InvalidWagerTransactionError(`ROLLBACK cannot reverse a ${reference.kind}`);
      }
      const original = OWN_DIRECTION[reference.kind];
      if (original === undefined) {
        throw new InvalidWagerTransactionError(`${reference.kind} has no ledger direction`);
      }
      return invertDirection(original);
    }
    const direction = OWN_DIRECTION[this.kind];
    if (direction === undefined) {
      throw new InvalidWagerTransactionError(`${this.kind} has no ledger direction`);
    }
    return direction;
  }

  private assertResultBalance(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new InvalidWagerTransactionError(
        `Result balance currency ${balance.currency} differs from the transaction currency ${this.money.currency}`,
      );
    }
    if (balance.isNegative()) {
      throw new InvalidWagerTransactionError('Result balance must not be negative');
    }
  }

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, attempted);
    }
  }
}
