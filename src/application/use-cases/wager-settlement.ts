import type {
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/persistence.ts';
import type { Clock, FaultInjector, IdGenerator } from '../ports/runtime.ts';
import {
  isPendingReferenceExhausted,
  pendingReferenceDelayMs,
  type PendingReferencePolicy,
} from '../pending-reference-policy.ts';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.ts';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-kind.ts';
import { LedgerDirection } from '../../domain/ledger/ledger-direction.ts';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.ts';
import type { Wallet } from '../../domain/wallet/wallet.ts';
import { OutboxMessage } from '../../domain/messaging/outbox-message.ts';
import type { IntegrationEvent } from '../../domain/events/integration-event.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wager-events.ts';

export type ReferenceVerdict =
  | 'REFERENCE_SCOPE_MISMATCH'
  | 'REFERENCE_KIND_NOT_ALLOWED'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'AMOUNT_MISMATCH'
  | 'WAIT'
  | undefined;

export interface SettlementDependencies {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  clock: Clock;
  ids: IdGenerator;
  faults: FaultInjector;
  pendingReference: PendingReferencePolicy;
}

export interface SettlementContext {
  /** Mensagem/requisição de origem do efeito (vira `causationId` dos eventos). */
  causationId?: string | undefined;
}

/**
 * Aplica as regras de negócio (§7) a **uma** transação sob o lock da wallet e persiste o
 * resultado — transação, lançamento, saldo e eventos — no `UnitOfWork` corrente. Quem chama
 * é responsável por já ter `wallet` travada (`FOR UPDATE`) e por estar dentro de
 * `UnitOfWork.run`. Compartilhado por `ProcessWagerTransactionUseCase` (transação nova) e
 * `ReprocessPendingReferenceUseCase` (transação persistida em `PENDING_REFERENCE`).
 *
 * Ordem de avaliação (ADR-007 §2): identidade → referência → saldo. A primeira regra
 * violada define o `failureCode`.
 */
export class WagerSettlement {
  constructor(private readonly deps: SettlementDependencies) {}

  /**
   * Liquida `tx` e, se ela virou `PROCESSED`, resolve em cascata as `PENDING_REFERENCE` da
   * mesma wallet que aguardavam por ela (mesmo lock, mesma transação SQL).
   */
  async settle(tx: WagerTransaction, wallet: Wallet, isNew: boolean, ctx: SettlementContext): Promise<void> {
    await this.settleOne(tx, wallet, isNew, ctx);
    if (tx.status !== WagerTransactionStatus.Processed) return;

    const queue: WagerTransaction[] = [tx];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const dependents = await this.deps.transactions.listPendingByReference(
        wallet.id,
        next.providerId,
        next.externalTransactionId,
      );
      for (const dependent of dependents) {
        await this.settleOne(dependent, wallet, false, { causationId: next.id });
        if (dependent.status === WagerTransactionStatus.Processed) queue.push(dependent);
      }
    }
  }

  private async settleOne(
    tx: WagerTransaction,
    wallet: Wallet,
    isNew: boolean,
    ctx: SettlementContext,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const wasPendingReference = tx.status === WagerTransactionStatus.PendingReference;
    const entry = await this.decide(tx, wallet, now);

    if (isNew) {
      await this.deps.transactions.add(tx);
    } else {
      await this.deps.transactions.update(tx);
    }
    if (entry !== undefined) {
      await this.deps.ledger.add(entry);
      this.deps.faults.trigger('after_ledger_insert');
      // Um UPDATE por movimento: o trigger diferido exige `version = anterior + 1` por linha.
      await this.deps.wallets.save(wallet);
    }
    await this.publishEvents(tx, wallet, entry, now, ctx, isNew || !wasPendingReference);
  }

  /** Muta `tx` (e `wallet`, se mover saldo) conforme as regras; devolve o lançamento, se houve. */
  private async decide(tx: WagerTransaction, wallet: Wallet, now: Date): Promise<WalletLedgerEntry | undefined> {
    // Violações de identidade não carregam saldo observado: em CURRENCY_MISMATCH não há saldo
    // na moeda da transação e em WALLET_PLAYER_MISMATCH o saldo pertence a outro jogador.
    if (tx.playerId !== wallet.playerId) {
      tx.reject('WALLET_PLAYER_MISMATCH');
      return undefined;
    }
    if (tx.money.currency !== wallet.currency) {
      tx.reject('CURRENCY_MISMATCH');
      return undefined;
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const found = await this.deps.transactions.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      if (found === null) {
        this.awaitReference(tx, wallet, now, 'REFERENCE_NOT_FOUND');
        return undefined;
      }
      reference = found;
      const verdict = await this.checkReference(tx, reference);
      if (verdict === 'WAIT') {
        // A referência existe, mas também aguarda a sua: quando ela for processada, a cascata
        // de `settle` resolve esta transação (ordem de chegada não muda o resultado).
        this.awaitReference(tx, wallet, now, 'REFERENCE_NOT_PROCESSED');
        return undefined;
      }
      if (verdict !== undefined) {
        tx.reject(verdict, wallet.balance);
        return undefined;
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return undefined;
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      tx.reject(
        tx.requiresReference() ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS',
        wallet.balance,
      );
      return undefined;
    }

    const movement = {
      entryId: this.deps.ids.next(),
      transactionId: tx.id,
      money: tx.money,
      at: now,
    };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, now, wallet.balance);
    return entry;
  }

  /** Referência ausente/pendente: (re)agenda a tentativa ou, esgotado o limite/TTL, rejeita. */
  private awaitReference(
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    exhaustedCode: 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_PROCESSED',
  ): void {
    const policy = this.deps.pendingReference;
    if (
      tx.status === WagerTransactionStatus.PendingReference &&
      isPendingReferenceExhausted(policy, tx, now)
    ) {
      tx.reject(exhaustedCode, wallet.balance);
      return;
    }
    const upcomingAttempts =
      tx.status === WagerTransactionStatus.PendingReference ? tx.referenceAttempts + 1 : 0;
    const delay = pendingReferenceDelayMs(policy, upcomingAttempts);
    tx.markPendingReference(new Date(now.getTime() + delay));
  }

  /** Regras da referência já resolvida (§7.2–§7.5); `undefined` = válida, `'WAIT'` = referência pendente. */
  private async checkReference(
    tx: WagerTransaction,
    reference: WagerTransaction,
  ): Promise<ReferenceVerdict> {
    const sameScope =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameScope) return 'REFERENCE_SCOPE_MISMATCH';
    if (!tx.isReferenceKindAllowed(reference)) return 'REFERENCE_KIND_NOT_ALLOWED';
    if (reference.status === WagerTransactionStatus.PendingReference) return 'WAIT';
    if (reference.status !== WagerTransactionStatus.Processed) return 'REFERENCE_NOT_PROCESSED';
    if (tx.requiresReference()) {
      if (await this.deps.transactions.existsProcessedReversalOf(reference.id)) {
        return 'REFERENCE_ALREADY_REVERSED';
      }
      if (!tx.money.equals(reference.money)) return 'AMOUNT_MISMATCH';
    }
    return undefined;
  }

  private async publishEvents(
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    now: Date,
    ctx: SettlementContext,
    announcePending: boolean,
  ): Promise<void> {
    const eventContext = () => ({
      eventId: this.deps.ids.next(),
      correlationId: tx.correlationId,
      causationId: ctx.causationId,
      occurredAt: now,
    });
    const events: IntegrationEvent<unknown>[] = [];

    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        if (entry !== undefined) events.push(WalletBalanceChanged.from(wallet, entry, eventContext()));
        events.push(WagerTransactionProcessed.from(tx, wallet, eventContext()));
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(tx, now, eventContext()));
        break;
      case WagerTransactionStatus.PendingReference:
        // Só o aceite inicial é anunciado; novas tentativas não geram eventos.
        if (announcePending) events.push(WagerTransactionPendingReference.from(tx, eventContext()));
        break;
      default:
        break;
    }
    for (const event of events) {
      await this.deps.outbox.add(OutboxMessage.enqueue(event));
    }
  }
}
