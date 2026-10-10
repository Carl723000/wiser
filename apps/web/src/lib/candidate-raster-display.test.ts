import { describe, expect, it } from 'vitest';
import type { CandidateRasterWindowResult } from './candidate-raster-window';
import {
  candidateRasterDisplay,
  initialRasterComparison,
  moveRasterCamera,
  rasterCamera,
  setRasterDisplay,
  setRasterSynchronization,
  setRasterViewMode,
} from './candidate-raster-display';

export function displayFixture(): CandidateRasterWindowResult {
  return {
    window: { row: 10, column: 20, rows: 2, columns: 3 },
    crs: 'EPSG:32650',
    affine: [20, 0, 385180, 0, -20, 4481920],
    sourceProduct: 'fixed-scene',
    sensingTime: '2026-08-24T03:05:19Z',
    values: {
      B03: new Uint16Array(6),
      B8A: new Uint16Array(6),
      SCL: Uint8Array.of(0, 4, 6, 11, 4, 6),
      TCI: [
        Uint8Array.of(1, 2, 3, 4, 5, 6),
        Uint8Array.of(7, 8, 9, 10, 11, 12),
        Uint8Array.of(13, 14, 15, 16, 17, 18),
      ],
    },
    validMask: new Uint8Array(6).fill(255),
    qualityMask: Uint8Array.of(1, 1, 0, 0, 1, 0),
    quality: {
      kind: 'scl-classes',
      allowedClasses: [0, 4],
      ruleVersion: 'user-v1',
    },
  };
}
const camera = { longitude: 116, latitude: 40, zoom: 10, bearing: 0, pitch: 0 };

describe('native geographic comparison display', () => {
  it('shares exact cell geometry between RGB and discrete original codes, including a non-square last row', () => {
    const result = displayFixture();
    const before = [
      ...result.values.TCI.map((a) => Array.from(a)),
      Array.from(result.values.SCL),
      Array.from(result.qualityMask),
    ];
    const display = candidateRasterDisplay(result);
    expect(display.tci.features).toHaveLength(6);
    expect(display.scl.features).toHaveLength(6);
    expect(display.tci.features[3].properties).toMatchObject({
      row: 11,
      column: 20,
      color: 'rgb(4,10,16)',
    });
    expect(display.tci.features[5].properties).toMatchObject({
      row: 11,
      column: 22,
      color: 'rgb(6,12,18)',
    });
    display.tci.features.forEach((feature, i) =>
      expect(feature.geometry).toBe(display.scl.features[i].geometry),
    );
    expect(display.scl.features.map((f) => f.properties.code)).toEqual([
      0, 4, 6, 11, 4, 6,
    ]);
    expect(display.legend.map((item) => [item.code, item.count])).toEqual([
      [0, 1],
      [4, 2],
      [6, 2],
      [11, 1],
    ]);
    expect([
      ...result.values.TCI.map((a) => Array.from(a)),
      Array.from(result.values.SCL),
      Array.from(result.qualityMask),
    ]).toEqual(before);
  });
  it('rejects a mismatched array, unknown category or over-budget window instead of inventing classified pixels', () => {
    const result = displayFixture();
    expect(() =>
      candidateRasterDisplay({
        ...result,
        values: { ...result.values, SCL: Uint8Array.of(12, 4, 6, 11, 4, 6) },
      }),
    ).toThrow();
    expect(() =>
      candidateRasterDisplay({
        ...result,
        values: {
          ...result.values,
          TCI: [new Uint8Array(5), result.values.TCI[1], result.values.TCI[2]],
        },
      }),
    ).toThrow();
    expect(() =>
      candidateRasterDisplay({
        ...result,
        window: { row: 0, column: 0, rows: 65, columns: 64 },
      }),
    ).toThrow();
  });
  it('retains independent cameras across a shared swipe and restores the original map camera', () => {
    let state = setRasterDisplay(
      initialRasterComparison(camera),
      'side-by-side',
    );
    state = setRasterSynchronization(state, false);
    const right = { ...camera, zoom: 13, bearing: 15, pitch: 25 };
    state = moveRasterCamera(state, 'right', right);
    expect(rasterCamera(state, 'left')).toEqual(camera);
    expect(rasterCamera(state, 'right')).toEqual(right);
    state = setRasterDisplay(state, 'swipe');
    const shared = { ...camera, zoom: 12, bearing: 30, pitch: 50 };
    state = moveRasterCamera(state, 'left', shared);
    expect(rasterCamera(state, 'right')).toEqual(shared);
    state = setRasterDisplay(state, 'side-by-side');
    expect(rasterCamera(state, 'right')).toEqual(right);
    expect(rasterCamera(state, 'left')).toEqual(camera);
    state = setRasterDisplay(state, 'single');
    expect(rasterCamera(state, 'left')).toEqual(camera);
  });
  it('synchronizes all camera coordinates while view-mode changes keep the reading state separate', () => {
    let state = setRasterDisplay(
      initialRasterComparison(camera),
      'side-by-side',
    );
    const moved = {
      ...camera,
      longitude: 115.8,
      latitude: 40.2,
      zoom: 14,
      bearing: 20,
      pitch: 42,
    };
    state = moveRasterCamera(state, 'right', moved);
    expect(rasterCamera(state, 'left')).toEqual(moved);
    state = setRasterViewMode(state, '3d');
    expect(state.mode).toBe('3d');
    expect(rasterCamera(state, 'left')).toEqual(moved);
    state = setRasterViewMode(state, '2d');
    expect(state.mode).toBe('2d');
    expect(state.left).toEqual(moved);
  });
});
