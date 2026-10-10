import type { FeatureCollection, Polygon } from 'geojson';
import {
  checkedRasterWindow,
  rasterWindowMapRing,
} from './candidate-raster-map';
import type { CandidateRasterWindowResult } from './candidate-raster-window';
import type { WorkspaceCamera } from './spatial-workspace-view';

/** Discrete display colors for encoded classes; these are not quality verdicts. */
const SCL_COLORS = [
  '#141414',
  '#e05b52',
  '#585858',
  '#8a5826',
  '#228a47',
  '#e1bd4d',
  '#287fcb',
  '#9b9b9b',
  '#c2c2c2',
  '#f5f5f5',
  '#70cddd',
  '#e993d1',
] as const;
interface RasterPixelDisplay {
  kind: 'pixel';
  color: string;
  row: number;
  column: number;
  code?: number;
}
export interface CandidateRasterDisplay {
  readonly tci: FeatureCollection<Polygon, RasterPixelDisplay>;
  readonly scl: FeatureCollection<Polygon, RasterPixelDisplay>;
  readonly legend: readonly { code: number; color: string; count: number }[];
}

/** Both surfaces share every original cell boundary, without image warping or sample interpolation. */
export function candidateRasterDisplay(
  result: CandidateRasterWindowResult,
): CandidateRasterDisplay {
  const window = checkedRasterWindow(result.window);
  const length = window.rows * window.columns;
  if (
    result.crs !== 'EPSG:32650' ||
    JSON.stringify(result.affine) !==
      JSON.stringify([20, 0, 385180, 0, -20, 4481920]) ||
    !Array.isArray(result.values.TCI) ||
    result.values.TCI.length !== 3 ||
    result.values.TCI.some(
      (a) => !(a instanceof Uint8Array) || a.length !== length,
    ) ||
    !(result.values.SCL instanceof Uint8Array) ||
    result.values.SCL.length !== length ||
    result.values.SCL.some((code) => code > 11)
  )
    throw new TypeError('Invalid native raster display');
  const tci: CandidateRasterDisplay['tci'] = {
    type: 'FeatureCollection',
    features: [],
  };
  const scl: CandidateRasterDisplay['scl'] = {
    type: 'FeatureCollection',
    features: [],
  };
  const counts = new Map<number, number>();
  for (let index = 0; index < length; index++) {
    const row = window.row + Math.floor(index / window.columns);
    const column = window.column + (index % window.columns);
    const geometry: Polygon = {
      type: 'Polygon',
      coordinates: [rasterWindowMapRing({ row, column, rows: 1, columns: 1 })],
    };
    const code = result.values.SCL[index];
    tci.features.push({
      type: 'Feature',
      id: `tci:${row}:${column}`,
      geometry,
      properties: {
        kind: 'pixel',
        row,
        column,
        color: `rgb(${result.values.TCI.map((a) => a[index]).join(',')})`,
      },
    });
    scl.features.push({
      type: 'Feature',
      id: `scl:${row}:${column}`,
      geometry,
      properties: { kind: 'pixel', row, column, code, color: SCL_COLORS[code] },
    });
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return {
    tci,
    scl,
    legend: [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([code, count]) => ({ code, count, color: SCL_COLORS[code] })),
  };
}

export type RasterDisplayMode = 'single' | 'side-by-side' | 'swipe';
export type RasterSide = 'left' | 'right';
export interface RasterComparisonState {
  readonly display: RasterDisplayMode;
  readonly mode: '2d' | '3d';
  readonly synchronized: boolean;
  readonly left: WorkspaceCamera;
  readonly right: WorkspaceCamera;
  readonly shared: WorkspaceCamera;
}
export function initialRasterComparison(
  camera: WorkspaceCamera,
): RasterComparisonState {
  return {
    display: 'single',
    mode: '2d',
    synchronized: true,
    left: camera,
    right: camera,
    shared: camera,
  };
}
export function rasterCamera(
  state: RasterComparisonState,
  side: RasterSide,
): WorkspaceCamera {
  return state.display === 'swipe' ? state.shared : state[side];
}
export function moveRasterCamera(
  state: RasterComparisonState,
  side: RasterSide,
  camera: WorkspaceCamera,
): RasterComparisonState {
  if (state.display === 'swipe') return { ...state, shared: camera };
  return state.synchronized || state.display === 'single'
    ? { ...state, left: camera, right: camera }
    : { ...state, [side]: camera };
}
export function setRasterDisplay(
  state: RasterComparisonState,
  display: RasterDisplayMode,
): RasterComparisonState {
  if (display === state.display) return state;
  // Swipe has its own shared camera; switching back restores each prior camera.
  return display === 'swipe'
    ? { ...state, display, shared: state.left }
    : { ...state, display };
}
export function setRasterSynchronization(
  state: RasterComparisonState,
  synchronized: boolean,
): RasterComparisonState {
  return synchronized
    ? { ...state, synchronized, right: state.left }
    : { ...state, synchronized };
}
export function setRasterViewMode(
  state: RasterComparisonState,
  mode: '2d' | '3d',
): RasterComparisonState {
  const perspective = (camera: WorkspaceCamera) =>
    mode === '3d' && camera.pitch === 0 ? { ...camera, pitch: 50 } : camera;
  return {
    ...state,
    mode,
    left: perspective(state.left),
    right: perspective(state.right),
    shared: perspective(state.shared),
  };
}
