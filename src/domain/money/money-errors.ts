import { DomainError } from '../shared/domain-error.ts';

/** Entrada monetária inválida (gramática, moeda, limite de magnitude). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

/** Operação binária entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Currency mismatch: ${left} vs ${right}`);
  }
}

/** Moeda bem formada, porém fora da allowlist configurada. */
export class UnsupportedCurrencyError extends DomainError {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor(readonly currency: string) {
    super(`Unsupported currency: ${currency}`);
  }
}
