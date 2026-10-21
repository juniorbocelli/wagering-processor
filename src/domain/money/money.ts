import { CurrencyMismatchError, InvalidMoneyError } from './money-errors.ts';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const INPUT_PATTERN = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
/** Forma canônica emitida por `toString()` / devolvida pelo `NUMERIC(19,2)`: escala 2, com sinal opcional. */
const CANONICAL_PATTERN = /^(-?)(0|[1-9]\d{0,16})\.(\d{2})$/;

/** Limite de `NUMERIC(19,2)`: 17 dígitos inteiros + 2 decimais, em centavos. */
const MAX_MINOR = 10n ** 19n - 1n;

function toCurrencyCode(value: unknown): CurrencyCode {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new InvalidMoneyError('Currency must be a 3-letter uppercase ISO-4217 code');
  }
  return value as CurrencyCode;
}

/**
 * Value Object monetário imutável. Representa o valor como `bigint` em centavos
 * (escala fixa 2) — nunca usa ponto flutuante. Ver ADR-001.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  /** Contrato de entrada: string decimal estrita, >= 0, no máximo 2 casas. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money props must be an object');
    }
    const { amount } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Amount must be a decimal string');
    }
    if (!INPUT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid amount: "${amount}"`);
    }
    const currency = toCurrencyCode(props.currency);
    const [whole = '0', fraction = ''] = amount.split('.');
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return new Money(minor, currency);
  }

  /**
   * Reconstrói um valor já persistido ou serializado por `toJSON()`: exige a forma
   * canônica (escala 2) e aceita negativos, que só existem internamente (ex.: diferença
   * de reconciliação). Não usar em fronteiras de entrada — lá vale `from`.
   */
  static rehydrate(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object' || typeof props.amount !== 'string') {
      throw new InvalidMoneyError('Money props must carry a decimal string amount');
    }
    const match = CANONICAL_PATTERN.exec(props.amount);
    if (match === null || (match[1] === '-' && match[2] === '0' && match[3] === '00')) {
      throw new InvalidMoneyError(`Invalid canonical amount: "${props.amount}"`);
    }
    const currency = toCurrencyCode(props.currency);
    const magnitude = BigInt(match[2] ?? '0') * 100n + BigInt(match[3] ?? '00');
    return new Money(match[1] === '-' ? -magnitude : magnitude, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, toCurrencyCode(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  isLessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor <= other.minor;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor >= other.minor;
  }

  /** Igualdade de valor: moedas diferentes nunca são iguais (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre com escala 2 (`"1234.50"`); negativos levam sinal (`"-5.00"`). */
  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const whole = abs / 100n;
    const fraction = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
  }

  private static ofMinor(minor: bigint, currency: CurrencyCode): Money {
    if (minor > MAX_MINOR || minor < -MAX_MINOR) {
      throw new InvalidMoneyError('Amount exceeds the supported magnitude');
    }
    return new Money(minor, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
