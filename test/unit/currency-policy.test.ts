import { describe, expect, test } from 'bun:test';
import { CurrencyPolicy } from '../../src/domain/money/currency-policy.ts';
import { InvalidMoneyError, UnsupportedCurrencyError } from '../../src/domain/money/money-errors.ts';

describe('CurrencyPolicy', () => {
  const policy = CurrencyPolicy.fromList('BRL, USD,EUR');

  test('supports allowlisted currencies only', () => {
    expect(policy.isSupported('BRL')).toBe(true);
    expect(policy.isSupported('EUR')).toBe(true);
    expect(policy.isSupported('ZZZ')).toBe(false);
    expect(policy.isSupported('brl')).toBe(false);
  });

  test('assertSupported throws UnsupportedCurrencyError', () => {
    expect(() => policy.assertSupported('USD')).not.toThrow();
    expect(() => policy.assertSupported('FOO')).toThrow(UnsupportedCurrencyError);
  });

  test('rejects empty or malformed allowlists', () => {
    expect(() => CurrencyPolicy.fromList('')).toThrow(InvalidMoneyError);
    expect(() => CurrencyPolicy.fromList('BRL,usd')).toThrow(InvalidMoneyError);
    expect(() => CurrencyPolicy.of([])).toThrow(InvalidMoneyError);
  });
});
