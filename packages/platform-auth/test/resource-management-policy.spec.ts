import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { assertResourceManagementPolicy } from '../src/resource-management-policy.js';
import type { PlatformRequestContext } from '@wiser/platform-contracts';
const tenantId = randomUUID(),
  projectId = randomUUID(),
  actorId = randomUUID();
const resource = {
  kind: 'version' as const,
  dataItemId: randomUUID(),
  versionId: randomUUID(),
};
const now = '2026-09-23T00:00:00Z';
const policy = {
  id: randomUUID(),
  version: 1,
  tenantId,
  projectId,
  resource,
  allowedActions: ['content.read'],
  managementRoles: ['steward'],
  licenseBasis: 'Independent source license',
  status: 'active',
  startsAt: '2026-09-22T00:00:00Z',
  expiresAt: '2026-10-01T00:00:00Z',
  maxGrantDays: 3,
};
const authority = {
  mode: 'managed',
  tenantId,
  projectId,
  actorId,
  purpose: 'web-console',
  now,
  revision: 1,
  grants: [],
  limits: [policy],
};
const context: PlatformRequestContext = {
  principal: {
    actorType: 'human',
    actorId,
    authUserId: actorId,
    sessionId: randomUUID(),
    authenticationMethod: 'supabase_jwt',
  },
  authorization: {
    tenantId,
    projectId,
    purpose: 'web-console',
    roles: ['steward'],
    scopes: ['platform.membership.manage'],
    maxSecurityLevel: 'L0_PUBLIC',
    authzVersion: 1,
  },
  traceId: 'c'.repeat(32),
};
function session(snapshot: unknown = authority, ctx = context) {
  return {
    context: ctx,
    client: {
      release() {},
      query: <Row>() =>
        Promise.resolve({ rows: [{ snapshot }] as Row[], rowCount: 1 }),
    },
  };
}
it('allows source management without assigning the manager any personal reading grant', async () => {
  await expect(
    assertResourceManagementPolicy(session(), [resource], ['content.read']),
  ).resolves.toBeUndefined();
  await expect(
    assertResourceManagementPolicy(session(), [resource], ['content.read'], {
      startsAt: now,
      expiresAt: '2026-09-24T00:00:00Z',
    }),
  ).resolves.toBeUndefined();
  expect(context.authorization.scopes).not.toContain('data.catalog.read');
  expect(authority.grants).toEqual([]);
});
it('rejects missing, cross-subject and legacy snapshots for management operations', async () => {
  for (const snapshot of [
    null,
    {},
    { ...authority, mode: 'legacy' },
    { ...authority, tenantId: randomUUID() },
    { ...authority, projectId: randomUUID() },
    { ...authority, actorId: randomUUID() },
    { ...authority, purpose: 'research' },
    { ...authority, limits: undefined },
  ])
    await expect(
      assertResourceManagementPolicy(
        session(snapshot),
        [resource],
        ['content.read'],
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
});
it('does not turn an operator role, visible data or a declared action into source permission', async () => {
  for (const limits of [
    [],
    [{ ...policy, status: 'revoked' }],
    [{ ...policy, startsAt: '2026-09-24T00:00:00Z' }],
    [{ ...policy, expiresAt: now }],
    [{ ...policy, managementRoles: ['other'] }],
    [{ ...policy, allowedActions: ['source.discover'] }],
    [{ ...policy, resource: { ...resource, versionId: randomUUID() } }],
  ])
    await expect(
      assertResourceManagementPolicy(
        session({ ...authority, limits }),
        [resource],
        ['content.read'],
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  await expect(
    assertResourceManagementPolicy(
      session(authority, {
        ...context,
        authorization: {
          ...context.authorization,
          scopes: ['data.catalog.read'],
        },
      }),
      [resource],
      ['content.read'],
    ),
  ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
});
it('rejects a proposed term exceeding the source limit even though the source remains current', async () => {
  await expect(
    assertResourceManagementPolicy(session(), [resource], ['content.read'], {
      startsAt: now,
      expiresAt: '2026-09-29T00:00:00Z',
    }),
  ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
});
