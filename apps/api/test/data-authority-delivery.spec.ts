import { describe, expect, it } from 'vitest';
import type { PlatformRequestContext } from '@wiser/platform-contracts';
import { sameDeliveryAuthority } from '../src/data-foundation/authority-delivery.js';
const context: PlatformRequestContext = {
  principal: {
    actorType: 'human',
    actorId: 'a1000000-0000-4000-8000-000000000001',
    authUserId: 'a1000000-0000-4000-8000-000000000001',
    sessionId: 'a1000000-0000-4000-8000-000000000002',
    authenticationMethod: 'supabase_jwt',
  },
  authorization: {
    tenantId: 'a1000000-0000-4000-8000-000000000003',
    projectId: 'a1000000-0000-4000-8000-000000000004',
    purpose: 'test',
    roles: ['data-reader'],
    scopes: ['data.catalog.read'],
    authzVersion: 1,
    maxSecurityLevel: 'L1_INTERNAL',
  },
  traceId: 'a'.repeat(32),
};
function managed() {
  const copy = structuredClone(context);
  copy.authorization.resourceAccess = {
    revision: 1,
    fingerprint: 'a'.repeat(64),
    scope: {
      mode: 'managed',
      validUntil: '2099-01-01T00:00:00Z',
      permissions: {
        'content.read': [],
        'source.discover': [],
        'original.read': [],
        'result.export': [],
        'external.directory': [],
      },
    },
  };
  return copy;
}
describe('response authority comparison', () => {
  it('accepts a fresh identical authority and ignores request trace changes', () =>
    expect(
      sameDeliveryAuthority(context, { ...context, traceId: 'b'.repeat(32) }),
    ).toBe(true));
  it('rejects failed authority resolution and legacy-to-managed activation', () => {
    expect(sameDeliveryAuthority(context, null)).toBe(false);
    expect(sameDeliveryAuthority(context, managed())).toBe(false);
  });
  it('rejects a resource revocation even without a membership revision change', () => {
    const before = managed(),
      after = managed();
    after.authorization.resourceAccess!.revision = 2;
    after.authorization.resourceAccess!.fingerprint = 'b'.repeat(64);
    expect(sameDeliveryAuthority(before, after)).toBe(false);
  });
  it('rejects an expired scope even when both snapshots otherwise match', () => {
    const expired = managed();
    if (expired.authorization.resourceAccess?.scope.mode !== 'managed')
      throw Error('test');
    expired.authorization.resourceAccess.scope.validUntil =
      '2000-01-01T00:00:00Z';
    expect(sameDeliveryAuthority(expired, expired)).toBe(false);
  });
  it('rejects changes of actor, purpose and effective action scope', () => {
    for (const after of [
      {
        ...context,
        principal: {
          ...context.principal,
          actorId: 'a1000000-0000-4000-8000-000000000005',
        },
      },
      {
        ...context,
        authorization: { ...context.authorization, purpose: 'other' },
      },
      { ...context, authorization: { ...context.authorization, scopes: [] } },
    ])
      expect(sameDeliveryAuthority(context, after)).toBe(false);
  });
});
