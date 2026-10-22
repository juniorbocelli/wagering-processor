import type { WagerTransaction } from '../domain/wagering/wager-transaction.ts';

/**
 * Política de espera por referências fora de ordem (§7.1): backoff exponencial de 1 s a
 * 60 s; esgotado o limite de tentativas **ou** o TTL, a transação é rejeitada com
 * `REFERENCE_NOT_FOUND`. Valores em milissegundos; sem relação com dinheiro.
 */
export interface PendingReferencePolicy {
  initialDelayMs: number; // check-money:allow
  maxDelayMs: number; // check-money:allow
  maxAttempts: number; // check-money:allow
  ttlMs: number; // check-money:allow
}

export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 12,
  ttlMs: 15 * 60_000,
};

/** Atraso até a próxima tentativa, dado quantas já ocorreram (0 → `initialDelayMs`). */
export function pendingReferenceDelayMs(policy: PendingReferencePolicy, attempts: number): number { // check-money:allow
  const exponential = policy.initialDelayMs * 2 ** Math.min(attempts, 30);
  return exponential > policy.maxDelayMs ? policy.maxDelayMs : exponential;
}

export function isPendingReferenceExhausted(
  policy: PendingReferencePolicy,
  tx: WagerTransaction,
  now: Date,
): boolean {
  return (
    tx.referenceAttempts + 1 >= policy.maxAttempts ||
    now.getTime() - tx.createdAt.getTime() >= policy.ttlMs
  );
}
