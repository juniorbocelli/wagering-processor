import { DomainError } from '../shared/domain-error.ts';
import { Money } from '../money/money.ts';
import { CurrencyMismatchError } from '../money/money-errors.ts';
import { LedgerDirection } from '../ledger/ledger-direction.ts';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.ts';

/** Débito que deixaria o saldo negativo. Rejeição de negócio, decidida pelo use case. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`Insufficient funds: balance ${balance.toString()}, requested ${requested.toString()}`);
  }
}

/** Dados de wallet inválidos (playerId, valor de movimentação, saldo inicial). */
export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';

  constructor(message: string) {
    super(message);
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number; // check-money:allow
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Obrigatório quando `initialBalance > 0`: ids da transação e do lançamento `OPENING`. */
  opening?: { transactionId: string; entryId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Crédito de abertura (`wallet_version = 1`); ausente com saldo inicial zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

const PLAYER_ID_MAX = 128;

/**
 * Aggregate Root. Saldo e lançamento do ledger nascem juntos: `debit`/`credit` devolvem
 * o {@link WalletLedgerEntry} correspondente. `version` começa em 1 e só incrementa
 * quando o saldo muda (ADR-002): uma wallet aberta com saldo zero tem seu primeiro
 * lançamento em `wallet_version = 2`.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number, // check-money:allow
    readonly createdAt: Date,
    private _updatedAt: Date,
    private _persistedVersion: number | undefined, // check-money:allow
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { playerId, initialBalance } = props;
    if (playerId.length < 1 || playerId.length > PLAYER_ID_MAX) {
      throw new InvalidWalletError(`playerId must have 1 to ${PLAYER_ID_MAX} characters`);
    }
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError('Initial balance must not be negative');
    }
    const wallet = new Wallet(
      props.id,
      playerId,
      initialBalance.currency,
      Money.zero(initialBalance.currency),
      1,
      props.at,
      props.at,
      undefined,
    );
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (props.opening === undefined) {
      throw new InvalidWalletError('A positive initial balance requires the opening ids');
    }
    const openingEntry = wallet.apply(
      LedgerDirection.Credit,
      {
        entryId: props.opening.entryId,
        transactionId: props.opening.transactionId,
        money: initialBalance,
        at: props.at,
      },
      1, // o crédito de abertura é o lançamento de wallet_version = 1
    );
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
      state.version,
    );
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number { // check-money:allow
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  /**
   * Token de concorrência otimista: a `version` com que o agregado foi lido/gravado pela
   * última vez (`undefined` se ainda nunca foi persistido). O repositório o usa em
   * `UPDATE … WHERE version = ?`.
   */
  get persistedVersion(): number | undefined { // check-money:allow
    return this._persistedVersion;
  }

  /** Chamado pelo repositório após INSERT/UPDATE bem-sucedido. */
  markPersisted(): void {
    this._persistedVersion = this._version;
  }

  /** Debita; lança {@link InsufficientFundsError} se o saldo não cobrir. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(this._balance, props.money);
    }
    return this.apply(LedgerDirection.Debit, props, this._version + 1);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, props, this._version + 1);
  }

  /** Sem efeito no saldo: apenas lê. Útil para decidir REVERSAL_INSUFFICIENT_FUNDS. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  private apply(
    direction: LedgerDirection,
    props: MovementProps,
    nextVersion: number, // check-money:allow
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(props.money)
        : balanceBefore.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: nextVersion,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = props.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletError('Movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
