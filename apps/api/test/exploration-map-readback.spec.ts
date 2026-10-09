import { describe, expect, it } from 'vitest';
import { queryAnalysisView } from '../src/data-foundation/exploration-views.js';
import type { QueryAdapterPgClient } from '../src/data-foundation/query-adapters.js';

const id = (n: number) =>
  `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const refs = [{ dataItemId: id(1), versionId: id(2), analysisId: id(3) }];
const point = { type: 'Point', coordinates: [12.123456789, 21.123456789] };
const nested = {
  type: 'GeometryCollection',
  geometries: [
    point,
    {
      type: 'GeometryCollection',
      geometries: [
        point,
        {
          type: 'MultiPoint',
          coordinates: [
            [11, 20],
            [11, 20],
          ],
        },
      ],
    },
  ],
};
const rows = [nested, point].map((geometry, index) => ({
  data_item_id: id(1),
  version_id: id(2),
  analysis_id: id(3),
  asset_id: id(5),
  record_id: id(11 + index),
  record_index: index,
  source_id: `synthetic:${index}`,
  record_values: { raw: '0001' },
  geometry,
}));
function client(failure?: Error) {
  const pages: { sql: string; values: readonly unknown[] }[] = [];
  const pg: QueryAdapterPgClient = {
    query: (sql, values = []) => {
      if (sql.includes('with coverage as'))
        return Promise.resolve({
          rows: [{ total: '2', mercator_count: '2', bounds: [11, 20, 13, 22] }],
        });
      if (sql.startsWith('select record.*,ref')) {
        pages.push({ sql, values });
        if (failure) return Promise.reject(failure);
        return Promise.resolve({
          rows: rows.slice(
            Number(values[9]),
            Number(values[9]) + Number(values[8]),
          ),
        });
      }
      if (sql.includes('sum(record_count)'))
        return Promise.resolve({ rows: [{ records: '2', features: '2' }] });
      throw new Error('Unexpected map read');
    },
    release: () => {
      throw new Error('Map reader does not own the transaction');
    },
  };
  return { pg, pages };
}

describe('exploration map readback', () => {
  it('normalizes the recursive working type while retaining the typed record source', async () => {
    const { pg, pages } = client();
    await queryAnalysisView(
      pg,
      refs,
      id(4),
      { queryId: id(4), view: 'map', first: 1 },
      {},
    );
    // The native geometry(Geometry,4326) counterexample fails before row
    // evaluation unless the seed agrees with ST_GeometryN's generic type.
    expect(pages[0]?.sql).toContain('SELECT record.geom::geometry AS geom');
    expect(pages[0]?.sql).toContain('ELSE st_asgeojson(record.geom)');
  });

  it('wires nested readback while retaining fixed map filters and pagination', async () => {
    const { pg, pages } = client();
    const bbox: [number, number, number, number] = [11, 20, 13, 22];
    await queryAnalysisView(
      pg,
      refs,
      id(4),
      { queryId: id(4), view: 'map', first: 1, bbox },
      {},
    );
    expect(pages).toHaveLength(1);
    // Actual PostGIS serialization is covered by the native captured-SQL case.
    // This checks that this production reader uses the compatible expression.
    expect(pages[0]?.sql).toContain('WITH RECURSIVE');
    expect(pages[0]?.sql).toContain('ELSE st_asgeojson(record.geom)');
    expect(pages[0]?.sql).toContain('ST_AsGeoJSON(geom,9,0)');
    expect(pages[0]?.sql).toContain('from catalog.analysis_record record');
    expect(pages[0]?.sql).toContain('order by ref');
    expect(pages[0]?.values).toEqual([
      JSON.stringify(refs),
      null,
      null,
      true,
      bbox,
      null,
      null,
      null,
      2,
      0,
    ]);
  });

  it('preserves whole nested records and advances the existing bound cursor', async () => {
    const { pg, pages } = client();
    const first = await queryAnalysisView(
      pg,
      refs,
      id(4),
      { queryId: id(4), view: 'map', first: 1 },
      {},
    );
    if (!('features' in first)) throw new Error('Expected map features');
    expect(first.features[0]).toEqual({
      type: 'Feature',
      id: id(11),
      geometry: nested,
      properties: {
        recordId: id(11),
        featureId: id(11),
        dataItemId: id(1),
        versionId: id(2),
        analysisId: id(3),
        assetId: id(5),
        sourceId: 'synthetic:0',
        index: 0,
        values: { raw: '0001' },
      },
    });
    expect(first.nextCursor).toBeTypeOf('string');
    const next = await queryAnalysisView(
      pg,
      refs,
      id(4),
      { queryId: id(4), view: 'map', first: 1, after: first.nextCursor! },
      {},
    );
    if (!('features' in next)) throw new Error('Expected map features');
    expect(next.features.map((feature) => feature.id)).toEqual([id(12)]);
    expect(next.nextCursor).toBeUndefined();
    expect(pages[1]?.values.slice(8)).toEqual([2, 1]);
    await expect(
      queryAnalysisView(
        pg,
        refs,
        id(4),
        {
          queryId: id(4),
          view: 'map',
          first: 1,
          after: first.nextCursor!,
          bbox: [10, 19, 14, 23],
        },
        {},
      ),
    ).rejects.toThrow();
    expect(pages).toHaveLength(2);
  });

  it('propagates a failed map read without returning a partial feature page', async () => {
    const error = new Error('synthetic database failure');
    const { pg, pages } = client(error);
    await expect(
      queryAnalysisView(
        pg,
        refs,
        id(4),
        { queryId: id(4), view: 'map', first: 1 },
        {},
      ),
    ).rejects.toBe(error);
    expect(pages).toHaveLength(1);
  });
});
