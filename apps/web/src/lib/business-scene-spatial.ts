import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { BusinessScene } from './business-scene';
import { businessMapBounds } from './business-map';

/** Screen-space reading layout only; these positions are never geographic coordinates. */
export function unlocatedSceneLayout(
  nodes: BusinessScene['nodes'],
  width: number,
  height: number,
) {
  const groups = new Map<string, BusinessScene['nodes']>();
  for (const node of nodes) {
    const members = groups.get(node.group) ?? [];
    members.push(node);
    groups.set(node.group, members);
  }
  const ordered = [...groups].sort(([a], [b]) => a.localeCompare(b, 'en'));
  const columns = Math.max(1, Math.floor(width / 8));
  const rows = ordered.reduce(
    (sum, [, members]) => sum + Math.ceil(members.length / columns),
    0,
  );
  const header = Math.min(22, height / Math.max(1, ordered.length) / 2);
  const dx = width / columns;
  const dy = Math.min(
    12,
    (height - header * ordered.length) / Math.max(1, rows),
  );
  const positions = new Map<string, [number, number]>();
  const captions: { group: string; y: number; count: number }[] = [];
  let top = 0;
  for (const [group, members] of ordered) {
    captions.push({ group, y: top + header * 0.7, count: members.length });
    top += header;
    [...members]
      .sort((a, b) => a.id.localeCompare(b.id, 'en'))
      .forEach((node, index) => {
        positions.set(node.id, [
          ((index % columns) + 0.5) * dx,
          top + (Math.floor(index / columns) + 0.5) * dy,
        ]);
      });
    top += Math.ceil(members.length / columns) * dy;
  }
  return {
    positions,
    captions,
    radius: Math.max(0.4, Math.min(3, (Math.min(dx, dy) - 1) / 2)),
  };
}
export type SpatialSceneAnchor = {
  feature: Feature;
  labelPoint: [number, number];
};

/** Reference navigation only: never promotes a mention or candidate to an exact location. */
export function relatedSpatialReferences(
  scene: BusinessScene,
  anchors: ReadonlyMap<string, SpatialSceneAnchor>,
  selectedId: string | null,
) {
  const result = new Map<string, SpatialSceneAnchor>();
  const nodes = new Map(scene.nodes.map((n) => [n.id, n]));
  if (!selectedId || !nodes.has(selectedId)) return result;
  const spatialKinds = new Set([
    'PLACE',
    'RIVER_REACH',
    'BASIN',
    'MONITORING_POINT',
  ]);
  const spatial = (id: string) => spatialKinds.has(nodes.get(id)?.kind ?? '');
  const edges = scene.edges.filter(
    ({ from, to, row }) =>
      nodes.has(from) &&
      nodes.has(to) &&
      (row.status === 'PENDING_REVIEW' || row.status === 'APPROVED') &&
      row.candidate.qualifiers?.context?.recordNature === 'SOURCE_RELATION' &&
      row.candidate.qualifiers?.context?.locationRole === 'REFERENCE_LOCATION',
  );
  const add = (id: string) => {
    const anchor = anchors.get(id);
    if (id !== selectedId && anchor && spatial(id)) result.set(id, anchor);
  };
  const identity = (id: string) => {
    if (!spatial(id)) return;
    for (const e of edges) {
      if (e.row.candidate.predicate !== 'IDENTITY_MATCH') continue;
      const other = e.from === id ? e.to : e.to === id ? e.from : null;
      if (other && nodes.get(other)?.kind === nodes.get(id)?.kind) add(other);
    }
  };
  identity(selectedId);
  for (const e of edges) {
    if (
      e.from !== selectedId ||
      e.row.candidate.predicate !== 'ABOUT_ENTITY' ||
      !spatial(e.to)
    )
      continue;
    add(e.to);
    identity(e.to);
  }
  return result;
}

/** Readout for the complete current map scope, not extraction recall or unique places. */
export function spatialSceneCoverage(
  scene: BusinessScene,
  anchors: ReadonlyMap<string, SpatialSceneAnchor>,
) {
  type Family = 'point' | 'line' | 'area';
  const families = (geometry: Geometry): Family[] => {
    if (geometry.type === 'GeometryCollection')
      return geometry.geometries.flatMap(families);
    if (geometry.type === 'Point' || geometry.type === 'MultiPoint')
      return ['point'];
    if (geometry.type === 'LineString' || geometry.type === 'MultiLineString')
      return ['line'];
    return ['area'];
  };
  const geometries = { point: 0, line: 0, area: 0, mixed: 0 };
  // Multiple knowledge nodes may bind the same original record geometry.
  const features = new Set([...anchors.values()].map((a) => a.feature));
  for (const feature of features) {
    const kinds = new Set(families(feature.geometry));
    if (kinds.size > 1) geometries.mixed++;
    else for (const kind of kinds) geometries[kind]++;
  }
  const spatialKinds = new Set([
    'PLACE',
    'RIVER_REACH',
    'BASIN',
    'MONITORING_POINT',
  ]);
  return {
    boundObjects: anchors.size,
    namedUnboundObjects: scene.nodes.filter(
      (n) => spatialKinds.has(n.kind) && n.label.trim() && !anchors.has(n.id),
    ).length,
    geometries,
  };
}
/** The center is a connector label position for the original geometry, not a new point feature. */
export function spatialSceneAnchors(
  scene: BusinessScene,
  collection: FeatureCollection,
) {
  const features = new Map(
    collection.features.map((f) => [
      JSON.stringify([
        f.properties?.['dataItemId'],
        f.properties?.['versionId'],
        f.properties?.['recordId'],
      ]),
      f,
    ]),
  );
  const anchors = new Map<string, SpatialSceneAnchor>();
  for (const node of scene.nodes) {
    if (!node.record) continue;
    const f = features.get(
      JSON.stringify([
        node.record.dataItemId,
        node.record.versionId,
        node.record.recordId,
      ]),
    );
    if (!f) continue;
    const bounds = businessMapBounds({
      type: 'FeatureCollection',
      features: [f],
    });
    if (!bounds) continue;
    anchors.set(node.id, {
      feature: f,
      labelPoint: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    });
  }
  return anchors;
}
