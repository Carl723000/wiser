import { SpatialProjectionError } from './errors.js';
import type { SupportedGeoJsonGeometry } from './types.js';

/** Caller limits are required: a candidate reader must retain its own narrower limits. */
export interface GeometryTreeReadbackLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxPositions: number;
  readonly maxBytes: number;
}
interface TreeNode {
  readonly path: readonly number[];
  readonly type: string;
  readonly childCount: number;
  readonly geometry: unknown;
}
const TYPES = new Set([
  'GeometryCollection',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);
function invalid(): never {
  throw new SpatialProjectionError(
    'INVALID_SPATIAL_PROJECTION_INPUT',
    'PostGIS geometry tree is invalid or exceeds its readback budget.',
  );
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    invalid();
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalid();
  return value;
}

/** Pure assembly only. SQL authorization, traversal bounds and cancellation remain with the caller. */
export function rebuildPostgisGeometryTree(
  input: unknown,
  limits: GeometryTreeReadbackLimits,
): SupportedGeoJsonGeometry {
  const config = object(limits, [
    'maxDepth',
    'maxNodes',
    'maxPositions',
    'maxBytes',
  ]);
  const maxDepth = integer(config.maxDepth, 0, 8);
  const maxNodes = integer(config.maxNodes, 1);
  const maxPositions = integer(config.maxPositions, 1);
  const maxBytes = integer(config.maxBytes, 1);
  if (!Array.isArray(input) || input.length === 0 || input.length > maxNodes)
    invalid();
  const nodes = new Map<string, TreeNode>();
  let children = 0;
  for (const value of input as unknown[]) {
    const row = object(value, ['path', 'type', 'childCount', 'geometry']);
    if (!Array.isArray(row.path) || row.path.length > maxDepth) invalid();
    const path: number[] = [];
    for (const member of row.path as unknown[])
      path.push(integer(member, 1, input.length));
    if (
      typeof row.type !== 'string' ||
      !row.type.startsWith('ST_') ||
      !TYPES.has(row.type.slice(3))
    )
      invalid();
    const childCount = integer(row.childCount, 0, input.length - 1);
    const isCollection = row.type === 'ST_GeometryCollection';
    if (
      isCollection
        ? childCount === 0 || row.geometry !== null
        : childCount !== 0 || row.geometry === null
    )
      invalid();
    const key = path.join('/');
    if (nodes.has(key)) invalid();
    nodes.set(key, {
      path,
      type: row.type.slice(3),
      childCount,
      geometry: row.geometry,
    });
    children += childCount;
    if (children > input.length - 1) invalid();
  }
  if (!nodes.has('') || children !== input.length - 1) invalid();
  let bytes = 0,
    positions = 0;
  function charge(size: number) {
    bytes += size;
    if (bytes > maxBytes) invalid();
  }
  function sequence(
    value: unknown,
    minimum: number,
    item: (entry: unknown) => unknown,
  ): unknown[] {
    if (!Array.isArray(value) || value.length < minimum) invalid();
    charge(2 + value.length - 1);
    const result: unknown[] = [];
    for (const entry of value as unknown[]) result.push(item(entry));
    return result;
  }
  function position(value: unknown): number[] {
    if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3))
      invalid();
    positions += 1;
    if (positions > maxPositions) invalid();
    charge(2 + value.length - 1);
    const result: number[] = [];
    for (const ordinate of value as unknown[]) {
      if (typeof ordinate !== 'number' || !Number.isFinite(ordinate)) invalid();
      charge(JSON.stringify(ordinate).length);
      result.push(ordinate);
    }
    return result;
  }
  function ring(value: unknown): unknown[] {
    const result = sequence(value, 4, position) as number[][];
    const first = result[0]!;
    const last = result.at(-1)!;
    if (
      first.length !== last.length ||
      first.some((ordinate, index) => ordinate !== last[index])
    )
      invalid();
    return result;
  }
  function leaf(node: TreeNode): SupportedGeoJsonGeometry {
    const geometry = object(node.geometry, ['type', 'coordinates']);
    if (geometry.type !== node.type) invalid();
    charge(`{"type":"${node.type}","coordinates":`.length + 1);
    let coordinates: unknown;
    switch (node.type) {
      case 'Point':
        coordinates = position(geometry.coordinates);
        break;
      case 'MultiPoint':
        coordinates = sequence(geometry.coordinates, 1, position);
        break;
      case 'LineString':
        coordinates = sequence(geometry.coordinates, 2, position);
        break;
      case 'MultiLineString':
        coordinates = sequence(geometry.coordinates, 1, (line) =>
          sequence(line, 2, position),
        );
        break;
      case 'Polygon':
        coordinates = sequence(geometry.coordinates, 1, ring);
        break;
      case 'MultiPolygon':
        coordinates = sequence(geometry.coordinates, 1, (polygon) =>
          sequence(polygon, 1, ring),
        );
        break;
      default:
        return invalid();
    }
    return { type: node.type, coordinates } as SupportedGeoJsonGeometry;
  }
  let visited = 0;
  function assemble(path: readonly number[]): SupportedGeoJsonGeometry {
    const node = nodes.get(path.join('/'));
    if (!node) invalid();
    visited += 1;
    if (node.type !== 'GeometryCollection') return leaf(node);
    charge(
      '{"type":"GeometryCollection","geometries":['.length +
        2 +
        node.childCount -
        1,
    );
    const geometries: SupportedGeoJsonGeometry[] = [];
    for (let index = 1; index <= node.childCount; index += 1)
      geometries.push(assemble([...path, index]));
    return { type: 'GeometryCollection', geometries };
  }
  const result = assemble([]);
  if (visited !== nodes.size) invalid();
  return result;
}
