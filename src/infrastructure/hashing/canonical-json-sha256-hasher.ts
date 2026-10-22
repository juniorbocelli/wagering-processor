import { createHash } from 'node:crypto';
import type { CanonicalPayload, PayloadHash, PayloadHasher } from '../../application/ports/runtime.ts';

/**
 * Serialização canônica (subconjunto da RFC 8785 / JCS, ADR-003 §2): chaves ordenadas por
 * unidade de código UTF-16 em todos os níveis, sem espaços, escaping JSON padrão.
 *
 * Racional: Provedores externos usam stacks variadas (Go, Java, Python, C++) que serializam
 * JSON com ordenação arbitrária de propriedades. A canonização garante que dois payloads
 * semanticamente idênticos gerem sempre o mesmo SHA-256, evitando falsos conflitos de idempotência.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError('Canonical payload only supports strings and plain objects');
}

/**
 * Hash de idempotência `payload_hash_version = 1` (ADR-003 §2): SHA-256 do JSON canônico do
 * subconjunto de campos de negócio. Strings são comparadas byte a byte (sem trim nem case
 * folding); `money` já chega normalizado em escala 2; a referência ausente é omitida.
 */
export class CanonicalJsonSha256Hasher implements PayloadHasher {
  hash(payload: CanonicalPayload): PayloadHash {
    const business = {
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: { amount: payload.money.amount, currency: payload.money.currency },
      ...(payload.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: payload.referenceExternalTransactionId }),
    };
    const digest = createHash('sha256').update(canonicalJson(business), 'utf8').digest('hex');
    return { hash: digest, version: 1 };
  }
}
