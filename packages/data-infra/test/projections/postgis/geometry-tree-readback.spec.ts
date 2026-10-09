import { describe, expect, it } from 'vitest';
import { rebuildPostgisGeometryTree } from '../../../src/projections/postgis/geometry-tree-readback.js';
import { SpatialProjectionError } from '../../../src/projections/postgis/errors.js';

const point = { type: 'Point', coordinates: [116.2, 40.2] };
const line = {
  type: 'LineString',
  coordinates: [
    [116, 40],
    [116.1, 40.1],
  ],
};
const multiPoint = {
  type: 'MultiPoint',
  coordinates: [
    [116, 40],
    [116.1, 40.1],
  ],
};
const multiLine = {
  type: 'MultiLineString',
  coordinates: [
    [
      [116, 40],
      [116.1, 40.1],
    ],
    [
      [116.2, 40.2],
      [116.3, 40.3],
    ],
  ],
};
const ring = [
  [116, 40],
  [116.1, 40],
  [116.1, 40.1],
  [116, 40],
];
const multiPolygon = { type: 'MultiPolygon', coordinates: [[ring]] };
const collection = (geometries: unknown[]) => ({
  type: 'GeometryCollection',
  geometries,
});
const original = collection([
  point,
  collection([
    line,
    multiPoint,
    collection([multiLine, multiPolygon]),
    collection([point]),
  ]),
  point,
]);
const branch = (path: number[], childCount: number) => ({
  path,
  type: 'ST_GeometryCollection',
  childCount,
  geometry: null,
});
const leaf = <T extends { type: string; coordinates: unknown }>(
  path: number[],
  geometry: T,
) => ({ path, type: `ST_${geometry.type}`, childCount: 0, geometry });
const nodes = [
  branch([], 3),
  leaf([1], point),
  branch([2], 4),
  leaf([2, 1], line),
  leaf([2, 2], multiPoint),
  branch([2, 3], 2),
  leaf([2, 3, 1], multiLine),
  leaf([2, 3, 2], multiPolygon),
  branch([2, 4], 1),
  leaf([2, 4, 1], point),
  leaf([3], point),
];
const limits = {
  maxDepth: 4,
  maxNodes: 32,
  maxPositions: 100_000,
  maxBytes: 2_621_440,
};
const read = (value: unknown = nodes, bounds = limits) =>
  rebuildPostgisGeometryTree(value, bounds);

describe('private PostGIS geometry tree readback', () => {
  it('rebuilds the native 11-node/7-leaf fixture with containers, repeats and Multi leaves unchanged', () => {
    const before = structuredClone(nodes);
    expect(read()).toEqual(original);
    expect(nodes).toEqual(before);
  });
  it('uses direct member paths, not row order, and copies leaf coordinates', () => {
    const input = structuredClone(nodes).reverse();
    const output = read(input);
    expect(output).toEqual(original);
    (
      input.find((n) => n.type === 'ST_Point')!.geometry!
        .coordinates as number[]
    )[0] = 0;
    expect(output).toEqual(original);
  });
  it.each([
    point,
    line,
    multiPoint,
    multiLine,
    { type: 'Polygon', coordinates: [ring] },
    multiPolygon,
  ])(
    'retains a simple root leaf without adding a collection: $type',
    (geometry) => {
      expect(read([leaf([], geometry)])).toEqual(geometry);
    },
  );
  it('retains consistent three-dimensional coordinates across leaves', () => {
    const geometry = { type: 'Point', coordinates: [0, 1, 2] };
    expect(
      read([branch([], 2), leaf([1], geometry), leaf([2], geometry)]),
    ).toEqual(collection([geometry, geometry]));
  });
  it('counts all positions and nodes across branches and respects caller depth', () => {
    expect(
      read(nodes, { ...limits, maxNodes: 11, maxPositions: 15, maxDepth: 3 }),
    ).toEqual(original);
    for (const narrowed of [
      { maxNodes: 10 },
      { maxPositions: 14 },
      { maxDepth: 2 },
    ]) {
      expect(() => read(nodes, { ...limits, ...narrowed })).toThrow(
        SpatialProjectionError,
      );
    }
  });
  it('counts complete final JSON bytes including collection shells and separators', () => {
    const size = new TextEncoder().encode(JSON.stringify(original)).length;
    expect(read(nodes, { ...limits, maxBytes: size })).toEqual(original);
    expect(() => read(nodes, { ...limits, maxBytes: size - 1 })).toThrow(
      SpatialProjectionError,
    );
  });
  it('honors a zero-depth caller for a simple root but not a collection child', () => {
    expect(read([leaf([], point)], { ...limits, maxDepth: 0 })).toEqual(point);
    expect(() =>
      read([branch([], 1), leaf([1], point)], { ...limits, maxDepth: 0 }),
    ).toThrow(SpatialProjectionError);
  });
  it.each([
    null,
    {},
    [],
    [leaf([1], point)],
    [branch([], 0)],
    [leaf([], point), leaf([], point)],
    [branch([], 2), leaf([1], point), leaf([1], point)],
    [branch([], 1), leaf([2], point)],
    [branch([], 1), leaf([1, 1], point)],
    [leaf([], point), leaf([1], point)],
    [branch([], 1), leaf([1], point), leaf([2], point)],
    [{ ...leaf([], point), childCount: 1 }],
    [{ ...branch([], 1), geometry: point }, leaf([1], point)],
    [{ ...leaf([], point), type: 'ST_LineString' }],
    [{ ...leaf([], point), type: 'ST_Unknown' }],
    [{ ...leaf([], point), extra: true }],
    [{ ...leaf([], point), geometry: null }],
    [{ ...leaf([], point), path: [0] }],
    [{ ...leaf([], point), path: [-1] }],
    [{ ...leaf([], point), path: [1.5] }],
    [{ ...branch([], 1), childCount: 1.5 }, leaf([1], point)],
    [leaf([], { ...point, extra: 1 })],
    [leaf([], { type: 'Point', coordinates: [1, Number.NaN] })],
    [leaf([], { type: 'Point', coordinates: [1, Number.POSITIVE_INFINITY] })],
    [leaf([], { type: 'Point', coordinates: [1] })],
    [leaf([], { type: 'MultiPoint', coordinates: [] })],
    [leaf([], { type: 'LineString', coordinates: [[1, 1]] })],
    [
      leaf([], {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [2, 2],
          ],
        ],
      }),
    ],
    [
      leaf([], {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
            [0, 0],
          ],
        ],
      }),
    ],
    [
      branch([], 2),
      leaf([1], point),
      leaf([2], { type: 'Point', coordinates: [1, 2, 3] }),
    ],
  ])('rejects malformed, incomplete or mismatched trees %#', (value) => {
    expect(() => read(value)).toThrow(SpatialProjectionError);
  });
  it.each([
    { maxDepth: -1 },
    { maxDepth: 9 },
    { maxNodes: 0 },
    { maxPositions: 0 },
    { maxPositions: 100_001 },
    { maxBytes: 0 },
    { maxBytes: Number.POSITIVE_INFINITY },
    { maxDepth: 1.5 },
    { unknown: 1 },
  ])('requires finite explicit internal bounds %#', (bad) => {
    expect(() => read(nodes, { ...limits, ...bad })).toThrow(
      SpatialProjectionError,
    );
  });
});
