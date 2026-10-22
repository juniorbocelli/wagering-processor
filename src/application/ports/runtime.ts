import type { MoneyProps } from '../../domain/money/money.ts';

/** Fonte de tempo injetável: testes de backoff/TTL ficam determinísticos. */
export interface Clock {
  now(): Date;
}

/** Gerador de identificadores (UUIDv7 em produção). */
export interface IdGenerator {
  next(): string;
}

/**
 * Subconjunto de campos de negócio que define a identidade de uma operação (ADR-003 §2).
 * `money` já vem normalizado (escala 2); `referenceExternalTransactionId` ausente = omitido.
 */
export interface CanonicalPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface PayloadHash {
  hash: string;
  version: 1;
}

export interface PayloadHasher {
  hash(payload: CanonicalPayload): PayloadHash;
}

/**
 * Pontos de falha injetáveis em testes (no-op em produção). O ponto fica **dentro** da
 * transação financeira, para provar a atomicidade.
 */
export type FaultPoint = 'after_ledger_insert';

export interface FaultInjector {
  trigger(point: FaultPoint): void;
}

export const NOOP_FAULT_INJECTOR: FaultInjector = { trigger: () => undefined };
