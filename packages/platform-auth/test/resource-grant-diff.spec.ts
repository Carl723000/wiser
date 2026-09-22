import { expect, it } from 'vitest';
import {
  resourceGrantDiff,
  type ResourceGrantDiffInput,
} from '../src/resource-grant-diff.js';
const resource = {
  kind: 'version' as const,
  dataItemId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
};
const start = '2026-09-23T00:00:00Z',
  end = '2026-09-30T00:00:00Z';
const input: ResourceGrantDiffInput = {
  resources: [resource],
  actions: ['content.read', 'original.read'],
  startsAt: start,
  expiresAt: end,
  grants: [],
};
const window = (id: string, startsAt: string, expiresAt: string) => ({
  id,
  resources: [resource],
  actions: ['content.read' as const],
  startsAt,
  expiresAt,
});
it('counts resource-action pairs separately and does not remove existing permissions', () => {
  expect(resourceGrantDiff(input)).toEqual({
    added: 2,
    extended: 0,
    retained: 0,
    removed: 0,
    byAction: [
      { action: 'content.read', added: 1, extended: 0, retained: 0 },
      { action: 'original.read', added: 1, extended: 0, retained: 0 },
    ],
  });
});
it('unions adjacent windows without claiming a gap is covered', () => {
  const grants = [
    window('a', start, '2026-09-25T00:00:00Z'),
    window('b', '2026-09-25T00:00:00Z', end),
  ];
  expect(resourceGrantDiff({ ...input, grants })).toMatchObject({
    added: 1,
    extended: 0,
    retained: 1,
  });
  expect(
    resourceGrantDiff({
      ...input,
      grants: [grants[0]!, window('c', '2026-09-26T00:00:00Z', end)],
    }),
  ).toMatchObject({ added: 1, extended: 1, retained: 0 });
});
it('pins exact versions and ignores windows outside the proposed interval', () => {
  expect(
    resourceGrantDiff({
      ...input,
      grants: [
        {
          ...window('a', start, end),
          resources: [{ ...resource, versionId: resource.dataItemId }],
        },
        window('b', '2026-09-20T00:00:00Z', start),
        window('c', end, '2026-10-01T00:00:00Z'),
      ],
    }),
  ).toMatchObject({ added: 2, extended: 0, retained: 0 });
});
it('deduplicates overlapping rights, handles external sources and preserves caller order', () => {
  const external = {
    kind: 'external-source' as const,
    sourceId: 'permitted-directory',
  };
  expect(
    resourceGrantDiff({
      resources: [external],
      actions: ['external.directory'],
      startsAt: start,
      expiresAt: end,
      grants: [
        {
          id: 'a',
          resources: [external],
          actions: ['external.directory'],
          startsAt: start,
          expiresAt: end,
        },
        {
          id: 'b',
          resources: [external],
          actions: ['external.directory'],
          startsAt: start,
          expiresAt: end,
        },
      ],
    }),
  ).toMatchObject({ added: 0, extended: 0, retained: 1 });
});
it('rejects malformed intervals rather than describing invalid authority as absent', () => {
  expect(() => resourceGrantDiff({ ...input, startsAt: 'invalid' })).toThrow();
  expect(() => resourceGrantDiff({ ...input, expiresAt: start })).toThrow();
  expect(() =>
    resourceGrantDiff({ ...input, grants: [window('a', 'invalid', end)] }),
  ).toThrow();
});
