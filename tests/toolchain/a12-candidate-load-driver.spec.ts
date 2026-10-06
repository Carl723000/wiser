import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordPageSchema,
} from '../../packages/data-contracts/src/index.ts';
import {
  LOAD_PAGE_BYTES,
  candidateLoadConditions,
  pageFingerprint,
  readFrozenCandidateInput,
  runCandidateLoadCondition,
  summarizeCandidateSamples,
  validateLoadReply,
  type FrozenCandidateDataset,
  type LoadPage,
  type LoadReply,
  type LoadRequest,
  type LoadSample,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '00000000-0000-4000-8000-000000000101',
  processingBatchId: '00000000-0000-4000-8000-000000000102',
  reviewHash: 'a'.repeat(64),
};
const assetId = '00000000-0000-4000-8000-000000000103';
const recordId = '00000000-0000-4000-8000-000000000104';
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const asset = {
  assetId,
  status: 'READY' as const,
  sourceHash: 'b'.repeat(64),
  recordCount: 2,
  featureCount: 1,
  reason: null,
};
const columns = [{ key: '原值', label: '来源原值' }];
const pages = {
  get: {
    reference,
    parserVersion: 'synthetic-fixture-1',
    status: 'READY',
    createdAt: '2026-10-06T00:00:00Z',
    totalAssetCount: 1,
    knownRecordCount: 2,
    knownFeatureCount: 1,
    unknownAssetCount: 0,
    assets: [asset],
    nextCursor: null,
  },
  records: {
    reference,
    assetId,
    columns,
    records: [
      {
        recordId,
        assetId,
        index: 1,
        sourceId: null,
        values: { 原值: null },
        hasGeometry: false,
      },
      {
        recordId: '00000000-0000-4000-8000-000000000105',
        assetId,
        index: 3,
        sourceId: null,
        values: { 原值: '' },
        hasGeometry: true,
      },
    ],
    nextCursor: null,
  },
  geometry: {
    reference,
    assetId,
    crs: 'EPSG:4326',
    features: [
      {
        recordId: '00000000-0000-4000-8000-000000000105',
        assetId,
        index: 3,
        sourceId: null,
        sourceCrs: null,
        geometry: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [116, 40] },
            { type: 'Point', coordinates: [117, 41] },
          ],
        },
      },
    ],
    nextCursor: null,
  },
} satisfies Record<string, LoadPage>;
const frozen = (): FrozenCandidateDataset => ({
  dataset: 'SYNTHETIC-S10',
  provenance: {
    kind: 'standard-intake-http',
    receiptSha256: 'c'.repeat(64),
    inventorySha256: 'd'.repeat(64),
  },
  batch: {
    reference,
    parserVersion: pages.get.parserVersion,
    status: 'READY',
    createdAt: pages.get.createdAt,
    assets: [asset],
  },
  materials: [
    {
      assetId,
      columns,
      recordsDigest: 'e'.repeat(64),
      geometryDigest: 'f'.repeat(64),
    },
  ],
  firstPages: (['get', 'records', 'geometry'] as const).flatMap((action) =>
    ([50, 200] as const).map((first) => ({
      action,
      first,
      assetId: action === 'get' ? null : assetId,
      digest: fingerprint(
        Object.fromEntries(
          Object.entries(pages[action]).filter(([key]) => key !== 'nextCursor'),
        ),
      ),
    })),
  ),
});
const request = (
  action: 'get' | 'records' | 'geometry' = 'records',
): LoadRequest => ({
  method: 'GET',
  action,
  reference,
  first: 50,
  ...(action === 'get' ? {} : { assetId }),
});
const reply = (
  action: 'get' | 'records' | 'geometry' = 'records',
): LoadReply => ({
  boundary: 'api-http',
  status: 200,
  contentType: 'application/json; charset=utf-8',
  wireBytes: 1024,
  body: structuredClone(pages[action]),
});

it('control: synthetic source fixtures already satisfy all existing public contracts', () => {
  expect(IngestionCandidateBatchSchema.safeParse(frozen().batch).success).toBe(
    true,
  );
  expect(IngestionCandidateAssetPageSchema.safeParse(pages.get).success).toBe(
    true,
  );
  expect(
    IngestionCandidateRecordPageSchema.safeParse(pages.records).success,
  ).toBe(true);
  expect(
    IngestionCandidateGeometryPageSchema.safeParse(pages.geometry).success,
  ).toBe(true);
});

it('keeps all 18 capability, first-page and concurrency conditions per dataset separate', () => {
  const conditions = candidateLoadConditions('SYNTHETIC-S10');
  expect(conditions).toHaveLength(18);
  expect(
    new Set(conditions.map((x) => `${x.action}/${x.first}/${x.concurrency}`))
      .size,
  ).toBe(18);
  expect(conditions.every((x) => x.dataset === 'SYNTHETIC-S10')).toBe(true);
});
it('requires a complete standard-intake inventory before issuing requests', () => {
  expect(readFrozenCandidateInput(frozen()).status).toBe('ready');
  const unknown = structuredClone(frozen());
  unknown.batch.assets[0]!.recordCount = null;
  expect(readFrozenCandidateInput(unknown).status).toBe('not_run');
  expect(
    readFrozenCandidateInput({ ...frozen(), provenance: undefined }).status,
  ).toBe('not_run');
});
it('validates real shapes, allows source-index gaps and counts GeometryCollections as one feature', () => {
  for (const action of ['get', 'records', 'geometry'] as const) {
    expect(validateLoadReply(frozen(), request(action), reply(action)).ok).toBe(
      true,
    );
  }
});
it('treats changed batch totals during sampling as a failure, including geometry totals', () => {
  const drift = reply('get');
  (drift.body as typeof pages.get).knownFeatureCount = 0;
  expect(validateLoadReply(frozen(), request('get'), drift)).toEqual({
    ok: false,
    failure: 'drift',
  });
});
it('does not equate BFF POST timing with the public GET API', () => {
  expect(
    validateLoadReply(frozen(), request(), { ...reply(), boundary: 'web-bff' }),
  ).toEqual({ ok: false, failure: 'invalid' });
});
it('retains failures and slow observations in median and nearest-rank p95', () => {
  const samples: LoadSample[] = Array.from({ length: 100 }, (_, i) => ({
    ordinal: i + 1,
    elapsedMs: i + 1,
    outcome: 'completed',
    wireBytes: 10,
    dtoBytes: 10,
  }));
  expect(summarizeCandidateSamples(samples)).toEqual({
    completed: 100,
    failed: 0,
    medianMs: 51,
    p95Ms: 95,
    meetsLatencyTarget: true,
  });
  samples[99] = {
    ordinal: 100,
    elapsedMs: 4000,
    outcome: 'unavailable',
    wireBytes: null,
    dtoBytes: null,
  };
  expect(summarizeCandidateSamples(samples)).toEqual({
    completed: 99,
    failed: 1,
    medianMs: 51,
    p95Ms: 95,
    meetsLatencyTarget: false,
  });
});
it('rejects non-json, oversized wire data, wrong identities, cursor echo and empty continuation', () => {
  const variants: LoadReply[] = [
    { ...reply(), contentType: 'text/html' },
    { ...reply(), wireBytes: LOAD_PAGE_BYTES + 1 },
    { ...reply(), body: { ...pages.records, assetId: reference.ingestionId } },
    { ...reply(), body: { ...pages.records, nextCursor: 'opaque' } },
    {
      ...reply(),
      body: { ...pages.records, records: [], nextCursor: 'another' },
    },
  ];
  for (const variant of variants)
    expect(
      validateLoadReply(frozen(), { ...request(), after: 'opaque' }, variant)
        .ok,
    ).toBe(false);
});
it('omits only signed cursors from the content digest, preserving null and empty original values', () => {
  const cursorChanged = { ...pages.records, nextCursor: 'fresh-signed-cursor' };
  expect(pageFingerprint(cursorChanged, fingerprint)).toBe(
    pageFingerprint(pages.records, fingerprint),
  );
  const contentChanged = structuredClone(pages.records);
  contentChanged.records[0]!.values = { 原值: '' };
  expect(pageFingerprint(contentChanged, fingerprint)).not.toBe(
    pageFingerprint(pages.records, fingerprint),
  );
});
it('runs exactly five warmups and 100 measured requests with bounded concurrency and no substituted retries', async () => {
  let count = 0,
    inflight = 0,
    maximum = 0,
    clock = 0;
  const result = await runCandidateLoadCondition(
    frozen(),
    { dataset: 'SYNTHETIC-S10', action: 'records', first: 50, concurrency: 4 },
    {
      fingerprint,
      now: () => clock++,
      send: async (req) => {
        count++;
        inflight++;
        maximum = Math.max(maximum, inflight);
        await Promise.resolve();
        inflight--;
        expect(req.method).toBe('GET');
        return reply();
      },
    },
  );
  expect(result.status).toBe('passed');
  expect(count).toBe(105);
  expect(result.warmup).toHaveLength(5);
  expect(result.measured).toHaveLength(100);
  expect(maximum).toBe(4);
});
it('preserves a measured transport failure, sanitizes diagnostic output and makes no replacement request', async () => {
  let count = 0,
    clock = 0;
  const secret = 'restricted-sentinel-not-for-report';
  const result = await runCandidateLoadCondition(
    frozen(),
    { dataset: 'SYNTHETIC-S10', action: 'records', first: 50, concurrency: 1 },
    {
      fingerprint,
      now: () => clock++,
      send: async () => {
        count++;
        if (count === 6) throw new Error(secret);
        return reply();
      },
    },
  );
  expect(result.status).toBe('failed');
  expect(result.statistics.completed).toBe(99);
  expect(result.statistics.failed).toBe(1);
  expect(result.measured[0]!.outcome).toBe('unavailable');
  expect(count).toBe(105);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(reference.ingestionId);
  expect(JSON.stringify(result)).not.toContain('来源原值');
});
