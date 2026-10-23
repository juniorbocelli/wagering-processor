import { describe, expect, it } from 'bun:test';
import { loadOpenApiSpec } from '../../src/interfaces/http/controllers/docs.controller.ts';
import { FAILURE_CODES } from '../../src/domain/wagering/failure-code.ts';

describe('OpenAPI 3.1 Spec Parity', () => {
  it('loads valid OpenAPI spec containing all HTTP endpoints and matching FailureCode catalog', () => {
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
      '/docs',
      '/docs/openapi.json',
      '/console',
    ];

    for (const endpoint of expectedEndpoints) {
      expect(paths).toContain(endpoint);
    }

    const components = spec['components'] as { schemas?: Record<string, { enum?: string[] }> } | undefined;
    const specFailureCodes = components?.schemas?.['FailureCode']?.enum ?? [];
    expect([...specFailureCodes].sort()).toEqual([...FAILURE_CODES].sort());
  });
});
