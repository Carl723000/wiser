import { expect, it } from 'vitest';
import type { ExplorationResult } from '@wiser/data-contracts';
import { loadBusinessMap } from './business-map';
const page = (after?: string) =>
  ({
    queryId: 'scope',
    view: 'map',
    totalCount: 2,
    features: [
      {
        id: after ? 'b' : 'a',
        geometry: { type: 'Point', coordinates: [116, 40] },
        properties: {},
      },
    ],
    ...(after ? {} : { nextCursor: 'next' }),
  }) as unknown as ExplorationResult;
it('loads the entire same-scope map before exposing features and preserves original coordinates', async () => {
  const first = page();
  const collection = await loadBusinessMap(first, () =>
    Promise.resolve(page('next')),
  );
  expect(collection.features).toHaveLength(2);
  expect(collection.features[0]?.geometry).not.toEqual(
    first.features?.[0]?.geometry,
  );
  expect(first.features?.[0]?.geometry.coordinates).toEqual([116, 40]);
});
it('rejects another scope or a repeated page instead of displaying a partial map', async () => {
  await expect(
    loadBusinessMap(page(), () =>
      Promise.resolve({
        ...page('next'),
        queryId: 'other',
      }),
    ),
  ).rejects.toThrow();
  await expect(
    loadBusinessMap(page(), () => Promise.resolve(page())),
  ).rejects.toThrow();
});
