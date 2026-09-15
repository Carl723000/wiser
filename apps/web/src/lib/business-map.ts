import type { FeatureCollection, Geometry } from 'geojson';
import type { ExplorationResult } from '@wiser/data-contracts';
import { amapCoordinates } from './amap-coordinates';
function displayGeometry(raw: Record<string, unknown>): Geometry {
  if (raw['type'] === 'GeometryCollection') {
    if (!Array.isArray(raw['geometries'])) throw Error('Invalid geometry');
    return {
      type: 'GeometryCollection',
      geometries: raw['geometries'].map((g) =>
        displayGeometry(g as Record<string, unknown>),
      ),
    };
  }
  if (
    ![
      'Point',
      'MultiPoint',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
    ].includes(String(raw['type']))
  )
    throw Error('Invalid geometry');
  return {
    ...raw,
    coordinates: amapCoordinates(raw['coordinates']),
  } as Geometry;
}
/** Use the same authorized record query as the table; legacy tiles do not interpret business conditions. */
export async function loadBusinessMap(
  first: ExplorationResult,
  next: (after: string) => Promise<ExplorationResult>,
): Promise<FeatureCollection> {
  let page = first;
  const features: NonNullable<ExplorationResult['features']> = [],
    cursors = new Set<string>();
  for (;;) {
    if (
      page.queryId !== first.queryId ||
      page.view !== 'map' ||
      page.totalCount !== first.totalCount
    )
      throw Error('Changed map scope');
    features.push(...(page.features ?? []));
    if (features.length > 2000) throw Error('Map scope too large');
    if (!page.nextCursor) break;
    if (cursors.has(page.nextCursor)) throw Error('Repeated map page');
    cursors.add(page.nextCursor);
    page = await next(page.nextCursor);
  }
  if (
    features.length !== first.totalCount ||
    new Set(features.map((f) => f.id)).size !== features.length
  )
    throw Error('Incomplete map');
  return {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      ...f,
      geometry: displayGeometry(f.geometry),
    })),
  };
}

/** Bounds of the rendered GCJ-02 features, not the broader source inventory. */
export function businessMapBounds(
  collection: FeatureCollection | null,
): [number, number, number, number] | undefined {
  let bounds: [number, number, number, number] | undefined;
  function coordinates(value: unknown): void {
    if (!Array.isArray(value)) return;
    const [x, y] = value as unknown[];
    if (typeof x === 'number' && typeof y === 'number') {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      bounds = bounds
        ? [
            Math.min(bounds[0], x),
            Math.min(bounds[1], y),
            Math.max(bounds[2], x),
            Math.max(bounds[3], y),
          ]
        : [x, y, x, y];
    } else value.forEach(coordinates);
  }
  function geometry(value: Geometry | null): void {
    if (!value) return;
    if (value.type === 'GeometryCollection') value.geometries.forEach(geometry);
    else coordinates(value.coordinates);
  }
  collection?.features.forEach((feature) => geometry(feature.geometry));
  return bounds;
}
