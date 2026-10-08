import proj4 from 'proj4';
import type { WorkspaceBounds } from './spatial-workspace-contract';
import {
  CANDIDATE_RASTER_AFFINE,
  CANDIDATE_RASTER_BANDS,
  CANDIDATE_RASTER_GRID,
  validateRasterSelection,
  type CandidateRasterWindow,
} from './candidate-raster-window';

const projection = proj4('EPSG:4326', 'EPSG:32650');
const [scaleX, , originX, , scaleY, originY] = CANDIDATE_RASTER_AFFINE;
function invalid(): never {
  throw new TypeError('Invalid fixed raster map selection');
}
function pair(value: readonly number[]): [number, number] {
  if (value.length !== 2 || !value.every(Number.isFinite)) invalid();
  return [value[0], value[1]];
}
// Stabilize projection roundoff within 0.000002 m of an exact grid edge.
// Larger outside selections are rejected, never clipped to the scene.
function edge(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-7 ? rounded || 0 : value;
}
function gridPosition(point: readonly number[]): [number, number] {
  const [x, y] = pair(point);
  const row = edge((y - originY) / scaleY);
  const column = edge((x - originX) / scaleX);
  if (
    row < 0 ||
    row > CANDIDATE_RASTER_GRID.rows ||
    column < 0 ||
    column > CANDIDATE_RASTER_GRID.columns
  )
    invalid();
  return [row, column];
}
export function checkedRasterWindow(
  window: CandidateRasterWindow,
): CandidateRasterWindow {
  return validateRasterSelection({
    window,
    quality: { kind: 'raw' },
    bands: CANDIDATE_RASTER_BANDS,
  }).window;
}
export function nativeRasterCoordinate(
  row: number,
  column: number,
): [number, number] {
  if (
    !Number.isFinite(row) ||
    !Number.isFinite(column) ||
    row < 0 ||
    column < 0 ||
    row > CANDIDATE_RASTER_GRID.rows ||
    column > CANDIDATE_RASTER_GRID.columns
  )
    invalid();
  return [originX + column * scaleX, originY + row * scaleY];
}
export function nativeRasterPixel(point: readonly number[]): {
  row: number;
  column: number;
} {
  const [row, column] = gridPosition(point);
  if (
    row >= CANDIDATE_RASTER_GRID.rows ||
    column >= CANDIDATE_RASTER_GRID.columns
  )
    invalid();
  return { row: Math.floor(row), column: Math.floor(column) };
}
export function nativeRasterWindowBounds(
  input: CandidateRasterWindow,
): WorkspaceBounds {
  const window = checkedRasterWindow(input);
  const [left, top] = nativeRasterCoordinate(window.row, window.column);
  const [right, bottom] = nativeRasterCoordinate(
    window.row + window.rows,
    window.column + window.columns,
  );
  return [left, bottom, right, top];
}
export function nativeRasterWindowFromPoints(
  a: readonly number[],
  b: readonly number[],
): CandidateRasterWindow {
  const [ar, ac] = gridPosition(a),
    [br, bc] = gridPosition(b);
  if (ar === br || ac === bc) invalid();
  const row = Math.floor(Math.min(ar, br)),
    column = Math.floor(Math.min(ac, bc));
  return checkedRasterWindow({
    row,
    column,
    rows: Math.ceil(Math.max(ar, br)) - row,
    columns: Math.ceil(Math.max(ac, bc)) - column,
  });
}
/** Display coordinates only. Encoded samples stay in their source grid. */
export function nativeRasterToMap(point: readonly number[]): [number, number] {
  return pair(projection.inverse(pair(point)));
}
export function mapToNativeRaster(point: readonly number[]): [number, number] {
  const [longitude, latitude] = pair(point);
  // This fixed UTM50N scene is in its own zone. Reject global or swapped axes.
  if (longitude < 114 || longitude > 120 || latitude < 0 || latitude > 84)
    invalid();
  return pair(projection.forward([longitude, latitude]));
}
export function mapRasterPixel(point: readonly number[]) {
  return nativeRasterPixel(mapToNativeRaster(point));
}
export function rasterWindowMapRing(
  window: CandidateRasterWindow,
): [number, number][] {
  const [left, bottom, right, top] = nativeRasterWindowBounds(window);
  return nativeBoundsMapRing([left, bottom, right, top]);
}
function nativeBoundsMapRing([left, bottom, right, top]: WorkspaceBounds): [
  number,
  number,
][] {
  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ];
  const points: [number, number][] = [];
  for (let index = 0; index < 4; index++) {
    const a = corners[index],
      b = corners[index + 1];
    // At most 32 native cells per segment; vertices stay on the original
    // affine boundary. This densifies display edges, never raster samples.
    const count = Math.ceil(
      Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 640,
    );
    for (let step = 0; step < count; step++)
      points.push(
        nativeRasterToMap([
          a[0] + ((b[0] - a[0]) * step) / count,
          a[1] + ((b[1] - a[1]) * step) / count,
        ]),
      );
  }
  points.push(points[0]);
  return points;
}
export function rasterFootprintMapRing(): [number, number][] {
  const [left, top] = nativeRasterCoordinate(0, 0),
    [right, bottom] = nativeRasterCoordinate(
      CANDIDATE_RASTER_GRID.rows,
      CANDIDATE_RASTER_GRID.columns,
    );
  return nativeBoundsMapRing([left, bottom, right, top]);
}
/** Enclose all four corners of the existing WGS84 rectangle in native cells.
 * Every point must be within this fixed scene; no clipping of an outside AOI.
 */
export function mapRasterWindowFromBounds(
  bounds: WorkspaceBounds,
): CandidateRasterWindow {
  const [west, south, east, north] = bounds;
  if (
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    west >= east ||
    south >= north
  )
    invalid();
  const points = [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ].map((point) => gridPosition(mapToNativeRaster(point)));
  const row = Math.floor(Math.min(...points.map((point) => point[0]))),
    column = Math.floor(Math.min(...points.map((point) => point[1])));
  return checkedRasterWindow({
    row,
    column,
    rows: Math.ceil(Math.max(...points.map((point) => point[0]))) - row,
    columns: Math.ceil(Math.max(...points.map((point) => point[1]))) - column,
  });
}
