/**
 * Catálogo fechado de `failureCode` (ADR-007). A ordem é a de avaliação no use case.
 * Replicado como CHECK no banco; um teste de paridade compara os dois.
 */
export const FAILURE_CODES = [
  'WALLET_PLAYER_MISMATCH',
  'CURRENCY_MISMATCH',
  'REFERENCE_SCOPE_MISMATCH',
  'REFERENCE_KIND_NOT_ALLOWED',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_ALREADY_REVERSED',
  'AMOUNT_MISMATCH',
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'REFERENCE_NOT_FOUND',
  'PROCESSING_FAILED',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && (FAILURE_CODES as readonly string[]).includes(value);
}
