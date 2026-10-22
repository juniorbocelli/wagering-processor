import { WalletNotFoundError } from '../errors.ts';
import { NOOP_METRICS, type Metrics } from '../ports/observability.ts';
import type { UnitOfWork, WagerTransactionRepository, WalletRepository } from '../ports/persistence.ts';
import type { Clock } from '../ports/runtime.ts';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.ts';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-kind.ts';
import type { WagerSettlement } from './wager-settlement.ts';

export interface ReprocessPendingReferenceDependencies {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  settlement: WagerSettlement;
  clock: Clock;
  metrics?: Metrics;
}

export type ReprocessResult =
  /** A transação não existe, já saiu de `PENDING_REFERENCE` ou ainda não está na hora (outra instância a tratou). */
  | { kind: 'skipped'; transaction: WagerTransaction | null }
  /** Nova tentativa feita: o estado resultante está em `transaction`. */
  | { kind: 'reprocessed'; transaction: WagerTransaction };

/**
 * Reprocessa uma transação persistida em `PENDING_REFERENCE` (§7.1): reaproveita as regras
 * do caso de uso central sob o mesmo lock de wallet. Resultados possíveis: `PROCESSED` /
 * `REJECTED` (referência chegou), continua pendente (novo backoff) ou
 * `REJECTED(REFERENCE_NOT_FOUND)` (limite de tentativas/TTL esgotado).
 *
 * Idempotente e seguro com N workers: sob o lock da wallet a transação é relida e só é
 * tentada se **ainda** estiver pendente **e** com a próxima tentativa vencida — uma segunda
 * instância que chegue depois da primeira encontra o novo backoff e não consome tentativa.
 */
export class ReprocessPendingReferenceUseCase {
  private readonly metrics: Metrics;

  constructor(private readonly deps: ReprocessPendingReferenceDependencies) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
  }

  async execute(transactionId: string): Promise<ReprocessResult> {
    const peek = await this.deps.transactions.findById(transactionId);
    if (!this.isDue(peek)) {
      return { kind: 'skipped', transaction: peek };
    }

    const result = await this.deps.uow.run(async () => {
      const wallet = await this.deps.wallets.lockById(peek.walletId);
      if (wallet === null) throw new WalletNotFoundError(peek.walletId);

      // Relê sob o lock: outro processo pode ter resolvido a transação entre o peek e o lock.
      const current = await this.deps.transactions.findById(transactionId);
      if (!this.isDue(current)) {
        return { kind: 'skipped', transaction: current } as const;
      }
      await this.deps.settlement.settle(current, wallet, false, { causationId: current.id });
      return { kind: 'reprocessed', transaction: current } as const;
    });

    if (
      result.kind === 'reprocessed' &&
      result.transaction.status !== WagerTransactionStatus.PendingReference
    ) {
      this.metrics.transactionSettled(result.transaction.status, result.transaction.kind);
    }
    return result;
  }

  private isDue(tx: WagerTransaction | null): tx is WagerTransaction {
    if (tx === null || tx.status !== WagerTransactionStatus.PendingReference) return false;
    const next = tx.nextReferenceAttemptAt;
    return next === undefined || next.getTime() <= this.deps.clock.now().getTime();
  }
}
