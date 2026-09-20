import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DATA_CAPABILITY_ARCHIVE,
  DATA_CAPABILITY_REGISTRY,
  ExplorationQueryInputSchema,
  ExplorationResultSchema,
} from '../src/index.js';

const businessQuery = {
  schemaVersion: 1,
  status: 'PENDING_REVIEW',
  revisionMode: 'all',
  filters: {
    kind: 'ALL',
    timeRole: 'ALL',
    from: null,
    to: null,
    includeUndated: true,
  },
};
const spec = { scope: 'project', businessQuery };
const result = {
  queryId: randomUUID(),
  spec,
  createdAt: '2026-09-20T01:00:00Z',
  expiresAt: '2026-09-20T01:30:00Z',
  view: 'resources',
  totalCount: 299,
  resources: [],
  membership: { complete: true, versionCount: 299, assertionCount: 2033 },
};

it('accepts explicit server-owned project membership without inline version or assertion arrays', () => {
  expect(
    ExplorationQueryInputSchema.safeParse({ spec, view: 'resources' }).success,
  ).toBe(true);
  expect(ExplorationResultSchema.safeParse(result).success).toBe(true);
  expect(DATA_CAPABILITY_REGISTRY['data.explore.query'].version).toBe('1.13.0');
});

it('rejects caller-owned membership, missing business conditions and incomplete project counts', () => {
  for (const invalid of [
    { scope: 'project' },
    {
      ...spec,
      versions: [{ dataItemId: randomUUID(), versionId: randomUUID() }],
    },
    { ...spec, businessQuery: { ...businessQuery, assertionPins: [] } },
    { ...spec, spatialBounds: [115, 39, 117, 41] },
  ])
    expect(
      ExplorationQueryInputSchema.safeParse({
        spec: invalid,
        view: 'resources',
      }).success,
    ).toBe(false);
  const { membership: _membership, ...withoutCounts } = result;
  expect(ExplorationResultSchema.safeParse(withoutCounts).success).toBe(false);
  expect(
    ExplorationResultSchema.safeParse({
      ...result,
      membership: { ...result.membership, complete: false },
    }).success,
  ).toBe(false);
});

it('freezes prior discovery contracts for query, saved-open and export while preserving old fixed-version inputs', () => {
  const legacy = {
    spec: {
      versions: [{ dataItemId: randomUUID(), versionId: randomUUID() }],
      businessQuery,
    },
    view: 'resources',
  };
  const prior = DATA_CAPABILITY_ARCHIVE['data.explore.query']?.find(
    (entry) => entry.version === '1.12.0',
  );
  expect(prior).toBeDefined();
  expect(prior?.inputSchema.safeParse(legacy).success).toBe(true);
  expect(
    prior?.inputSchema.safeParse({ spec, view: 'resources' }).success,
  ).toBe(false);
  expect(ExplorationQueryInputSchema.safeParse(legacy).success).toBe(true);
  for (const [capability, version] of [
    ['data.explore.view.open', '1.2.0'],
    ['data.explore.export', '1.1.0'],
  ] as const) {
    const archived = DATA_CAPABILITY_ARCHIVE[capability]?.find(
      (entry) => entry.version === version,
    );
    expect(archived).toBeDefined();
    const schema = archived?.outputSchema;
    const request = { queryId: result.queryId, view: 'resources', first: 25 };
    const envelope =
      capability === 'data.explore.view.open'
        ? {
            result,
            savedView: {
              viewId: randomUUID(),
              title: 'Project',
              visibility: 'private',
              createdAt: result.createdAt,
              revokedAt: null,
            },
            viewSpec: {
              activeView: 'resources',
              requests: { resources: request },
            },
          }
        : {
            result,
            request,
            exportedAt: result.createdAt,
            coverage: {
              unit: 'resources',
              returnedCount: 0,
              totalCount: 299,
              complete: false,
            },
          };
    expect(
      DATA_CAPABILITY_REGISTRY[capability].outputSchema.safeParse(envelope)
        .success,
    ).toBe(true);
    expect(schema?.safeParse(envelope).success).toBe(false);
  }
});
