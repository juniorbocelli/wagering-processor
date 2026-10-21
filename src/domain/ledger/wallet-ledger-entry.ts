import { DomainError } from '../shared/domain-error.ts';
import { Money } from '../money/money.ts';
import { LedgerDirection } from './ledger-direction.ts';

/** Lançamento de ledger que viola aritmética, moeda ou sinal. É erro de programação. */
export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(message: string) {
    super(message);
  }
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number; // check-money:allow
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento imutável do ledger: todos os campos são `readonly`, sem setters nem
 * transições. A aritmética é validada na criação e replicada por CHECK no banco.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number, // check-money:allow
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger balances must not be negative');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('Ledger walletVersion must be an integer >= 1');
    }
    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced ledger entry: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} != ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** `balanceBefore ± money === balanceAfter`, conforme a direção. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }
}
