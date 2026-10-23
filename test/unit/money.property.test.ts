import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';
import { Money } from '../../src/domain/money/money.ts';
import { canonicalJson } from '../../src/infrastructure/hashing/canonical-json-sha256-hasher.ts';

const NUM_RUNS = Number(process.env['FC_NUM_RUNS'] ?? 300);
const FC_OPTIONS = { numRuns: NUM_RUNS };

const centsArb = fc.bigInt({ min: 0n, max: 10n ** 14n });
const toAmount = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const brl = (cents: bigint) => Money.from({ amount: toAmount(cents), currency: 'BRL' });

describe('Money Properties (Property-Based Testing)', () => {
  it('serialization and parsing is lossless for any valid 2-decimal amount', () => {
    fc.assert(
      fc.property(centsArb, (cents) => {
        const original = brl(cents);
        const serialized = original.toJSON().amount;
        expect(serialized).toBe(toAmount(cents));
        const rehydrated = Money.from({ amount: serialized, currency: 'BRL' });
        expect(rehydrated.equals(original)).toBe(true);
      }),
      FC_OPTIONS,
    );
  });

  it('addition is exact, commutative and associative', () => {
    fc.assert(
      fc.property(centsArb, centsArb, centsArb, (a, b, c) => {
        const ma = brl(a);
        const mb = brl(b);
        const mc = brl(c);

        expect(ma.add(mb).equals(brl(a + b))).toBe(true);
        expect(ma.add(mb).equals(mb.add(ma))).toBe(true);
        expect(ma.add(mb).add(mc).equals(ma.add(mb.add(mc)))).toBe(true);
      }),
      FC_OPTIONS,
    );
  });

  it('subtraction is exact inverse of addition', () => {
    fc.assert(
      fc.property(centsArb, centsArb, (a, b) => {
        const ma = brl(a);
        const mb = brl(b);
        const sum = ma.add(mb);
        expect(sum.subtract(mb).equals(ma)).toBe(true);
        expect(sum.subtract(ma).equals(mb)).toBe(true);
      }),
      FC_OPTIONS,
    );
  });

  it('canonicalJson is invariant to key order', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        (valA, valB, valC) => {
          const obj1 = { a: valA, b: valB, c: valC };
          const obj2 = { c: valC, a: valA, b: valB };
          const obj3 = { b: valB, c: valC, a: valA };
          expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
          expect(canonicalJson(obj2)).toBe(canonicalJson(obj3));
        },
      ),
      FC_OPTIONS,
    );
  });
});
