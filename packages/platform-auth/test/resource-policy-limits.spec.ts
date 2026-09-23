import { expect, it } from 'vitest';
import { compileResourceAccessScope } from '../src/resource-access-scope.js';
import { canAdministerResources } from '../src/resource-policy-limits.js';
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ref = { kind: 'version', dataItemId: id(4), versionId: id(5) };
const now = '2026-09-23T00:00:00Z',
  end = '2026-09-25T00:00:00Z';
const limit = {
  id: id(6),
  version: 1,
  tenantId: id(1),
  projectId: id(2),
  resource: ref,
  allowedActions: ['content.read'],
  managementRoles: ['resource-steward'],
  licenseBasis: 'Verified distribution permission',
  status: 'active',
  startsAt: '2026-09-22T00:00:00Z',
  expiresAt: '2026-09-26T00:00:00Z',
  maxGrantDays: 3,
};
const grant = {
  id: id(7),
  tenantId: id(1),
  projectId: id(2),
  actorId: id(3),
  purpose: 'web-console',
  packageId: id(8),
  packageVersion: 1,
  presetId: id(9),
  presetVersion: 1,
  resources: [ref],
  actions: ['content.read', 'original.read'],
  startsAt: now,
  expiresAt: '2026-10-01T00:00:00Z',
  status: 'active',
};
const scope = {
  mode: 'managed',
  tenantId: id(1),
  projectId: id(2),
  actorId: id(3),
  purpose: 'web-console',
  now,
  grants: [grant],
  limits: [limit],
};
const management = {
  tenantId: id(1),
  projectId: id(2),
  baseAllowed: true,
  roles: ['resource-steward'],
  now,
  startsAt: now,
  expiresAt: end,
  resources: [ref],
  actions: ['content.read'],
  limits: [limit],
};
it('caps each granted action by the registered resource license and uses its expiry as a recheck deadline', () => {
  expect(compileResourceAccessScope(scope)).toMatchObject({
    permissions: { 'content.read': [ref], 'original.read': [] },
    validUntil: limit.expiresAt,
  });
});
it('does not silently restore broad grants when a current license is absent or revoked', () => {
  for (const limits of [
    [],
    [{ ...limit, status: 'revoked' }],
    [{ ...limit, projectId: id(99) }],
    [{ ...limit, tenantId: id(99) }],
    [{ ...limit, expiresAt: now }],
    [{ ...limit, startsAt: end }],
  ])
    expect(compileResourceAccessScope({ ...scope, limits })).toMatchObject({
      permissions: { 'content.read': [], 'original.read': [] },
    });
});
it('retains independent resources while rejecting an unlicensed version and discovery field scope', () => {
  const another = { ...ref, versionId: id(10) };
  expect(
    compileResourceAccessScope({
      ...scope,
      grants: [
        {
          ...grant,
          resources: [ref, another],
          actions: ['content.read', 'source.discover'],
        },
      ],
    }),
  ).toMatchObject({
    permissions: { 'content.read': [ref], 'source.discover': [] },
  });
});
it('intersects provider license limits with both delegated and delegator grants', () => {
  expect(
    compileResourceAccessScope({
      ...scope,
      delegator: {
        actorId: id(11),
        grants: [{ ...grant, actorId: id(11), actions: ['original.read'] }],
      },
    }),
  ).toMatchObject({ permissions: { 'content.read': [], 'original.read': [] } });
});
it('requires a distinct management role and base project authority; reading alone grants no distribution power', () => {
  expect(canAdministerResources(management)).toBe(true);
  for (const input of [
    { ...management, roles: ['reader'] },
    { ...management, baseAllowed: false },
    { ...management, limits: [] },
    { ...management, projectId: id(99) },
    { ...management, tenantId: id(99) },
  ])
    expect(canAdministerResources(input)).toBe(false);
});
it('bounds proposed grant actions and duration by every source license', () => {
  for (const input of [
    { ...management, actions: ['original.read'] },
    { ...management, expiresAt: '2026-10-01T00:00:00Z' },
    { ...management, expiresAt: '2026-09-26T12:00:00Z' },
    { ...management, resources: [{ ...ref, versionId: id(10) }] },
    { ...management, startsAt: end, expiresAt: now },
    { ...management, limits: [{ ...limit, status: 'revoked' }] },
    { ...management, limits: [{ ...limit, startsAt: end }] },
  ])
    expect(canAdministerResources(input)).toBe(false);
  expect(
    canAdministerResources({ ...management, expiresAt: limit.expiresAt }),
  ).toBe(true);
});
it('fails closed for duplicate, malformed or oversized policy snapshots', () => {
  for (const limits of [
    [limit, limit],
    [{ ...limit, allowedActions: ['made-up'] }],
    [{ ...limit, managementRoles: [] }],
    Array(10001).fill(limit),
  ]) {
    expect(compileResourceAccessScope({ ...scope, limits })).toBeNull();
    expect(canAdministerResources({ ...management, limits })).toBe(false);
  }
});
