import { WalletNotFoundError } from '../errors.ts';
import type { UnitOfWork, WagerTransactionRepository, WalletRepository } from '../ports/persistence.ts';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.ts';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-kind.ts';
import type { WagerSettlement } from './wager-settlement.ts';

export interface ReprocessPendingReferenceDependencies {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  settlement: WagerSettlement;
}

export type ReprocessResult =
  /** A transação não existe ou já saiu de `PENDING_REFERENCE` (resolvida por outro caminho). */
  | { kind: 'skipped'; transaction: WagerTransaction | null }
  /** Nova tentativa feita: o estado resultante está em `transaction`. */
  | { kind: 'reprocessed'; transaction: WagerTransaction };

/**
 * Reprocessa uma transação persistida em `PENDING_REFERENCE` (§7.1): reaproveita as regras
 * do caso de uso central sob o mesmo lock de wallet. Resultados possíveis: `PROCESSED` /
 * `REJECTED` (referência chegou), continua pendente (novo backoff) ou
 * `REJECTED(REFERENCE_NOT_FOUND)` (limite de tentativas/TTL esgotado). Idempotente: se outra
 * instância já resolveu a transação, nada acontece.
 */
export class ReprocessPendingReferenceUseCase {
  constructor(private readonly deps: ReprocessPendingReferenceDependencies) {}

  async execute(transactionId: string): Promise<ReprocessResult> {
    const peek = await this.deps.transactions.findById(transactionId);
    if (peek === null || peek.status !== WagerTransactionStatus.PendingReference) {
      return { kind: 'skipped', transaction: peek };
    }

    return this.deps.uow.run(async () => {
      const wallet = await this.deps.wallets.lockById(peek.walletId);
      if (wallet === null) throw new WalletNotFoundError(peek.walletId);

      // Relê sob o lock: outro processo pode ter resolvido a transação entre o peek e o lock.
      const current = await this.deps.transactions.findById(transactionId);
      if (current === null || current.status !== WagerTransactionStatus.PendingReference) {
        return { kind: 'skipped', transaction: current } as const;
      }
      await this.deps.settlement.settle(current, wallet, false, { causationId: current.id });
      return { kind: 'reprocessed', transaction: current } as const;
    });
  }
}
