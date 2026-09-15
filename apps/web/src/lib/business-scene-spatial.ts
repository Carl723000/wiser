import type { Feature, FeatureCollection } from 'geojson';
import type { BusinessScene } from './business-scene';
import { businessMapBounds } from './business-map';
export type SpatialSceneAnchor = {
  feature: Feature;
  labelPoint: [number, number];
};
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
