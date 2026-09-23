import { expect, it } from 'vitest';
import { compileResourceAccessScope } from '../src/resource-access-scope.js';
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const resource = { kind: 'version', dataItemId: id(4), versionId: id(5) };
const grant = {
  id: id(6),
  tenantId: id(1),
  projectId: id(2),
  actorId: id(3),
  purpose: 'research',
  packageId: id(7),
  packageVersion: 1,
  presetId: id(8),
  presetVersion: 1,
  resources: [resource],
  actions: ['content.read'],
  startsAt: '2026-09-22T00:00:00Z',
  expiresAt: '2026-10-01T00:00:00Z',
  status: 'active',
};
const input = {
  mode: 'managed',
  tenantId: id(1),
  projectId: id(2),
  actorId: id(3),
  purpose: 'research',
  now: '2026-09-23T00:00:00Z',
  grants: [grant],
};
it('compiles fixed references per action without broadening sibling actions', () => {
  const scope = compileResourceAccessScope(input);
  expect(scope).toMatchObject({
    mode: 'managed',
    validUntil: grant.expiresAt,
    permissions: {
      'content.read': [resource],
      'original.read': [],
      'result.export': [],
      'external.directory': [],
      'source.discover': [],
    },
  });
});
it('deduplicates overlapping scopes and preserves unrelated live grants after local revocation', () => {
  const scope = compileResourceAccessScope({
    ...input,
    grants: [
      { ...grant, status: 'revoked' },
      { ...grant, id: id(9) },
      { ...grant, id: id(10) },
    ],
  });
  expect(
    scope?.mode === 'managed' && scope.permissions['content.read'],
  ).toEqual([resource]);
});
it('intersects delegated resources and actions with the delegator instead of inheriting all human rights', () => {
  const source = { kind: 'external-source', sourceId: 'public-directory' };
  const delegated = {
    ...input,
    grants: [
      {
        ...grant,
        resources: [resource, source],
        actions: ['content.read', 'original.read', 'external.directory'],
      },
    ],
    delegator: {
      actorId: id(11),
      grants: [
        {
          ...grant,
          actorId: id(11),
          resources: [resource],
          actions: ['content.read', 'result.export'],
          expiresAt: '2026-09-24T00:00:00Z',
        },
      ],
    },
  };
  expect(compileResourceAccessScope(delegated)).toMatchObject({
    mode: 'managed',
    validUntil: '2026-09-24T00:00:00Z',
    permissions: {
      'content.read': [resource],
      'original.read': [],
      'result.export': [],
      'external.directory': [],
    },
  });
  expect(
    compileResourceAccessScope({
      ...delegated,
      delegator: { actorId: id(11), grants: [] },
    }),
  ).toMatchObject({ permissions: { 'content.read': [] } });
});
it('ignores grants for other identities, projects and purposes and revalidates before future activation', () => {
  const start = '2026-09-25T00:00:00Z';
  const scope = compileResourceAccessScope({
    ...input,
    grants: [
      { ...grant, projectId: id(20) },
      { ...grant, id: id(21), purpose: 'teaching' },
      { ...grant, id: id(22), actorId: id(23) },
      { ...grant, id: id(24), startsAt: start },
    ],
  });
  expect(scope).toMatchObject({
    validUntil: start,
    permissions: { 'content.read': [] },
  });
});
it('rejects malformed or duplicate authority records rather than compiling a partial scope', () => {
  expect(
    compileResourceAccessScope({ ...input, grants: [grant, grant] }),
  ).toBeNull();
  expect(
    compileResourceAccessScope({ ...input, grants: [grant, { id: id(9) }] }),
  ).toBeNull();
  expect(compileResourceAccessScope({ ...input, mode: undefined })).toBeNull();
  expect(
    compileResourceAccessScope({ ...input, mode: 'legacy', grants: [] }),
  ).toEqual({ mode: 'legacy' });
});
