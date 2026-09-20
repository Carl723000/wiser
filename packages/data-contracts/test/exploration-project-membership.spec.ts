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
  expect(DATA_CAPABILITY_REGISTRY['data.explore.query'].version).toBe('1.14.0');
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

const mixed = {
  ...businessQuery,
  schemaVersion: 2,
  status: 'APPROVED_AND_PENDING',
};
it('accepts mixed review scope only in the new query contract, preserving authority statuses', () => {
  expect(
    ExplorationQueryInputSchema.safeParse({
      spec: { scope: 'project', businessQuery: mixed },
      view: 'resources',
    }).success,
  ).toBe(true);
  for (const version of ['1.12.0', '1.13.0']) {
    const prior = DATA_CAPABILITY_ARCHIVE['data.explore.query']?.find(
      (e) => e.version === version,
    );
    expect(prior).toBeDefined();
    expect(
      prior?.inputSchema.safeParse({
        spec: {
          versions: [{ dataItemId: randomUUID(), versionId: randomUUID() }],
          businessQuery: mixed,
        },
        view: 'resources',
      }).success,
    ).toBe(false);
  }
  expect(
    ExplorationQueryInputSchema.safeParse({
      spec: { scope: 'project', businessQuery: { ...mixed, schemaVersion: 1 } },
      view: 'resources',
    }).success,
  ).toBe(false);
  expect(
    ExplorationQueryInputSchema.safeParse({
      spec: {
        scope: 'project',
        businessQuery: { ...mixed, status: 'REJECTED' },
      },
      view: 'resources',
    }).success,
  ).toBe(false);
});
it('accepts mixed relation paging only by query id and never as an assertion review decision', () => {
  const latest = DATA_CAPABILITY_REGISTRY['data.knowledge.relations.list'];
  expect(latest.version).toBe('1.6.0');
  expect(
    latest.inputSchema.safeParse({
      queryId: randomUUID(),
      status: mixed.status,
    }).success,
  ).toBe(true);
  expect(
    latest.inputSchema.safeParse({
      dataItemId: randomUUID(),
      versionId: randomUUID(),
      status: mixed.status,
    }).success,
  ).toBe(false);
  for (const version of ['1.4.0', '1.5.0']) {
    const prior = DATA_CAPABILITY_ARCHIVE[
      'data.knowledge.relations.list'
    ]?.find((e) => e.version === version);
    expect(prior).toBeDefined();
    expect(
      prior?.inputSchema.safeParse({
        queryId: randomUUID(),
        status: mixed.status,
      }).success,
    ).toBe(false);
  }
  expect(
    DATA_CAPABILITY_REGISTRY[
      'data.knowledge.relations.review'
    ].inputSchema.safeParse({
      assertionId: randomUUID(),
      expectedVersion: 1,
      decision: mixed.status,
      rationale: 'Do not promote candidates',
    }).success,
  ).toBe(false);
});
it('keeps pre-mixed saved-open and export output discovery frozen', () => {
  const mixedResult = {
    ...result,
    spec: { scope: 'project', businessQuery: mixed },
  };
  const request = { queryId: result.queryId, view: 'resources', first: 25 };
  for (const [capability, version] of [
    ['data.explore.view.open', '1.3.0'],
    ['data.explore.export', '1.2.0'],
  ] as const) {
    const envelope =
      capability === 'data.explore.view.open'
        ? {
            result: mixedResult,
            savedView: {
              viewId: randomUUID(),
              title: 'Mixed project',
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
            result: mixedResult,
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
    const archived = DATA_CAPABILITY_ARCHIVE[capability]?.find(
      (e) => e.version === version,
    );
    expect(archived).toBeDefined();
    expect(archived?.outputSchema.safeParse(envelope).success).toBe(false);
  }
});
