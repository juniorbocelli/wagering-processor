import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  TransientInfrastructureError,
  UniqueViolationError,
  ValidationError,
  WalletNotFoundError,
  type Violation,
} from '../errors.ts';
import type {
  InboxRepository,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/persistence.ts';
import type { Clock, IdGenerator, PayloadHasher } from '../ports/runtime.ts';
import { DomainError } from '../../domain/shared/domain-error.ts';
import { Money, type MoneyProps } from '../../domain/money/money.ts';
import { InboxMessage } from '../../domain/messaging/inbox-message.ts';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.ts';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.ts';
import type { WagerSettlement } from './wager-settlement.ts';

/** Comando de entrada, idêntico para HTTP e SQS. Validado aqui, não nos controladores. */
export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null | undefined;
}

export interface ProcessContext {
  correlationId: string;
  /** Presente quando a entrada é SQS: deduplica a entrega por `(consumerName, messageId)`. */
  inbox?: { consumerName: string; messageId: string };
}

export type ProcessWagerTransactionResult =
  /** Processada agora (o status pode ser `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`). */
  | { kind: 'applied'; transaction: WagerTransaction }
  /** Mesma operação já registrada: resposta original, sem novos efeitos. */
  | { kind: 'replay'; transaction: WagerTransaction }
  /** Entrega SQS repetida (inbox hit): efeito já aplicado; basta confirmar a mensagem. */
  | { kind: 'duplicate-delivery' };

interface Prepared {
  command: ProcessWagerTransactionCommand;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  payloadHash: string;
  payloadHashVersion: 1;
}

type Lookup =
  | { kind: 'not-found' }
  | { kind: 'replay'; transaction: WagerTransaction }
  | { kind: 'conflict'; error: IdempotencyConflictError };

const MAX_ATTEMPTS = 3; // check-money:allow
const CONFLICT_BACKOFF_MS = 25; // check-money:allow
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kinds que aceitam `referenceExternalTransactionId` (BET e OPENING não referenciam nada). */
const REFERENCING_KINDS: readonly string[] = [
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export interface ProcessWagerTransactionDependencies {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  settlement: WagerSettlement;
  hasher: PayloadHasher;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Coração financeiro (ADR-002/003/004): **uma transação SQL, um lock de wallet, idempotência
 * persistente**. O mesmo caso de uso atende HTTP e SQS.
 *
 *   1. valida o comando e calcula o `payloadHash`;
 *   2. fast-path: lookup único (key **ou** id externo) sem lock → replay ou conflito;
 *   3. `UnitOfWork.run`: inbox → `FOR UPDATE` da wallet → lookup sob lock → regras →
 *      persistência atômica (transação, ledger, saldo, outbox);
 *   4. `23505` em `uq_wtx_*` / deadlock → repete do passo 2 (máx. 3×).
 */
export class ProcessWagerTransactionUseCase {
  constructor(private readonly deps: ProcessWagerTransactionDependencies) {}

  async execute(
    command: ProcessWagerTransactionCommand,
    ctx: ProcessContext,
  ): Promise<ProcessWagerTransactionResult> {
    const prepared = this.prepare(command);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const known = await this.lookup(prepared);
      if (known.kind === 'replay') return { kind: 'replay', transaction: known.transaction };
      if (known.kind === 'conflict') throw known.error;

      try {
        return await this.deps.uow.run(() => this.runLocked(prepared, ctx));
      } catch (error) {
        if (error instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) {
          // A linha conflitante já está comitada: o próximo lookup a encontra (replay ou 409).
          continue;
        }
        if (error instanceof ConcurrencyConflictError && attempt < MAX_ATTEMPTS) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, CONFLICT_BACKOFF_MS * attempt * (1 + Math.random())),
          );
          continue;
        }
        if (error instanceof UniqueViolationError || error instanceof ConcurrencyConflictError) {
          throw new TransientInfrastructureError('Could not settle the transaction after retries', {
            cause: error,
          });
        }
        throw error;
      }
    }
    throw new TransientInfrastructureError('Could not settle the transaction after retries');
  }

  // ---- passo 1 ---------------------------------------------------------------------------

  private prepare(command: ProcessWagerTransactionCommand): Prepared {
    const violations: Violation[] = [];
    if (typeof command.walletId !== 'string' || !UUID_PATTERN.test(command.walletId)) {
      violations.push({ field: 'walletId', message: 'must be a UUID' });
    }
    const kind = command.kind;
    if (!(Object.values(WagerTransactionKind) as string[]).includes(kind)) {
      violations.push({ field: 'kind', message: `Unknown kind "${String(kind)}"` });
    } else if (kind === WagerTransactionKind.Opening) {
      violations.push({ field: 'kind', message: 'OPENING is internal and cannot be submitted' });
    }

    let money: Money | undefined;
    try {
      money = Money.from(command.money);
    } catch (error) {
      violations.push({ field: 'money', message: error instanceof Error ? error.message : 'Invalid money' });
    }

    const reference = command.referenceExternalTransactionId ?? undefined;
    if (reference !== undefined) {
      if (!REFERENCING_KINDS.includes(kind)) {
        violations.push({ field: 'referenceExternalTransactionId', message: `${kind} cannot carry a reference` });
      } else if (reference.trim().length === 0) {
        violations.push({ field: 'referenceExternalTransactionId', message: 'must not be blank' });
      } else if (reference === command.externalTransactionId) {
        violations.push({ field: 'referenceExternalTransactionId', message: 'must not reference itself' });
      }
    }

    // Toda a validação estrutural do agregado (campos em branco, valor, referência
    // obrigatória) é a do próprio domínio: constrói-se um candidato descartável.
    if (violations.length === 0 && money !== undefined) {
      try {
        this.newTransaction(command, money, reference, 'x'.repeat(64), 1, 'validation', new Date(0));
      } catch (error) {
        if (error instanceof DomainError) {
          violations.push({ field: 'body', message: error.message });
        } else {
          throw error;
        }
      }
    }
    if (violations.length > 0 || money === undefined) {
      throw new ValidationError(violations);
    }

    const { hash, version } = this.deps.hasher.hash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: reference,
    });
    return { command, money, referenceExternalTransactionId: reference, payloadHash: hash, payloadHashVersion: version };
  }

  private newTransaction(
    command: ProcessWagerTransactionCommand,
    money: Money,
    reference: string | undefined,
    payloadHash: string,
    payloadHashVersion: 1,
    correlationId: string,
    createdAt: Date,
  ): WagerTransaction {
    return WagerTransaction.create({
      id: this.deps.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      payloadHashVersion,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: reference,
      correlationId,
      createdAt,
    });
  }

  // ---- passo 2/3c: lookup único (ADR-003 §3) ----------------------------------------------

  private async lookup(prepared: Prepared): Promise<Lookup> {
    const { command, payloadHash } = prepared;
    const rows = await this.deps.transactions.findByIdempotencyOrExternalId(
      command.providerId,
      command.idempotencyKey,
      command.externalTransactionId,
    );
    const [only, second] = rows;
    if (only === undefined) return { kind: 'not-found' };
    if (second !== undefined) {
      return { kind: 'conflict', error: new IdempotencyConflictError('IDEMPOTENCY_KEY_REUSED', command.providerId) };
    }
    if (only.idempotencyKey !== command.idempotencyKey) {
      return {
        kind: 'conflict',
        error: new IdempotencyConflictError('EXTERNAL_TRANSACTION_ID_REUSED', command.providerId),
      };
    }
    if (!only.matchesPayload(payloadHash)) {
      return { kind: 'conflict', error: new IdempotencyConflictError('IDEMPOTENCY_KEY_REUSED', command.providerId) };
    }
    return { kind: 'replay', transaction: only };
  }

  // ---- passo 3: dentro da transação SQL -----------------------------------------------------

  private async runLocked(prepared: Prepared, ctx: ProcessContext): Promise<ProcessWagerTransactionResult> {
    const { command } = prepared;
    const now = this.deps.clock.now();

    // a. inbox primeiro, em todos os caminhos SQS (ordem de aquisição consistente — ADR-002 §3)
    if (ctx.inbox !== undefined) {
      const message = InboxMessage.receive({
        messageId: ctx.inbox.messageId,
        consumerName: ctx.inbox.consumerName,
        payloadHash: prepared.payloadHash,
        receivedAt: now,
      });
      message.markProcessed(now); // a linha só existe se esta transação comitar
      if (!(await this.deps.inbox.insertIfAbsent(message))) {
        const stored = await this.deps.inbox.findPayloadHash(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (stored !== null && stored !== prepared.payloadHash) {
          throw new InboxPayloadMismatchError(ctx.inbox.consumerName, ctx.inbox.messageId);
        }
        return { kind: 'duplicate-delivery' };
      }
    }

    // b. lock pessimista da wallet: primeira leitura dela nesta transação
    const wallet = await this.deps.wallets.lockById(command.walletId);
    if (wallet === null) throw new WalletNotFoundError(command.walletId);

    // c. lookup de novo, agora serializado pelo lock
    const known = await this.lookup(prepared);
    if (known.kind === 'replay') return { kind: 'replay', transaction: known.transaction };
    if (known.kind === 'conflict') throw known.error;

    // d–h. regras de domínio e persistência atômica
    const transaction = this.newTransaction(
      command,
      prepared.money,
      prepared.referenceExternalTransactionId,
      prepared.payloadHash,
      prepared.payloadHashVersion,
      ctx.correlationId,
      now,
    );
    await this.deps.settlement.settle(transaction, wallet, true, {
      causationId: ctx.inbox?.messageId ?? ctx.correlationId,
    });
    return { kind: 'applied', transaction };
  }
}
