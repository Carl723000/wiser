import { expect, it } from 'vitest';
import type { FeatureCollection } from 'geojson';
import {
  spatialSceneAnchors,
  spatialHitNodes,
  spatialObjectRelations,
  relatedSpatialReferences,
  spatialSceneCoverage,
  unlocatedSceneLayout,
} from './business-scene-spatial';
import type { BusinessScene } from './business-scene';
import type { RelationAssertion } from '@wiser/data-contracts';
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
const referenceEdge = (
  from: string,
  to: string,
  predicate: string,
  state = 'PENDING_REVIEW',
  role = 'REFERENCE_LOCATION',
) => ({
  id: from + ':' + to,
  from,
  to,
  row: {
    status: state,
    candidate: {
      predicate,
      qualifiers: {
        context: { recordNature: 'SOURCE_RELATION', locationRole: role },
      },
    },
  } as RelationAssertion,
});
it('lets a source inspect an explicitly linked reference area without assigning source coordinates', () => {
  const linked: BusinessScene = {
    nodes: [
      ...scene.nodes,
      { ...node, id: 'doc', kind: 'DOCUMENT', record: null },
    ],
    edges: [
      referenceEdge('doc', 'same-name', 'ABOUT_ENTITY'),
      referenceEdge('same-name', 'source-object', 'IDENTITY_MATCH'),
    ],
  };
  const anchors = spatialSceneAnchors(linked, features);
  const before = JSON.stringify(linked);
  expect([...relatedSpatialReferences(linked, anchors, 'doc').keys()]).toEqual([
    'source-object',
  ]);
  expect([
    ...relatedSpatialReferences(linked, anchors, 'same-name').keys(),
  ]).toEqual(['source-object']);
  expect(anchors.has('doc')).toBe(false);
  expect(anchors.has('same-name')).toBe(false);
  expect(JSON.stringify(linked)).toBe(before);
});
it('does not turn names, observations, reversed mentions or venue links into a reference location', () => {
  for (const edges of [
    [],
    [referenceEdge('same-name', 'source-object', 'OBSERVES_ENTITY')],
    [referenceEdge('source-object', 'same-name', 'ABOUT_ENTITY')],
    [
      referenceEdge(
        'same-name',
        'source-object',
        'ABOUT_ENTITY',
        'APPROVED',
        'VENUE',
      ),
    ],
    [referenceEdge('same-name', 'source-object', 'IDENTITY_MATCH', 'REJECTED')],
  ]) {
    expect(
      relatedSpatialReferences(
        { ...scene, edges },
        spatialSceneAnchors(scene, features),
        'same-name',
      ).size,
    ).toBe(0);
  }
});
it('keeps multiple explicit reference areas, excludes unbound and unavailable endpoints, and stops after two edges', () => {
  const area2 = {
    ...node,
    id: 'area2',
    record: { ...node.record, recordId: 'r2' },
  };
  const extra = { ...features.features[0], id: 'g2', properties: area2.record };
  const linked: BusinessScene = {
    nodes: [
      ...scene.nodes,
      area2,
      { ...node, id: 'doc', kind: 'DOCUMENT', record: null },
      { ...node, id: 'middle', record: null },
    ],
    edges: [
      referenceEdge('doc', 'source-object', 'ABOUT_ENTITY'),
      referenceEdge('doc', 'area2', 'ABOUT_ENTITY'),
      referenceEdge('doc', 'absent', 'ABOUT_ENTITY'),
      referenceEdge('doc', 'middle', 'ABOUT_ENTITY'),
      referenceEdge('middle', 'same-name', 'IDENTITY_MATCH'),
      referenceEdge('same-name', 'wrong-version', 'IDENTITY_MATCH'),
    ],
  };
  const anchors = spatialSceneAnchors(linked, {
    ...features,
    features: [...features.features, extra],
  });
  expect(
    [...relatedSpatialReferences(linked, anchors, 'doc').keys()].sort(),
  ).toEqual(['area2', 'source-object']);
  expect(relatedSpatialReferences(linked, anchors, null).size).toBe(0);
});
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

it('picks all exact source-version-record bindings, deduplicating rendered layers without name matching', () => {
  const shared = { ...node, id: 'second-binding' };
  const linked = { ...scene, nodes: [...scene.nodes, shared] };
  const anchors = spatialSceneAnchors(linked, features);
  const hit = { properties: { ...node.record } };
  expect(spatialHitNodes(anchors, [hit, hit])).toEqual([
    'source-object',
    'second-binding',
  ]);
  expect(
    spatialHitNodes(anchors, [
      { properties: { ...node.record, versionId: 'wrong' } },
      { properties: { label: node.label } },
    ]),
  ).toEqual([]);
});
it('finds typed evidence around a mapped area through explicit spatial references only', () => {
  const linked: BusinessScene = {
    nodes: [
      ...scene.nodes,
      { ...node, id: 'report', kind: 'DOCUMENT', record: null },
      { ...node, id: 'observation', kind: 'OBSERVATION', record: null },
      { ...node, id: 'unrelated', kind: 'POLICY', record: null },
    ],
    edges: [
      referenceEdge('same-name', 'source-object', 'IDENTITY_MATCH'),
      referenceEdge('report', 'same-name', 'ABOUT_ENTITY'),
      referenceEdge('observation', 'same-name', 'OBSERVATION_OF'),
      referenceEdge('unrelated', 'source-object', 'ABOUT_ENTITY', 'REJECTED'),
      referenceEdge('report', 'wrong-version', 'ABOUT_ENTITY'),
    ],
  };
  const rows = spatialObjectRelations(linked, 'source-object');
  expect(rows.map((r) => r.node.id)).toEqual([
    'same-name',
    'report',
    'observation',
  ]);
  expect(rows.find((r) => r.node.id === 'report')?.via?.id).toBe('same-name');
  expect(rows.find((r) => r.node.id === 'observation')?.edge.id).toBe(
    'observation:same-name',
  );
  expect(spatialObjectRelations(linked, 'missing')).toEqual([]);
  const noReferences = {
    ...linked,
    edges: linked.edges.filter(
      (e) => e.row.candidate.predicate !== 'IDENTITY_MATCH',
    ),
  };
  expect(spatialObjectRelations(noReferences, 'source-object')).toEqual([]);
});
