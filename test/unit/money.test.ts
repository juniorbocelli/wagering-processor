import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { Money } from '../../src/domain/money/money.ts';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/money/money-errors.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const FC = { seed: 20261020, numRuns: 500 };

describe('Money.from — parsing', () => {
  test.each([
    ['0', '0.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.50', '25.50'],
    ['0.01', '0.01'],
    ['1234.56', '1234.56'],
  ])('accepts "%s" and normalizes to "%s"', (input, expected) => {
    expect(brl(input).toString()).toBe(expected);
  });

  test.each([
    '',
    ' 1.00',
    '1.00 ',
    'NaN',
    'Infinity',
    '1e3',
    '0x10',
    '-1.00',
    '+1.00',
    '1.005',
    '01.00',
    '1.',
    '.50',
    '1,00',
    '100000000000000000.00',
  ])('rejects "%s"', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test('rejects JSON numbers (precision already lost)', () => {
    expect(() => Money.from({ amount: 25.5 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test('rejects null/undefined amount and non-object props', () => {
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from(undefined as unknown as { amount: string; currency: string })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(['', 'br', 'BRLL', 'brl', 'B1L', ' BR'])('rejects currency "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('boundaries: largest accepted and first rejected', () => {
    expect(brl('99999999999999999.99').toString()).toBe('99999999999999999.99');
    expect(() => brl('100000000000000000.00')).toThrow(InvalidMoneyError);
  });
});

describe('Money — serialization', () => {
  test('toString and toJSON use fixed scale', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(JSON.stringify({ m: brl('7.1') })).toBe('{"m":{"amount":"7.10","currency":"BRL"}}');
  });

  test('negative values (internal only) carry sign', () => {
    expect(brl('5').subtract(brl('10')).toString()).toBe('-5.00');
    expect(brl('0.05').negate().toString()).toBe('-0.05');
  });

  test('zero', () => {
    expect(Money.zero('BRL').toString()).toBe('0.00');
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(() => Money.zero('xx')).toThrow(InvalidMoneyError);
  });
});

describe('Money — arithmetic and comparison', () => {
  test('add, subtract, negate', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100').subtract(brl('80')).toString()).toBe('20.00');
    expect(brl('1').negate().add(brl('1')).isZero()).toBe(true);
  });

  test('sign predicates', () => {
    expect(brl('1').isPositive()).toBe(true);
    expect(brl('0').isPositive()).toBe(false);
    expect(brl('1').subtract(brl('2')).isNegative()).toBe(true);
    expect(brl('1').isNegative()).toBe(false);
  });

  test('comparisons', () => {
    expect(brl('1').isLessThan(brl('2'))).toBe(true);
    expect(brl('2').isLessThan(brl('2'))).toBe(false);
    expect(brl('2').isLessThanOrEqual(brl('2'))).toBe(true);
    expect(brl('3').isGreaterThan(brl('2'))).toBe(true);
    expect(brl('2').isGreaterThanOrEqual(brl('2'))).toBe(true);
    expect(brl('2').isGreaterThanOrEqual(brl('3'))).toBe(false);
  });

  test('equals is value- and currency-sensitive', () => {
    expect(brl('25').equals(brl('25.00'))).toBe(true);
    expect(brl('25').equals(brl('25.01'))).toBe(false);
    expect(brl('25').equals(usd('25'))).toBe(false);
  });

  test('overflow beyond NUMERIC(19,2) is rejected', () => {
    const max = brl('99999999999999999.99');
    expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(() => max.negate().subtract(brl('0.01'))).toThrow(InvalidMoneyError);
  });
});

describe('Money — currency mismatch', () => {
  const operations: Array<[string, (a: Money, b: Money) => unknown]> = [
    ['add', (a, b) => a.add(b)],
    ['subtract', (a, b) => a.subtract(b)],
    ['isLessThan', (a, b) => a.isLessThan(b)],
    ['isLessThanOrEqual', (a, b) => a.isLessThanOrEqual(b)],
    ['isGreaterThan', (a, b) => a.isGreaterThan(b)],
    ['isGreaterThanOrEqual', (a, b) => a.isGreaterThanOrEqual(b)],
  ];

  test.each(operations)('%s throws CurrencyMismatchError', (_name, op) => {
    expect(() => op(brl('1'), usd('1'))).toThrow(CurrencyMismatchError);
  });
});

describe('Money — immutability', () => {
  test('instances are frozen and operations return new instances', () => {
    const a = brl('10');
    const b = brl('5');
    expect(Object.isFrozen(a)).toBe(true);
    const sum = a.add(b);
    expect(sum).not.toBe(a);
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('5.00');
    expect(Object.isFrozen(sum)).toBe(true);
    expect(Object.isFrozen(a.negate())).toBe(true);
  });

  test('mutation attempts fail', () => {
    const a = brl('10');
    expect(() => {
      (a as unknown as { currency: string }).currency = 'USD';
    }).toThrow(TypeError);
  });
});

describe('Money — properties (fast-check, fixed seed)', () => {
  const minor = fc.bigInt({ min: 0n, max: 10n ** 15n });
  const toMoney = (m: bigint) => brl(`${m / 100n}.${(m % 100n).toString().padStart(2, '0')}`);

  test('a + b - b = a', () => {
    fc.assert(
      fc.property(minor, minor, (x, y) => {
        const a = toMoney(x);
        const b = toMoney(y);
        return a.add(b).subtract(b).equals(a);
      }),
      FC,
    );
  });

  test('addition is commutative', () => {
    fc.assert(
      fc.property(minor, minor, (x, y) => {
        const a = toMoney(x);
        const b = toMoney(y);
        return a.add(b).equals(b.add(a));
      }),
      FC,
    );
  });

  test('x - x is zero', () => {
    fc.assert(
      fc.property(minor, (x) => toMoney(x).subtract(toMoney(x)).isZero()),
      FC,
    );
  });

  test('toString round-trips through Money.from', () => {
    fc.assert(
      fc.property(minor, (x) => {
        const a = toMoney(x);
        return Money.from(a.toJSON()).equals(a);
      }),
      FC,
    );
  });
});

describe('Money.rehydrate', () => {
  const rehydrate = (amount: string, currency = 'BRL') => Money.rehydrate({ amount, currency });

  test.each(['0.00', '25.50', '99999999999999999.99', '-5.00', '-0.01'])(
    'accepts canonical "%s" and round-trips',
    (amount) => {
      expect(rehydrate(amount).toString()).toBe(amount);
    },
  );

  test.each(['25', '25.5', '1.005', '-0.00', '+1.00', '01.00', '', '1e3', ' 1.00', '100000000000000000.00'])(
    'rejects non-canonical "%s"',
    (amount) => {
      expect(() => rehydrate(amount)).toThrow(InvalidMoneyError);
    },
  );

  test('rejects non-string amount and invalid currency', () => {
    expect(() => Money.rehydrate({ amount: 5 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => rehydrate('1.00', 'brl')).toThrow(InvalidMoneyError);
  });

  test('reads back a negative reconciliation difference emitted by toJSON', () => {
    const difference = brl('5').subtract(brl('10'));
    expect(Money.rehydrate(difference.toJSON()).equals(difference)).toBe(true);
  });

  test('Money.from still rejects negatives', () => {
    expect(() => brl('-5.00')).toThrow(InvalidMoneyError);
  });
});
