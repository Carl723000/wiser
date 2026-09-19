import { expect, it } from 'vitest';
import type { FeatureCollection } from 'geojson';
import {
  spatialSceneAnchors,
  spatialSceneCoverage,
  unlocatedSceneLayout,
} from './business-scene-spatial';
import type { BusinessScene } from './business-scene';
const node = {
  id: 'source-object',
  label: '官厅水库',
  kind: 'PLACE' as const,
  group: 'PLACE',
  classificationBasis: null,
  periods: [],
  record: { dataItemId: 'source', versionId: 'version', recordId: 'record' },
};
const scene: BusinessScene = {
  nodes: [
    node,
    { ...node, id: 'same-name', record: null },
    {
      ...node,
      id: 'wrong-version',
      record: { ...node.record, versionId: 'foreign' },
    },
  ],
  edges: [],
};
const features: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'geometry',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [115, 40],
            [116, 40],
            [116, 41],
            [115, 40],
          ],
        ],
      },
      properties: node.record,
    },
  ],
};
it('anchors only the exact bound resource, version and record; an area remains an area', () => {
  const anchors = spatialSceneAnchors(scene, features);
  expect([...anchors.keys()]).toEqual(['source-object']);
  expect(anchors.get('source-object')?.feature.geometry.type).toBe('Polygon');
  expect(anchors.get('source-object')?.labelPoint).toEqual([115.5, 40.5]);
  expect(features.features[0].geometry.type).toBe('Polygon');
});
it('does not guess positions for names, empty features, invalid coordinates or unbound records', () => {
  expect(
    spatialSceneAnchors(scene, { type: 'FeatureCollection', features: [] })
      .size,
  ).toBe(0);
  const bad = {
    ...features,
    features: [
      {
        ...features.features[0],
        geometry: { type: 'Point' as const, coordinates: [NaN, 40] },
      },
    ],
  };
  expect(spatialSceneAnchors(scene, bad).size).toBe(0);
});

it('counts areas as areas, not label points, and keeps same-name unbound source objects visible', () => {
  const expanded: BusinessScene = {
    nodes: [
      ...scene.nodes,
      { ...node, id: 'another-bound-node' },
      { ...node, id: 'document', kind: 'DOCUMENT', record: null },
    ],
    edges: [],
  };
  expect(
    spatialSceneCoverage(expanded, spatialSceneAnchors(expanded, features)),
  ).toEqual({
    boundObjects: 2,
    namedUnboundObjects: 2,
    geometries: { point: 0, line: 0, area: 1, mixed: 0 },
  });
});

it('counts a multipart river once, separates mixed geometry, and never counts unused map features', () => {
  const mixed: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        ...features.features[0],
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [115, 40],
              [116, 41],
            ],
            [
              [116, 41],
              [117, 41],
            ],
          ],
        },
      },
      {
        ...features.features[0],
        id: 'second',
        properties: { ...node.record, recordId: 'second' },
        geometry: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [115, 40] },
            {
              type: 'LineString',
              coordinates: [
                [115, 40],
                [116, 41],
              ],
            },
          ],
        },
      },
      {
        ...features.features[0],
        id: 'unused',
        properties: { ...node.record, recordId: 'unused' },
      },
    ],
  };
  const nodes = [
    node,
    { ...node, id: 'second', record: { ...node.record, recordId: 'second' } },
  ];
  const input = { nodes, edges: [] };
  expect(
    spatialSceneCoverage(input, spatialSceneAnchors(input, mixed)),
  ).toEqual({
    boundObjects: 2,
    namedUnboundObjects: 0,
    geometries: { point: 0, line: 1, area: 0, mixed: 1 },
  });
});

it('retains every source identity in a deterministic narrow reading layout without changing source locations', () => {
  const nodes = Array.from({ length: 1141 }, (_, i) => ({
    ...node,
    id: `source-${i}`,
    group: `group-${i % 17}`,
  }));
  const before = JSON.stringify(nodes);
  const result = unlocatedSceneLayout(nodes, 140, 590);
  expect(result.positions.size).toBe(nodes.length);
  expect(result.captions.reduce((sum, group) => sum + group.count, 0)).toBe(
    nodes.length,
  );
  expect([...result.positions]).toEqual([
    ...unlocatedSceneLayout([...nodes].reverse(), 140, 590).positions,
  ]);
  for (const [x, y] of result.positions.values()) {
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(140);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(590);
  }
  expect(JSON.stringify(nodes)).toBe(before);
  expect(unlocatedSceneLayout([], 140, 590).positions.size).toBe(0);
});
