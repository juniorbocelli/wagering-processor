import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  LockTimeoutError,
  ProviderIdentityMismatchError,
  TransactionNotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors.ts';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../src/application/use-cases/queries.ts';
import { evaluateAudit } from '../../src/application/use-cases/reconcile-wallet.ts';
import type { WalletLedgerAudit } from '../../src/application/ports/reconciliation.ts';
import { parseLedgerQuery, parseSubmitTransaction } from '../../src/interfaces/http/dto/schemas.ts';
import { statusFor } from '../../src/interfaces/http/controllers/wagering.controller.ts';
import { mapError } from '../../src/interfaces/http/filters/application-exception.filter.ts';

const body = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: 'p',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'r',
  gameId: 'g',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const audit = (over: Partial<WalletLedgerAudit> = {}): WalletLedgerAudit => ({
  walletId: 'w',
  currency: 'BRL',
  storedBalance: '75.00',
  version: 2,
  calculatedBalance: '75.00',
  entries: 2,
  lastWalletVersion: 2,
  brokenLinks: 0,
  ...over,
});

describe('evaluateAudit', () => {
  test('consistent: difference is exactly zero', () => {
    expect(evaluateAudit(audit())).toMatchObject({ consistent: true, difference: { amount: '0.00' }, checkedEntries: 2 });
  });
  test('balance mismatch gives a signed difference (stored − calculated)', () => {
    expect(evaluateAudit(audit({ storedBalance: '70.00' }))).toMatchObject({
      consistent: false,
      difference: { amount: '-5.00', currency: 'BRL' },
    });
  });
  test('a broken chain or a wrong version is a divergence even with equal balances', () => {
    expect(evaluateAudit(audit({ brokenLinks: 1 })).chainIntact).toBe(false);
    expect(evaluateAudit(audit({ version: 3 })).versionConsistent).toBe(false);
  });
  test('empty ledger expects version 1 and zero balance', () => {
    const empty = audit({ storedBalance: '0.00', calculatedBalance: '0.00', entries: 0, lastWalletVersion: null, version: 1 });
    expect(evaluateAudit(empty).consistent).toBe(true);
    expect(evaluateAudit({ ...empty, version: 2 }).consistent).toBe(false);
  });
  test('ledger lost entirely on a funded wallet is flagged by version and balance', () => {
    const lost = audit({ storedBalance: '10.00', calculatedBalance: '0.00', entries: 0, lastWalletVersion: null, version: 1 });
    expect(evaluateAudit(lost)).toMatchObject({ consistent: false, versionConsistent: false });
  });
});

describe('ledger cursor', () => {
  test('is opaque base64url of {"v": n} and round-trips', () => {
    expect(encodeLedgerCursor(7)).toBe(Buffer.from('{"v":7}').toString('base64url'));
    expect(decodeLedgerCursor(encodeLedgerCursor(7))).toBe(7);
  });
  test('rejects garbage with a validation error', () => {
    for (const bad of ['!!', Buffer.from('nope').toString('base64url'), Buffer.from('{"v":-1}').toString('base64url'), Buffer.from('{"v":1.5}').toString('base64url')]) {
      expect(() => decodeLedgerCursor(bad)).toThrow(ValidationError);
    }
  });
});

describe('DTO parsing', () => {
  test('requires Idempotency-Key and reports every violation at once', () => {
    try {
      parseSubmitTransaction({ ...body, unexpected: 1 }, undefined);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const fields = (error as ValidationError).violations.map((v) => v.field);
      expect(fields).toContain('Idempotency-Key');
      expect(fields).toContain('unexpected');
    }
  });
  test('rejects numeric amount, NUL characters and over-long keys', () => {
    expect(() => parseSubmitTransaction({ ...body, money: { amount: 25, currency: 'BRL' } }, 'k')).toThrow(ValidationError);
    expect(() => parseSubmitTransaction({ ...body, roundId: 'a\u0000b' }, 'k')).toThrow(ValidationError);
    expect(() => parseSubmitTransaction(body, 'k'.repeat(256))).toThrow(ValidationError);
    expect(() => parseSubmitTransaction(body, ['a', 'b'])).toThrow(ValidationError);
  });
  test('accepts a valid body and keeps the header as the idempotency key', () => {
    expect(parseSubmitTransaction(body, 'provider-a:tx-1')).toMatchObject({ ...body, idempotencyKey: 'provider-a:tx-1' });
  });
  test('ledger query: limit must be a positive integer string; cursor non-empty', () => {
    expect(parseLedgerQuery({ limit: '10', cursor: 'abc' })).toEqual({ limit: 10, cursor: 'abc' });
    expect(parseLedgerQuery({})).toEqual({ limit: undefined, cursor: undefined });
    for (const bad of [{ limit: 'x' }, { limit: '-1' }, { limit: ['1'] }, { cursor: '' }, { cursor: ['a'] }]) {
      expect(() => parseLedgerQuery(bad)).toThrow(ValidationError);
    }
  });
});

describe('HTTP status mapping (ADR-003 §5)', () => {
  test('write outcomes', () => {
    expect(statusFor('PROCESSED', false)).toBe(201);
    expect(statusFor('PROCESSED', true)).toBe(200);
    expect(statusFor('REJECTED', false)).toBe(422);
    expect(statusFor('REJECTED', true)).toBe(422);
    // FAILED é falha permanente de infraestrutura, não rejeição de negócio (ADR-007).
    expect(statusFor('FAILED', false)).toBe(500);
    expect(statusFor('PENDING_REFERENCE', false)).toBe(202);
    expect(statusFor('PENDING_REFERENCE', true)).toBe(202);
  });
  test('every distinct situation has a distinct status/code', () => {
    expect(mapError(new ValidationError([]))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(mapError(new IdempotencyConflictError('IDEMPOTENCY_KEY_REUSED', 'p'))).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(mapError(new IdempotencyConflictError('EXTERNAL_TRANSACTION_ID_REUSED', 'p'))).toMatchObject({ status: 409, code: 'EXTERNAL_TRANSACTION_ID_REUSED' });
    expect(mapError(new WalletAlreadyExistsError('p', 'BRL'))).toMatchObject({ status: 409, code: 'WALLET_ALREADY_EXISTS' });
    expect(mapError(new WalletNotFoundError('w'))).toMatchObject({ status: 404, code: 'WALLET_NOT_FOUND' });
    expect(mapError(new TransactionNotFoundError('t'))).toMatchObject({ status: 404, code: 'TRANSACTION_NOT_FOUND' });
    expect(mapError(new ProviderIdentityMismatchError())).toMatchObject({ status: 403, code: 'PROVIDER_IDENTITY_MISMATCH' });
    expect(mapError(new LockTimeoutError())).toMatchObject({ status: 503, code: 'TRANSIENT_FAILURE', retryAfterSeconds: 1 });
    expect(mapError(new Error('boom'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
});
