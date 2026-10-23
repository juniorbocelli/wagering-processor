import { describe, expect, it } from 'bun:test';
import { loadOpenApiSpec } from '../../src/interfaces/http/controllers/docs.controller.ts';

describe('OpenAPI 3.1 Spec Parity', () => {
  it('loads valid OpenAPI spec containing all HTTP endpoints', () => {
    const spec = loadOpenApiSpec();
    expect(spec['openapi']).toMatch(/^3\.1\./);
    expect(spec['info']).toBeDefined();

    const paths = Object.keys((spec['paths'] ?? {}) as Record<string, unknown>);
    const expectedEndpoints = [
      '/wagering/transactions',
      '/wagering/transactions/{transactionId}',
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
      '/wallets',
      '/wallets/{walletId}',
      '/wallets/{walletId}/ledger',
      '/wallets/{walletId}/reconciliation',
      '/health/live',
      '/health/ready',
      '/metrics',
    ];

    for (const endpoint of expectedEndpoints) {
      expect(paths).toContain(endpoint);
    }
  });
});
