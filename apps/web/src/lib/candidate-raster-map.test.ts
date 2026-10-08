import { describe, expect, it } from 'vitest';
import {
  nativeRasterCoordinate,
  nativeRasterPixel,
  nativeRasterWindowFromPoints,
  nativeRasterWindowBounds,
  nativeRasterToMap,
  mapToNativeRaster,
  mapRasterPixel,
  mapRasterWindowFromBounds,
  rasterWindowMapRing,
  rasterFootprintMapRing,
} from './candidate-raster-map';

describe('fixed native raster grid selection', () => {
  it('round-trips pixel centers and exact native window edges without resampling', () => {
    expect(nativeRasterCoordinate(77.5, 318.5)).toEqual([391550, 4480370]);
    expect(nativeRasterPixel([391550, 4480370])).toEqual({
      row: 77,
      column: 318,
    });
    const window = { row: 650, column: 535, rows: 6, columns: 7 };
    expect(nativeRasterWindowBounds(window)).toEqual([
      395880, 4468800, 396020, 4468920,
    ]);
    expect(
      nativeRasterWindowFromPoints([395880, 4468920], [396020, 4468800]),
    ).toEqual(window);
    expect(
      nativeRasterWindowFromPoints([396020, 4468800], [395880, 4468920]),
    ).toEqual(window);
  });

  it('assigns shared pixel edges consistently and rejects points beyond the half-open footprint', () => {
    expect(nativeRasterPixel(nativeRasterCoordinate(0, 0))).toEqual({
      row: 0,
      column: 0,
    });
    expect(
      nativeRasterPixel(nativeRasterCoordinate(1291.999, 1079.999)),
    ).toEqual({ row: 1291, column: 1079 });
    expect(nativeRasterPixel(nativeRasterCoordinate(77, 318))).toEqual({
      row: 77,
      column: 318,
    });
    for (const point of [
      [406780, 4481920],
      [385180, 4456080],
      [385179, 4481920],
      [385180, 4481921],
      [NaN, 0],
      [0, Infinity],
    ]) {
      expect(() => nativeRasterPixel(point)).toThrow(TypeError);
    }
  });

  it('rejects outside, degenerate and excessive AOIs before any raster read', () => {
    expect(
      nativeRasterWindowFromPoints(
        nativeRasterCoordinate(77.1, 318.1),
        nativeRasterCoordinate(77.9, 318.9),
      ),
    ).toEqual({ row: 77, column: 318, rows: 1, columns: 1 });
    expect(
      nativeRasterWindowFromPoints(
        nativeRasterCoordinate(0, 0),
        nativeRasterCoordinate(64, 64),
      ),
    ).toEqual({ row: 0, column: 0, rows: 64, columns: 64 });
    for (const points of [
      [
        [385180, 4481920],
        [385180, 4481920],
      ],
      [
        [385179, 4481920],
        [385200, 4481900],
      ],
      [nativeRasterCoordinate(0, 0), nativeRasterCoordinate(65, 64)],
      [
        [NaN, 4481920],
        [385200, 4481900],
      ],
    ]) {
      expect(() => nativeRasterWindowFromPoints(points[0], points[1])).toThrow(
        TypeError,
      );
    }
  });

  it('uses WGS84 longitude/latitude and round-trips fixed UTM pixel centers and footprint edges', () => {
    for (const [row, column] of [
      [0, 0],
      [77.5, 318.5],
      [650.5, 535.5],
      [1292, 1080],
    ]) {
      const native = nativeRasterCoordinate(row, column);
      const map = nativeRasterToMap(native);
      expect(map[0]).toBeGreaterThan(115);
      expect(map[0]).toBeLessThan(117);
      expect(map[1]).toBeGreaterThan(40);
      expect(map[1]).toBeLessThan(41);
      const restored = mapToNativeRaster(map);
      expect(restored[0]).toBeCloseTo(native[0], 5);
      expect(restored[1]).toBeCloseTo(native[1], 5);
    }
    expect(
      mapRasterPixel(nativeRasterToMap(nativeRasterCoordinate(77.5, 318.5))),
    ).toEqual({ row: 77, column: 318 });
    expect(() =>
      mapRasterPixel(nativeRasterToMap(nativeRasterCoordinate(1292, 1080))),
    ).toThrow(TypeError);
    for (const coordinate of [
      [NaN, 40],
      [116, Infinity],
      [400, 40],
      [40, 116],
    ]) {
      expect(() => mapToNativeRaster(coordinate)).toThrow(TypeError);
    }
  });

  it('keeps the exact native window as a map polygon and bounds a geographic drag by native integer cells', () => {
    const window = { row: 650, column: 535, rows: 6, columns: 7 };
    const ring = rasterWindowMapRing(window);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    const corners = ring.slice(0, 4);
    for (const corner of corners) {
      const [x, y] = mapToNativeRaster(corner);
      expect([395880, 396020].some((edge) => Math.abs(edge - x) < 1e-5)).toBe(
        true,
      );
      expect([4468800, 4468920].some((edge) => Math.abs(edge - y) < 1e-5)).toBe(
        true,
      );
    }
    const centerA = nativeRasterToMap(nativeRasterCoordinate(650.5, 535.5));
    const centerB = nativeRasterToMap(nativeRasterCoordinate(655.5, 541.5));
    const selected = mapRasterWindowFromBounds([
      Math.min(centerA[0], centerB[0]),
      Math.min(centerA[1], centerB[1]),
      Math.max(centerA[0], centerB[0]),
      Math.max(centerA[1], centerB[1]),
    ]);
    expect(selected).toEqual(window);
    expect(() => mapRasterWindowFromBounds([115, 40, 117, 41])).toThrow(
      TypeError,
    );
    const largeA = nativeRasterToMap(nativeRasterCoordinate(100.5, 100.5)),
      largeB = nativeRasterToMap(nativeRasterCoordinate(164.5, 164.5));
    expect(() =>
      mapRasterWindowFromBounds([
        Math.min(largeA[0], largeB[0]),
        Math.min(largeA[1], largeB[1]),
        Math.max(largeA[0], largeB[0]),
        Math.max(largeA[1], largeB[1]),
      ]),
    ).toThrow(TypeError);
  });

  it('densifies long footprint edges from native coordinates and preserves their boundary on projection back', () => {
    const ring = rasterFootprintMapRing();
    expect(ring.length).toBeGreaterThan(100);
    expect(ring[0]).toEqual(ring.at(-1));
    for (const mapPoint of ring) {
      const [x, y] = mapToNativeRaster(mapPoint);
      expect(
        Math.min(
          Math.abs(x - 385180),
          Math.abs(x - 406780),
          Math.abs(y - 4481920),
          Math.abs(y - 4456080),
        ),
      ).toBeLessThan(1e-5);
    }
  });
});
