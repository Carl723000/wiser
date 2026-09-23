import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExplorationResultSchema } from '../src/index.js';

const basic = {
  queryId: randomUUID(),
  spec: {},
  createdAt: '2026-09-23T00:00:00Z',
  expiresAt: '2026-09-23T00:30:00Z',
  view: 'resources',
  totalCount: 2,
  resources: [],
  summary: {
    resourceCount: 2,
    analyzedResourceCount: 0,
    indexedRecordCount: 0,
    indexedFeatureCount: 0,
    records: [{ status: 'NOT_PARSED', count: 2 }],
    spatial: [{ status: 'NOT_PARSED', count: 2 }],
  },
};

it('accepts optional, explicitly scoped temporal and geometry coverage without pretending unknown review or actions are zero', () => {
  expect(
    ExplorationResultSchema.safeParse({
      ...basic,
      summary: {
        ...basic.summary,
        coverage: {
          temporal: { recordedVersionCount: 1, unknownVersionCount: 1 },
          geometry: { recordedVersionCount: 1, unknownVersionCount: 1 },
          approvedAssertionCount: null,
          effectiveActions: null,
        },
      },
    }).success,
  ).toBe(true);
  expect(ExplorationResultSchema.safeParse(basic).success).toBe(true);
});
