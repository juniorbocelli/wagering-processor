export const LedgerDirection = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;

export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export function invertDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

export function isLedgerDirection(value: unknown): value is LedgerDirection {
  return value === LedgerDirection.Debit || value === LedgerDirection.Credit;
}
