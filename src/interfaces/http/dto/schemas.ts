import { z } from 'zod';
import { ValidationError, type Violation } from '../../../application/errors.ts';
import type { ProcessWagerTransactionCommand } from '../../../application/use-cases/process-wager-transaction.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUL = '\u0000';

/**
 * Texto livre opaco (IDs de provedor). Nenhum `trim`/case folding — IDs são comparados byte a
 * byte (ADR-003 §2). `NUL` é rejeitado porque o PostgreSQL não o aceita em `text`: sem isso
 * seria um 500 em vez de um 400.
 */
const text = (max: number) => // check-money:allow
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes(NUL), 'must not contain NUL characters')
    .refine((value) => value.trim().length > 0, 'must be a non-blank string');

/** `amount` precisa ser string: um número JSON (`25.0`) é rejeitado já na fronteira (§5.1). */
const moneySchema = z.strictObject({ amount: z.string(), currency: z.string() });

export const createWalletSchema = z.strictObject({
  playerId: text(128),
  initialBalance: moneySchema,
});

export const submitTransactionSchema = z.strictObject({
  providerId: text(64),
  externalTransactionId: text(128),
  playerId: text(128),
  walletId: z.string(),
  roundId: text(128),
  gameId: text(128),
  kind: z.string(),
  money: moneySchema,
  referenceExternalTransactionId: text(128).nullish(),
});

const idempotencyKeySchema = text(255);

function toViolations(error: z.ZodError, prefix = ''): Violation[] {
  return error.issues.flatMap((issue): Violation[] => {
    const base = [...(prefix === '' ? [] : [prefix]), ...issue.path.map(String)];
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ field: [...base, key].join('.'), message: 'Unknown field' }));
    }
    return [{ field: base.length === 0 ? 'body' : base.join('.'), message: issue.message }];
  });
}

/** Valida contra o schema; qualquer falha vira `ValidationError` (HTTP 400, `VALIDATION_ERROR`). */
export function parseWith<T>(schema: z.ZodType<T>, input: unknown, prefix = ''): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError(toViolations(result.error, prefix));
  return result.data;
}

export function parseCreateWallet(body: unknown): z.infer<typeof createWalletSchema> {
  return parseWith(createWalletSchema, body);
}

/** Corpo + header `Idempotency-Key` (obrigatório e fonte da verdade — ADR-003 §1). */
export function parseSubmitTransaction(
  body: unknown,
  idempotencyKeyHeader: string | string[] | undefined,
): ProcessWagerTransactionCommand {
  const violations: Violation[] = [];
  let idempotencyKey = '';
  if (idempotencyKeyHeader === undefined) {
    violations.push({ field: 'Idempotency-Key', message: 'Header is required' });
  } else {
    const parsed = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
    if (parsed.success) idempotencyKey = parsed.data;
    else violations.push({ field: 'Idempotency-Key', message: 'Must be a single non-empty value of up to 255 characters' });
  }

  const parsedBody = submitTransactionSchema.safeParse(body);
  if (!parsedBody.success) violations.push(...toViolations(parsedBody.error));
  if (violations.length > 0 || !parsedBody.success) throw new ValidationError(violations);

  return { ...parsedBody.data, idempotencyKey };
}

export function parseUuidParam(field: string, value: string): string {
  if (!UUID_PATTERN.test(value)) throw new ValidationError([{ field, message: 'must be a UUID' }]);
  return value;
}

/** Parâmetro de rota opaco (ex.: `providerId`): só barra o que o banco recusaria. */
export function parseOpaqueParam(field: string, value: string, max: number): string { // check-money:allow
  if (value.length === 0 || value.length > max || value.includes(NUL)) {
    throw new ValidationError([{ field, message: `must have 1 to ${max} characters and no NUL` }]);
  }
  return value;
}

export interface LedgerQuery {
  cursor: string | undefined;
  limit: number | undefined; // check-money:allow
}

export function parseLedgerQuery(query: Readonly<Record<string, unknown>>): LedgerQuery {
  const violations: Violation[] = [];

  const rawCursor = query['cursor'];
  let cursor: string | undefined;
  if (rawCursor !== undefined) {
    if (typeof rawCursor === 'string' && rawCursor.length > 0) cursor = rawCursor;
    else violations.push({ field: 'cursor', message: 'must be a non-empty string' });
  }

  const rawLimit = query['limit'];
  let limit: number | undefined; // check-money:allow
  if (rawLimit !== undefined) {
    if (typeof rawLimit === 'string' && /^\d{1,6}$/.test(rawLimit)) limit = Number.parseInt(rawLimit, 10);
    else violations.push({ field: 'limit', message: 'must be a positive integer' });
  }

  if (violations.length > 0) throw new ValidationError(violations);
  return { cursor, limit };
}
