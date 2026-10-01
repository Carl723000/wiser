import type { Geometry, Position } from 'geojson';

export type WorkspaceBounds = [number, number, number, number];

function coordinate(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    value.every(
      (number) => typeof number === 'number' && Number.isFinite(number),
    ) &&
    Math.abs(value[0] as number) <= 180 &&
    Math.abs(value[1] as number) <= 90
  );
}

/** Validate input only. Never repair, smooth, snap or change original geometry. */
export function isWorkspaceGeometry(
  value: unknown,
  depth = 0,
): value is Geometry {
  if (!value || typeof value !== 'object' || depth > 16) return false;
  const geometry = value as Record<string, unknown>;
  const list = (
    value: unknown,
    min: number,
    valid: (item: unknown) => boolean,
  ) => Array.isArray(value) && value.length >= min && value.every(valid);
  const line = (value: unknown) => list(value, 2, coordinate);
  const ring = (value: unknown) => {
    if (!list(value, 4, coordinate)) return false;
    const points = value as Position[];
    const first = points[0],
      last = points[points.length - 1];
    return first[0] === last[0] && first[1] === last[1];
  };
  const polygon = (value: unknown) => list(value, 1, ring);
  switch (geometry['type']) {
    case 'Point':
      return coordinate(geometry['coordinates']);
    case 'MultiPoint':
      return list(geometry['coordinates'], 1, coordinate);
    case 'LineString':
      return line(geometry['coordinates']);
    case 'MultiLineString':
      return list(geometry['coordinates'], 1, line);
    case 'Polygon':
      return polygon(geometry['coordinates']);
    case 'MultiPolygon':
      return list(geometry['coordinates'], 1, polygon);
    case 'GeometryCollection':
      return list(geometry['geometries'], 1, (item) =>
        isWorkspaceGeometry(item, depth + 1),
      );
    default:
      return false;
  }
}

export function parseWorkspaceBounds(value: string): WorkspaceBounds | null {
  const parts = value.split(',').map((part) => part.trim());
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^-?\d+(?:\.\d+)?$/.test(part))
  )
    return null;
  const bounds = parts.map(Number) as WorkspaceBounds;
  return validWorkspaceBounds(bounds) ? bounds : null;
}

function validWorkspaceBounds(
  value: readonly number[],
): value is WorkspaceBounds {
  return (
    value.length === 4 &&
    value.every(Number.isFinite) &&
    value[0] >= -180 &&
    value[2] <= 180 &&
    value[1] >= -90 &&
    value[3] <= 90 &&
    value[0] < value[2] &&
    value[1] < value[3]
  );
}

function pointInBounds(
  [x, y]: Position,
  [west, south, east, north]: WorkspaceBounds,
) {
  return x >= west && x <= east && y >= south && y <= north;
}

function segmentInBounds(a: Position, b: Position, bounds: WorkspaceBounds) {
  // Liang–Barsky clipping includes crossing segments and boundary contact.
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [
    a[0] - bounds[0],
    bounds[2] - a[0],
    a[1] - bounds[1],
    bounds[3] - a[1],
  ];
  let enter = 0,
    leave = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const ratio = q[i] / p[i];
      if (p[i] < 0) enter = Math.max(enter, ratio);
      else leave = Math.min(leave, ratio);
      if (enter > leave) return false;
    }
  }
  return true;
}

function pointInRing([x, y]: Position, ring: Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** GeoJSON uses linear interpolation in its coordinate frame; scope is local WGS84. */
export function geometryIntersectsWorkspaceBounds(
  geometry: Geometry,
  bounds: WorkspaceBounds,
): boolean {
  if (!validWorkspaceBounds(bounds) || !isWorkspaceGeometry(geometry))
    return false;
  const line = (points: Position[]) =>
    points.some((point) => pointInBounds(point, bounds)) ||
    points.some(
      (point, i) => i > 0 && segmentInBounds(points[i - 1], point, bounds),
    );
  const polygon = (rings: Position[][]) => {
    if (rings.some(line)) return true;
    const [west, south, east, north] = bounds;
    return [
      [west, south],
      [west, north],
      [east, north],
      [east, south],
    ].some(
      (point) =>
        pointInRing(point, rings[0]) &&
        !rings.slice(1).some((ring) => pointInRing(point, ring)),
    );
  };
  switch (geometry.type) {
    case 'Point':
      return pointInBounds(geometry.coordinates, bounds);
    case 'MultiPoint':
      return geometry.coordinates.some((point) => pointInBounds(point, bounds));
    case 'LineString':
      return line(geometry.coordinates);
    case 'MultiLineString':
      return geometry.coordinates.some(line);
    case 'Polygon':
      return polygon(geometry.coordinates);
    case 'MultiPolygon':
      return geometry.coordinates.some(polygon);
    case 'GeometryCollection':
      return geometry.geometries.some((part) =>
        geometryIntersectsWorkspaceBounds(part, bounds),
      );
  }
}

/** A connector attaches to an existing vertex; it is never a derived sampling point. */
export function workspaceGeometryAnchor(
  geometry: Geometry,
): [number, number] | null {
  if (!isWorkspaceGeometry(geometry)) return null;
  let point: Position;
  switch (geometry.type) {
    case 'GeometryCollection':
      return workspaceGeometryAnchor(geometry.geometries[0]);
    case 'Point':
      point = geometry.coordinates;
      break;
    case 'MultiPoint':
    case 'LineString':
      point = geometry.coordinates[0];
      break;
    case 'MultiLineString':
    case 'Polygon':
      point = geometry.coordinates[0][0];
      break;
    case 'MultiPolygon':
      point = geometry.coordinates[0][0][0];
      break;
  }
  return [point[0], point[1]];
}

/** Project an actual Mercator xyz with MapLibre's public, column-major map matrix. */
export function projectWorkspaceCoordinate(
  matrix: ArrayLike<number>,
  point: readonly [number, number, number],
  width: number,
  height: number,
) {
  if (
    matrix.length !== 16 ||
    ![width, height, ...point].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const result = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++)
    result[row] =
      matrix[row] * point[0] +
      matrix[4 + row] * point[1] +
      matrix[8 + row] * point[2] +
      matrix[12 + row];
  const [x, y, z, w] = result;
  if (!result.every(Number.isFinite) || w <= 0 || Math.abs(z / w) > 1)
    return null;
  return { x: ((1 + x / w) * width) / 2, y: ((1 - y / w) * height) / 2 };
}
