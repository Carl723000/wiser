import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';
import type { z } from 'zod';

const schemas = contracts as unknown as Record<string, z.ZodType>;
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id(1),
  reviewHash: 'a'.repeat(64),
  processingBatchId: id(2),
};
const original = {
  assetId: id(3),
  sourceHash: 'b'.repeat(64),
  status: 'UNSUPPORTED',
  recordCount: null,
  featureCount: null,
  reason: 'UNSUPPORTED_FORMAT',
};
const page = {
  reference,
  parserVersion: '1.0.0',
  status: 'PARTIAL',
  createdAt: '2026-10-03T10:00:00Z',
  totalAssetCount: 2,
  knownRecordCount: 1,
  knownFeatureCount: 0,
  unknownAssetCount: 1,
  assets: [original],
  nextCursor: 'bound-cursor',
};

describe('bounded pending candidate HTTP contracts', () => {
  it('registers reads across all transports without impersonating a published version', () => {
    for (const name of ['get', 'records', 'geometry'] as const) {
      const key = `data.ingestion.candidate.${name}`;
      const registry = contracts.DATA_CAPABILITY_REGISTRY as Record<
        string,
        unknown
      >;
      expect(registry[key], `missing ${key}`).toMatchObject({
        id: key,
        kind: 'query',
        requiredScopes: ['data.operation.read'],
        mcpMapping: { toolName: `data_ingestion_candidate_${name}` },
        skillMapping: { operation: key },
      });
    }
    const schema = schemas['IngestionCandidateReadInputSchema'];
    expect(schema).toBeDefined();
    expect(schema!.parse(reference)).toEqual({ ...reference, first: 50 });
    for (const changed of [
      { versionId: id(2) },
      { reviewHash: 'B'.repeat(64) },
      { first: 201 },
      { processingBatchId: undefined },
    ]) {
      expect(schema!.safeParse({ ...reference, ...changed }).success).toBe(
        false,
      );
    }
  });

  it('keeps whole-batch unknown counts separate from the current asset page', () => {
    const schema = schemas['IngestionCandidateAssetPageSchema'];
    expect(schema).toBeDefined();
    expect(schema!.parse(page)).toEqual(page);
    // The page contains only an unsupported original; whole-batch PARTIAL is valid.
    for (const changed of [
      { unknownAssetCount: 3 },
      { knownFeatureCount: 2 },
      { assets: [original, original] },
      { totalAssetCount: 0 },
      { assets: [{ ...original, recordCount: 0 }] },
    ]) {
      expect(schema!.safeParse({ ...page, ...changed }).success).toBe(false);
    }
  });

  it('retains line and polygon source geometry and rejects invented or unbounded coordinates', () => {
    const schema = schemas['IngestionCandidateGeometryPageSchema'];
    expect(schema).toBeDefined();
    const feature = {
      recordId: id(4),
      assetId: id(3),
      index: 1,
      sourceId: 'source/feature:1',
      sourceCrs: 'EPSG:4326',
      geometry: {
        type: 'LineString',
        coordinates: [
          [116, 39],
          [117, 40],
        ],
      },
    };
    const geometryPage = {
      reference,
      assetId: id(3),
      crs: 'EPSG:4326',
      features: [feature],
      nextCursor: null,
    };
    expect(schema!.parse(geometryPage)).toEqual(geometryPage);
    for (const geometry of [
      { type: 'Point', coordinates: [181, 40] },
      { type: 'LineString', coordinates: [[116, 39]] },
      { type: 'Point', coordinates: [116, Number.NaN] },
      {
        type: 'Polygon',
        coordinates: [
          [
            [116, 39],
            [117, 40],
            [116, 40],
          ],
        ],
      },
    ])
      expect(
        schema!.safeParse({
          ...geometryPage,
          features: [{ ...feature, geometry }],
        }).success,
      ).toBe(false);
    expect(
      schema!.safeParse({
        ...geometryPage,
        features: [{ ...feature, assetId: id(9) }],
      }).success,
    ).toBe(false);
    expect(
      schema!.safeParse({ ...geometryPage, crs: 'EPSG:3857' }).success,
    ).toBe(false);
  });
});
