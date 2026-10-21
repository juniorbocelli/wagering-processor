import { InvalidMoneyError, UnsupportedCurrencyError } from './money-errors.ts';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Allowlist de moedas suportadas (ADR-001). Pura: quem lê `SUPPORTED_CURRENCIES` do
 * ambiente é a infraestrutura, que constrói a política e a aplica nas fronteiras de
 * entrada (DTOs, consumer). `Money` valida apenas o formato ISO-4217.
 */
export class CurrencyPolicy {
  private constructor(private readonly supported: ReadonlySet<string>) {
    Object.freeze(this);
  }

  static of(codes: readonly string[]): CurrencyPolicy {
    if (codes.length === 0) {
      throw new InvalidMoneyError('At least one supported currency is required');
    }
    for (const code of codes) {
      if (!CURRENCY_PATTERN.test(code)) {
        throw new InvalidMoneyError(`Invalid currency in allowlist: "${code}"`);
      }
    }
    return new CurrencyPolicy(new Set(codes));
  }

  /** Aceita a lista separada por vírgulas de `SUPPORTED_CURRENCIES` (ex.: `BRL,USD,EUR`). */
  static fromList(csv: string): CurrencyPolicy {
    return CurrencyPolicy.of(csv.split(',').map((code) => code.trim()));
  }

  isSupported(code: string): boolean {
    return this.supported.has(code);
  }

  assertSupported(code: string): void {
    if (!this.isSupported(code)) {
      throw new UnsupportedCurrencyError(code);
    }
  }
}
