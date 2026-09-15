import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExplorationQueryInputSchema } from '../src/exploration/index.js';
const versions = [
  { dataItemId: randomUUID(), versionId: randomUUID() },
  { dataItemId: randomUUID(), versionId: randomUUID() },
];
const businessQuery = {
  schemaVersion: 1,
  status: 'PENDING_REVIEW',
  revisionMode: 'current',
  filters: {
    kind: 'OBSERVATION',
    timeRole: 'OBSERVATION_TIME',
    from: '2019-06-01',
    to: '2019-06-30',
    includeUndated: false,
  },
};
it('expresses one business period across immutable source versions', () => {
  expect(
    ExplorationQueryInputSchema.safeParse({
      spec: { versions, businessQuery },
      view: 'resources',
    }).success,
  ).toBe(true);
});
it('rejects unbound business scopes and competing single-file conditions', () => {
  for (const spec of [
    { businessQuery },
    {
      versions,
      businessQuery,
      recordQuery: { assetId: randomUUID(), filters: [] },
    },
  ])
    expect(
      ExplorationQueryInputSchema.safeParse({ spec, view: 'resources' })
        .success,
    ).toBe(false);
});
it('retains exact source table columns for a month without treating the complete row as that month', () => {
  expect(
    ExplorationQueryInputSchema.safeParse({
      spec: {
        versions,
        businessQuery: {
          ...businessQuery,
          tableSelections: [
            {
              recordId: randomUUID(),
              assertionId: randomUUID(),
              field: 'c3',
              columns: [1, 2, 3],
              keepFields: ['c2', 'c3'],
            },
          ],
        },
      },
      view: 'resources',
    }).success,
  ).toBe(true);
});
it('rejects a viewport filter that would select records without equivalent business relation semantics', () => {
  expect(
    ExplorationQueryInputSchema.safeParse({
      spec: { versions, businessQuery, spatialBounds: [115, 39, 117, 41] },
      view: 'resources',
    }).success,
  ).toBe(false);
});
