import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProviderIdentityMismatchError } from '../../src/application/errors.ts';
import type { ProviderIdentity } from '../../src/application/ports/identity.ts';
import { ProviderAuthGuard } from '../../src/interfaces/http/guards/provider-auth.guard.ts';
import type { HttpRequest } from '../../src/interfaces/http/http-types.ts';

describe('ProviderAuthGuard (ADR-006 §4)', () => {
  const run = async (identity: ProviderIdentity, request: Partial<HttpRequest>): Promise<boolean> => {
    const guard = new ProviderAuthGuard(new Reflector(), { resolve: () => Promise.resolve(identity) });
    const context = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, query: {}, ...request }) }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  };
  const verified: ProviderIdentity = { providerId: 'provider-a', authenticated: true, scopes: [] };

  test('unauthenticated (no-op) identity never restricts', async () => {
    const anon: ProviderIdentity = { providerId: undefined, authenticated: false, scopes: ['*'] };
    expect(await run(anon, { params: { providerId: 'provider-b' } })).toBe(true);
  });
  test('verified identity may touch its own provider (route or body)', async () => {
    expect(await run(verified, { params: { providerId: 'provider-a' } })).toBe(true);
    expect(await run(verified, { body: { providerId: 'provider-a' } })).toBe(true);
  });
  test('verified identity cannot use another provider in route or body', async () => {
    await expect(run(verified, { params: { providerId: 'provider-b' } })).rejects.toBeInstanceOf(
      ProviderIdentityMismatchError,
    );
    await expect(run(verified, { body: { providerId: 'provider-b' } })).rejects.toBeInstanceOf(
      ProviderIdentityMismatchError,
    );
  });
});
