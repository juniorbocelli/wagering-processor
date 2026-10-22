import { describe, expect, test } from 'bun:test';
import {
  CanonicalJsonSha256Hasher,
  canonicalJson,
} from '../../src/infrastructure/hashing/canonical-json-sha256-hasher.ts';
import type { CanonicalPayload } from '../../src/application/ports/runtime.ts';

const hasher = new CanonicalJsonSha256Hasher();

const bet: CanonicalPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys at every level, no whitespace', () => {
    expect(canonicalJson({ b: { z: '1', a: '2' }, a: '3' })).toBe('{"a":"3","b":{"a":"2","z":"1"}}');
  });

  test('escapes strings with standard JSON rules', () => {
    expect(canonicalJson({ a: 'quote " and \\ and \n' })).toBe('{"a":"quote \\" and \\\\ and \\n"}');
  });

  test('omits undefined members', () => {
    expect(canonicalJson({ a: '1', b: undefined })).toBe('{"a":"1"}');
  });

  test('rejects numbers, nulls and arrays (the business payload only has strings)', () => {
    expect(() => canonicalJson({ a: 1 })).toThrow(TypeError);
    expect(() => canonicalJson({ a: null })).toThrow(TypeError);
    expect(() => canonicalJson({ a: ['x'] })).toThrow(TypeError);
  });
});

describe('CanonicalJsonSha256Hasher (payload_hash_version = 1)', () => {
  // Vetores calculados de forma independente: `printf '%s' '<json canônico>' | sha256sum`.
  test('fixed vector: BET without reference', () => {
    expect(hasher.hash(bet)).toEqual({
      hash: 'ab24fa897acc5f289bcfb6b5a67703cc4854df4556add120ea636f9019d23283',
      version: 1,
    });
  });

  test('fixed vector: REFUND with reference', () => {
    const refund: CanonicalPayload = {
      ...bet,
      externalTransactionId: 'refund-1',
      kind: 'REFUND',
      referenceExternalTransactionId: 'transaction-123',
    };
    expect(hasher.hash(refund).hash).toBe('78eed9a4c43732dbdbf88877aab5caddfbfb1244b67224ee1fca0a5f6404971c');
  });

  test('is a 64-char lowercase hex digest', () => {
    expect(hasher.hash(bet).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on property insertion order', () => {
    const reordered: CanonicalPayload = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(hasher.hash(reordered).hash).toBe(hasher.hash(bet).hash);
  });

  test('absent reference is omitted: undefined hashes like no property at all', () => {
    expect(hasher.hash({ ...bet, referenceExternalTransactionId: undefined }).hash).toBe(hasher.hash(bet).hash);
  });

  test('any business field change produces a different hash', () => {
    const base = hasher.hash(bet).hash;
    const variants: CanonicalPayload[] = [
      { ...bet, providerId: 'provider-b' },
      { ...bet, externalTransactionId: 'transaction-124' },
      { ...bet, playerId: 'player-2' },
      { ...bet, walletId: 'wallet-2' },
      { ...bet, roundId: 'round-988' },
      { ...bet, gameId: 'other-game' },
      { ...bet, kind: 'WIN' },
      { ...bet, money: { amount: '25.01', currency: 'BRL' } },
      { ...bet, money: { amount: '25.00', currency: 'USD' } },
      { ...bet, referenceExternalTransactionId: 'x' },
    ];
    for (const variant of variants) {
      expect(hasher.hash(variant).hash).not.toBe(base);
    }
  });

  test('strings are compared byte by byte: no trim, no case folding', () => {
    expect(hasher.hash({ ...bet, providerId: 'Provider-A' }).hash).not.toBe(hasher.hash(bet).hash);
    expect(hasher.hash({ ...bet, providerId: 'provider-a ' }).hash).not.toBe(hasher.hash(bet).hash);
  });

  test('fields outside the business subset do not influence the hash', () => {
    const noisy = { ...bet, idempotencyKey: 'k', messageId: 'm', correlationId: 'c' } as CanonicalPayload;
    expect(hasher.hash(noisy).hash).toBe(hasher.hash(bet).hash);
  });
});
