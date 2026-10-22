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
 * Pontos de falha injetáveis em testes (no-op em produção). `after_ledger_insert` fica
 * **dentro** da transação financeira, para provar a atomicidade; os `crash_*` ficam nas
 * fronteiras de mensageria (depois do commit e antes do ack do SQS; depois de publicar
 * e antes de marcar a outbox) e simulam a morte do processo.
 */
export type FaultPoint =
  | 'after_ledger_insert'
  | 'crash_after_commit_before_ack'
  | 'crash_after_publish_before_mark';

/**
 * Substituto em-processo da morte do processo: quem a recebe **abandona** o trabalho no
 * ponto exato (sem ack, sem liberar lease), como se o processo tivesse sido encerrado.
 * Em execução real o injetor de ambiente mata o processo com `SIGKILL`.
 */
export class SimulatedCrashError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrashError';
  }
}

export interface FaultInjector {
  trigger(point: FaultPoint): void;
}

export const NOOP_FAULT_INJECTOR: FaultInjector = { trigger: () => undefined };
