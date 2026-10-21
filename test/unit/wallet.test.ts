import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.ts';
import { CurrencyMismatchError } from '../../src/domain/money/money-errors.ts';
import { InsufficientFundsError, InvalidWalletError, Wallet } from '../../src/domain/wallet/wallet.ts';
import { InvalidLedgerEntryError, WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry.ts';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-10-21T12:00:00.000Z');
const later = new Date('2026-10-21T12:05:00.000Z');

const move = (n: number, money: Money, when = later) => ({
  entryId: `entry-${n}`,
  transactionId: `tx-${n}`,
  money,
  at: when,
});

const open = (initial: string) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-opaque-1',
    initialBalance: brl(initial),
    at,
    opening: { transactionId: 'tx-open', entryId: 'entry-open' },
  });

describe('Wallet.open', () => {
  test('with balance: version 1 and an OPENING credit with wallet_version 1', () => {
    const { wallet, openingEntry } = open('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
    expect(openingEntry?.transactionId).toBe('tx-open');
  });

  test('with zero balance: no ledger entry; first movement has wallet_version 2', () => {
    const { wallet, openingEntry } = open('0');
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
    const entry = wallet.credit(move(1, brl('10.00')));
    expect(entry.walletVersion).toBe(2);
    expect(wallet.version).toBe(2);
  });

  test('positive balance without opening ids is a programming error', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at }),
    ).toThrow(InvalidWalletError);
  });

  test.each(['', 'x'.repeat(129)])('rejects playerId of invalid length', (playerId) => {
    expect(() =>
      Wallet.open({ id: 'w', playerId, initialBalance: brl('0'), at }),
    ).toThrow(InvalidWalletError);
  });

  test('playerId is opaque: non-UUID values are accepted', () => {
    const { wallet } = Wallet.open({ id: 'w', playerId: 'provider|player#42', initialBalance: brl('0'), at });
    expect(wallet.playerId).toBe('provider|player#42');
  });
});

describe('Wallet movements', () => {
  test('debit lowers the balance, bumps version and returns a balanced entry', () => {
    const { wallet } = open('100.00');
    const entry = wallet.debit(move(1, brl('80.00')));
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('debit of the exact balance is allowed and leaves zero', () => {
    const { wallet } = open('50.00');
    wallet.debit(move(1, brl('50.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('debit above the balance throws and leaves the wallet untouched', () => {
    const { wallet } = open('100.00');
    expect(() => wallet.debit(move(1, brl('100.01')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('credit raises the balance', () => {
    const { wallet } = open('10.00');
    const entry = wallet.credit(move(1, brl('15.50')));
    expect(wallet.balance.toString()).toBe('25.50');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('currency mismatch is rejected on debit, credit and canDebit', () => {
    const { wallet } = open('100.00');
    expect(() => wallet.debit(move(1, usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move(1, usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('zero amount movement is rejected', () => {
    const { wallet } = open('100.00');
    expect(() => wallet.debit(move(1, brl('0')))).toThrow(InvalidWalletError);
    expect(() => wallet.credit(move(1, brl('0')))).toThrow(InvalidWalletError);
  });

  test('version increases exactly once per balance change and the chain is continuous', () => {
    const { wallet, openingEntry } = open('100.00');
    const entries = [
      openingEntry!,
      wallet.debit(move(1, brl('30.00'))),
      wallet.credit(move(2, brl('5.00'))),
      wallet.debit(move(3, brl('75.00'))),
    ];
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
    }
    expect(wallet.balance.equals(entries.at(-1)!.balanceAfter)).toBe(true);
  });

  test('rehydrate does not revalidate and restores state', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('7.00'),
      version: 9,
      createdAt: at,
      updatedAt: later,
    });
    expect(wallet.version).toBe(9);
    expect(wallet.balance.toString()).toBe('7.00');
  });
});

describe('WalletLedgerEntry.create', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    walletVersion: 2,
    createdAt: at,
  };

  test('accepts a balanced debit and credit', () => {
    expect(
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('70.00'),
      }).isBalanced(),
    ).toBe(true);
    expect(
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('130.00'),
      }).isBalanced(),
    ).toBe(true);
  });

  test('rejects wrong arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('60.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects direction that contradicts the balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('70.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects zero amount, negative balances and invalid version', () => {
    const ok = {
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0'),
      balanceAfter: brl('1.00'),
    };
    expect(() => WalletLedgerEntry.create({ ...ok, money: brl('0'), balanceAfter: brl('0') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create({ ...ok, walletVersion: 0 })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...ok, walletVersion: 1.5 })).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...ok,
        direction: LedgerDirection.Debit,
        balanceBefore: brl('0'),
        balanceAfter: Money.rehydrate({ amount: '-1.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0'),
      balanceAfter: brl('1.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletVersion: number }).walletVersion = 99;
    }).toThrow();
  });
});

describe('Wallet optimistic-concurrency token', () => {
  test('a new wallet has no persisted version; markPersisted and rehydrate track it', () => {
    const { wallet } = open('100.00');
    expect(wallet.persistedVersion).toBeUndefined();
    wallet.markPersisted();
    expect(wallet.persistedVersion).toBe(1);
    wallet.debit(move(1, brl('10.00')));
    expect(wallet.version).toBe(2);
    expect(wallet.persistedVersion).toBe(1); // ainda é a versão gravada
    wallet.markPersisted();
    expect(wallet.persistedVersion).toBe(2);
    const loaded = Wallet.rehydrate({
      id: 'w', playerId: 'p', currency: 'BRL', balance: brl('1.00'), version: 7, createdAt: at, updatedAt: at,
    });
    expect(loaded.persistedVersion).toBe(7);
  });
});
