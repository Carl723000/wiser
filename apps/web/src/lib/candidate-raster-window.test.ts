import { describe, expect, it } from 'vitest';
import {
  RETAINED_RASTER_HASHES,
  validateRasterSelection,
  decodeCandidateRasterWindow,
  sclQualityMask,
} from './candidate-raster-window';

const BANDS = ['B03', 'B8A', 'SCL', 'TCI'] as const;
const window = { row: 77, column: 318, rows: 7, columns: 9 };

describe('fixed native GeoTIFF candidate windows', () => {
  it('keeps four exact original hashes and rejects an unknown mask or source', () => {
    expect(Object.keys(RETAINED_RASTER_HASHES).sort()).toEqual(
      [...BANDS].sort(),
    );
    expect(() =>
      validateRasterSelection({
        window,
        quality: { kind: 'raw' },
        bands: BANDS,
      }),
    ).not.toThrow();
    expect(() =>
      validateRasterSelection({
        window,
        quality: { kind: 'raw' },
        bands: ['B03', 'B03', 'SCL', 'TCI'],
      }),
    ).toThrow();
    expect(() =>
      validateRasterSelection({
        window,
        quality: { kind: 'unknown' },
        bands: BANDS,
      }),
    ).toThrow();
  });

  it('bounds native integer rectangles, including zero and edge coordinates', () => {
    expect(() =>
      validateRasterSelection({
        window: { row: 0, column: 0, rows: 1, columns: 1 },
        quality: { kind: 'raw' },
        bands: BANDS,
      }),
    ).not.toThrow();
    expect(() =>
      validateRasterSelection({
        window: { row: 1291, column: 1079, rows: 1, columns: 1 },
        quality: { kind: 'raw' },
        bands: BANDS,
      }),
    ).not.toThrow();
    for (const rejected of [
      { row: -1, column: 0, rows: 1, columns: 1 },
      { row: 0.5, column: 0, rows: 1, columns: 1 },
      { row: 0, column: 0, rows: 65, columns: 64 },
      { row: 1291, column: 1079, rows: 2, columns: 1 },
      { row: 0, column: 0, rows: 0, columns: 1 },
    ])
      expect(() =>
        validateRasterSelection({
          window: rejected,
          quality: { kind: 'raw' },
          bands: BANDS,
        }),
      ).toThrow();
  });

  it('requires a declared SCL policy and keeps SCL class zero distinct from missing', () => {
    expect(() =>
      validateRasterSelection({
        window,
        quality: {
          kind: 'scl-classes',
          allowedClasses: [0, 4],
          ruleVersion: 'scl-test-v1',
        },
        bands: BANDS,
      }),
    ).not.toThrow();
    expect(() =>
      validateRasterSelection({
        window,
        quality: { kind: 'scl-classes', allowedClasses: [4] },
        bands: BANDS,
      }),
    ).toThrow();
    expect(() =>
      validateRasterSelection({
        window,
        quality: {
          kind: 'scl-classes',
          allowedClasses: [12],
          ruleVersion: 'scl-test-v1',
        },
        bands: BANDS,
      }),
    ).toThrow();
    expect(
      Array.from(
        sclQualityMask(Uint8Array.of(0, 4, 11), {
          kind: 'scl-classes',
          allowedClasses: [0, 4],
          ruleVersion: 'scl-test-v1',
        }),
      ),
    ).toEqual([1, 1, 0]);
  });

  it.runIf(Boolean(process.env.WISER_RETAINED_RASTER_DIR))(
    'decodes two non-preset rectangles from each retained TIFF against independently read Rasterio pixels',
    async () => {
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const directory = process.env.WISER_RETAINED_RASTER_DIR!;
      const names = {
        B03: 'b03-20m-native-window.tif',
        B8A: 'b8a-20m-native-window.tif',
        SCL: 'scl-20m-native-window.tif',
        TCI: 'tci-20m-native-window.tif',
      } as const;
      const assets = await Promise.all(
        BANDS.map(async (band) => {
          const bytes = await readFile(path.join(directory, names[band]));
          return {
            band,
            sha256: RETAINED_RASTER_HASHES[band],
            bytes: Uint8Array.from(bytes).buffer,
          };
        }),
      );
      for (const nativeWindow of [
        window,
        { row: 650, column: 535, rows: 19, columns: 23 },
      ]) {
        const decoded = await decodeCandidateRasterWindow({
          assets,
          window: nativeWindow,
          quality: { kind: 'raw' },
        });
        expect(decoded.window).toEqual(nativeWindow);
        expect(decoded.crs).toBe('EPSG:32650');
        expect(decoded.validMask).toHaveLength(
          nativeWindow.rows * nativeWindow.columns,
        );
        expect(decoded.values.B03).toHaveLength(
          nativeWindow.rows * nativeWindow.columns,
        );
        expect(decoded.values.TCI).toHaveLength(3);
        const first = nativeWindow.row === 77;
        const bands = [
          decoded.values.B03,
          decoded.values.B8A,
          decoded.values.SCL,
          ...decoded.values.TCI,
        ];
        const expectedFirst = first
          ? [1415, 4036, 4, 28, 41, 31]
          : [1713, 1204, 6, 43, 72, 45];
        const expectedLast = first
          ? [1396, 4758, 4, 26, 41, 25]
          : [1712, 1154, 6, 40, 73, 42];
        const expectedSums = first
          ? [88669, 291022, 252, 1681, 2632, 1751]
          : [744859, 515607, 2622, 17809, 31473, 18667];
        bands.forEach((band, index) => {
          expect(band[0]).toBe(expectedFirst[index]);
          expect(band.at(-1)).toBe(expectedLast[index]);
          expect(Array.from(band).reduce((sum, value) => sum + value, 0)).toBe(
            expectedSums[index],
          );
        });
      }
    },
  );
});
