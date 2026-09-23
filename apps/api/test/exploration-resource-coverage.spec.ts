import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { loadExplorationResourceCoverage } from '../src/data-foundation/exploration-resource-coverage.js';

it('counts the entire fixed version set through bound SQL and treats unavailable review and actions as unknown', async () => {
  const refs = [
    { dataItemId: randomUUID(), versionId: randomUUID() },
    { dataItemId: randomUUID(), versionId: randomUUID() },
  ];
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        resource_count: 2,
        temporal_count: 1,
        geometry_count: 1,
      },
    ],
  });
  const coverage = await loadExplorationResourceCoverage({ query }, refs);
  expect(coverage).toEqual({
    temporal: { recordedVersionCount: 1, unknownVersionCount: 1 },
    geometry: { recordedVersionCount: 1, unknownVersionCount: 1 },
    approvedAssertionCount: null,
    effectiveActions: null,
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[1]).toEqual([JSON.stringify(refs)]);
  expect(query.mock.calls[0]?.[0]).toContain('catalog.temporal_extent');
  expect(query.mock.calls[0]?.[0]).toContain('catalog.spatial_extent');
});

it('rejects an incomplete or inconsistent database result instead of returning a partial total', async () => {
  const refs = [{ dataItemId: randomUUID(), versionId: randomUUID() }];
  const query = vi.fn().mockResolvedValue({
    rows: [{ resource_count: 1, temporal_count: 2, geometry_count: 0 }],
  });
  await expect(
    loadExplorationResourceCoverage({ query }, refs),
  ).rejects.toThrow();
});
