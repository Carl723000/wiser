import { expect, it, vi } from 'vitest';
import { ResourceScopedPrincipalResolver } from '../src/resource-scoped-principal-resolver.js';
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = {
  principal: {
    actorId: id(1),
    actorType: 'human' as const,
    authUserId: id(1),
    authenticationMethod: 'supabase_jwt' as const,
    sessionId: id(2),
  },
  authorization: {
    tenantId: id(3),
    projectId: id(4),
    roles: ['data-reader'],
    scopes: ['data.catalog.read'],
    purpose: 'research',
    maxSecurityLevel: 'L0_PUBLIC' as const,
    authzVersion: 3,
  },
  traceId: 'a'.repeat(32),
};
const input = {
  token: 'test-token',
  tenantId: id(3),
  projectId: id(4),
  purpose: 'research',
  traceId: context.traceId,
};
const resource = { kind: 'version', dataItemId: id(5), versionId: id(6) };
const grant = {
  id: id(7),
  tenantId: id(3),
  projectId: id(4),
  actorId: id(1),
  purpose: 'research',
  packageId: id(8),
  packageVersion: 1,
  presetId: id(9),
  presetVersion: 1,
  resources: [resource],
  actions: ['content.read'],
  startsAt: '2026-09-22T00:00:00Z',
  expiresAt: '2026-09-25T00:00:00Z',
  status: 'active',
};
const snapshot = {
  mode: 'managed',
  tenantId: id(3),
  projectId: id(4),
  actorId: id(1),
  purpose: 'research',
  now: '2026-09-23T00:00:00Z',
  revision: 1,
  grants: [grant],
};
it('preserves explicit legacy context without silently activating new restrictions', async () => {
  const resolver = new ResourceScopedPrincipalResolver({
    base: { resolve: vi.fn().mockResolvedValue(context) },
    load: vi
      .fn()
      .mockResolvedValue({ ...snapshot, mode: 'legacy', grants: [] }),
  });
  expect(await resolver.resolve(input)).toEqual(context);
});
it('loads live authority for each verified request and changes fingerprint on revocation', async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, revision: 2, grants: [] });
  const resolver = new ResourceScopedPrincipalResolver({
    base: { resolve: vi.fn().mockResolvedValue(context) },
    load,
  });
  const first = await resolver.resolve(input),
    second = await resolver.resolve(input);
  expect(first?.authorization).toMatchObject({
    resourceAccess: {
      revision: 1,
      scope: { mode: 'managed', permissions: { 'content.read': [resource] } },
    },
  });
  expect(second?.authorization).toMatchObject({
    resourceAccess: {
      revision: 2,
      scope: { permissions: { 'content.read': [] } },
    },
  });
  const a = first?.authorization as Record<string, unknown>;
  const b = second?.authorization as Record<string, unknown>;
  expect((a.resourceAccess as { fingerprint: string }).fingerprint).not.toEqual(
    (b.resourceAccess as { fingerprint: string }).fingerprint,
  );
  expect(load).toHaveBeenCalledTimes(2);
});
it('binds authority to exact verified subject, project and purpose', async () => {
  for (const mismatch of [
    { actorId: id(20) },
    { tenantId: id(20) },
    { projectId: id(20) },
    { purpose: 'teaching' },
  ]) {
    const resolver = new ResourceScopedPrincipalResolver({
      base: { resolve: vi.fn().mockResolvedValue(context) },
      load: vi.fn().mockResolvedValue({ ...snapshot, ...mismatch }),
    });
    expect(await resolver.resolve(input)).toBeNull();
  }
});
it('never loads grants for an unverified session and fails closed on unavailable or malformed authority', async () => {
  const load = vi.fn();
  expect(
    await new ResourceScopedPrincipalResolver({
      base: { resolve: vi.fn().mockResolvedValue(null) },
      load,
    }).resolve(input),
  ).toBeNull();
  expect(load).not.toHaveBeenCalled();
  for (const loader of [
    vi.fn().mockRejectedValue(new Error('unavailable')),
    vi.fn().mockResolvedValue({ ...snapshot, mode: undefined }),
    vi.fn().mockResolvedValue({ ...snapshot, revision: -1 }),
  ]) {
    expect(
      await new ResourceScopedPrincipalResolver({
        base: { resolve: vi.fn().mockResolvedValue(context) },
        load: loader,
      }).resolve(input),
    ).toBeNull();
  }
});
it('changes a cached permission fingerprint at expiry even when authority revision has not changed', async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, now: grant.expiresAt });
  const resolver = new ResourceScopedPrincipalResolver({
    base: { resolve: vi.fn().mockResolvedValue(context) },
    load,
  });
  const first = await resolver.resolve(input),
    expired = await resolver.resolve(input);
  expect(first).not.toBeNull();
  expect(expired?.authorization).toMatchObject({
    resourceAccess: { scope: { permissions: { 'content.read': [] } } },
  });
  expect(expired?.authorization).not.toEqual(first?.authorization);
});
it('requires the authority delegator to match the verified credential owner', async () => {
  const delegatedContext = {
    ...context,
    principal: {
      actorId: id(1),
      actorType: 'agent' as const,
      authenticationMethod: 'delegated_credential' as const,
      credentialId: id(30),
      delegationId: id(31),
      delegatedBy: id(32),
    },
  };
  const valid = {
    ...snapshot,
    delegator: { actorId: id(32), grants: [{ ...grant, actorId: id(32) }] },
  };
  const load = vi
    .fn()
    .mockResolvedValueOnce(valid)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({
      ...valid,
      delegator: { ...valid.delegator, actorId: id(33) },
    });
  const resolver = new ResourceScopedPrincipalResolver({
    base: { resolve: vi.fn().mockResolvedValue(delegatedContext) },
    load,
  });
  expect(await resolver.resolve(input)).not.toBeNull();
  expect(await resolver.resolve(input)).toBeNull();
  expect(await resolver.resolve(input)).toBeNull();
});
it('changes the response fingerprint when the trusted source license removes access even if the grant is unchanged', async () => {
  const limit = {
    id: id(30),
    version: 1,
    tenantId: id(3),
    projectId: id(4),
    resource,
    allowedActions: ['content.read'],
    managementRoles: ['resource-steward'],
    licenseBasis: 'Verified public research source',
    status: 'active',
    startsAt: grant.startsAt,
    expiresAt: grant.expiresAt,
    maxGrantDays: 30,
  };
  const load = vi
    .fn()
    .mockResolvedValueOnce({ ...snapshot, limits: [limit] })
    .mockResolvedValueOnce({ ...snapshot, limits: [] });
  const resolver = new ResourceScopedPrincipalResolver({
    base: { resolve: () => Promise.resolve(context) },
    load,
  });
  const first = await resolver.resolve(input),
    second = await resolver.resolve(input);
  expect(first?.authorization.resourceAccess?.scope).toMatchObject({
    permissions: { 'content.read': [resource] },
  });
  expect(second?.authorization.resourceAccess?.scope).toMatchObject({
    permissions: { 'content.read': [] },
  });
  expect(first?.authorization.resourceAccess?.fingerprint).not.toBe(
    second?.authorization.resourceAccess?.fingerprint,
  );
});
