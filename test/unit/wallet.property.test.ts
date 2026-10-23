import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';
import { Money } from '../../src/domain/money/money.ts';
import { InsufficientFundsError, Wallet } from '../../src/domain/wallet/wallet.ts';

const NUM_RUNS = Number(process.env['FC_NUM_RUNS'] ?? 200);
const FC_OPTIONS = { numRuns: NUM_RUNS };

const cents = (val: bigint) => `${val / 100n}.${String(val % 100n).padStart(2, '0')}`;
const money = (val: bigint) => Money.from({ amount: cents(val), currency: 'BRL' });

describe('Wallet Balance Properties', () => {
  it('balance cannot be driven negative by any debit operation', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.bigInt({ min: 1n, max: 200_000n }),
        (initial, debitAmount) => {
          const at = new Date('2026-10-23T10:00:00.000Z');
          const initialBalance = money(initial);
          const { wallet } = Wallet.open({
            id: 'wallet-prop-1',
            playerId: 'player-prop-1',
            initialBalance,
            at,
            ...(initial > 0n ? { opening: { entryId: 'e-open', transactionId: 'tx-open' } } : {}),
          });

          const debitMoney = money(debitAmount);
          if (debitAmount > initial) {
            expect(() =>
              wallet.debit({
                entryId: 'e-debit-1',
                transactionId: 'tx-debit-1',
                money: debitMoney,
                at,
              }),
            ).toThrow(InsufficientFundsError);
            expect(wallet.balance.equals(initialBalance)).toBe(true);
            expect(wallet.balance.isNegative()).toBe(false);
          } else {
            const entry = wallet.debit({
              entryId: 'e-debit-1',
              transactionId: 'tx-debit-1',
              money: debitMoney,
              at,
            });
            expect(wallet.balance.equals(money(initial - debitAmount))).toBe(true);
            expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
            expect(wallet.balance.isNegative()).toBe(false);
          }
        },
      ),
      FC_OPTIONS,
    );
  });

  it('credit always increases balance and maintains ledger chain continuity', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.bigInt({ min: 1n, max: 100_000n }),
        (initial, creditAmount) => {
          const at = new Date('2026-10-23T10:00:00.000Z');
          const initialBalance = money(initial);
          const { wallet } = Wallet.open({
            id: 'wallet-prop-2',
            playerId: 'player-prop-2',
            initialBalance,
            at,
            ...(initial > 0n ? { opening: { entryId: 'e-open', transactionId: 'tx-open' } } : {}),
          });

          const beforeVersion = wallet.version;
          const beforeBalance = wallet.balance;
          const creditMoney = money(creditAmount);

          const entry = wallet.credit({
            entryId: 'e-credit-1',
            transactionId: 'tx-credit-1',
            money: creditMoney,
            at,
          });

          expect(wallet.balance.equals(money(initial + creditAmount))).toBe(true);
          expect(entry.balanceBefore.equals(beforeBalance)).toBe(true);
          expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
          expect(wallet.version).toBe(beforeVersion + 1);
        },
      ),
      FC_OPTIONS,
    );
  });
});
