import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordSchema,
  IngestionCandidateRecordPageSchema,
} from '../../packages/data-contracts/src/index.ts';
import {
  CandidateLoadTransportError,
  LOAD_PAGE_BYTES,
  canonicalLoadContent,
  immutableLoadRequest,
  pageFingerprint,
  readFrozenCandidateInput,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import type {
  FrozenCandidateDataset,
  LoadAction,
  LoadPage,
  LoadReply,
  LoadRequest,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import type { CandidateLoadHttpAdapter } from '../../apps/web/e2e-live/support/a12-candidate-load-http.ts';
import {
  createCandidateInventoryCollector,
  type CandidateInventoryCollectorOptions,
} from '../../apps/web/e2e-live/support/a12-candidate-inventory-collector.ts';
import { traversalContentDigest } from '../../apps/web/e2e-live/support/a12-candidate-load-traversal.ts';

const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (ordinal: number): string =>
  `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: uuid(1),
  processingBatchId: uuid(2),
  reviewHash: 'a'.repeat(64),
};
const columns = [
  { key: '原值', label: '来源原值' },
  { key: '状态', label: '原文状态' },
];
// Independent digest oracle, separate from the pending collector implementation.
function expectedDigest(
  action: LoadAction,
  labels: readonly { readonly key: string; readonly label: string }[],
  entries: readonly unknown[],
): string {
  let chain = fingerprint({
    domain: 'a12-traversal-v1',
    action,
    columns: canonicalLoadContent(labels),
  });
  for (const [ordinal, entry] of entries.entries()) {
    chain = fingerprint({
      domain: 'a12-traversal-entry-v1',
      previous: chain,
      ordinal: ordinal + 1,
      entry: canonicalLoadContent(entry),
    });
  }
  return fingerprint({
    domain: 'a12-traversal-end-v1',
    count: entries.length,
    chain,
  });
}
function fixture(pageWidth = 1) {
  // Deliberately reverse UUID order: API order is the frozen source order.
  const assets: FrozenCandidateDataset['batch']['assets'] = [
    {
      assetId: uuid(202),
      status: 'READY',
      sourceHash: '1'.repeat(64),
      recordCount: 3,
      featureCount: 2,
      reason: null,
    },
    {
      assetId: uuid(101),
      status: 'EMPTY',
      sourceHash: '2'.repeat(64),
      recordCount: 0,
      featureCount: 0,
      reason: null,
    },
  ];
  const materials = assets.map((asset, ordinal) => {
    const records = Array.from(
      { length: asset.recordCount ?? 0 },
      (_, offset) => ({
        assetId: asset.assetId,
        recordId: uuid(1000 + ordinal * 10 + offset),
        index: [1, 3, 7][offset]!,
        sourceId: offset === 0 ? 'SOURCE-LOCAL-ROW-1' : null,
        values:
          offset === 0 ? { 原值: null } : offset === 1 ? { 原值: '' } : {},
        hasGeometry: offset > 0,
      }),
    );
    const features = records.slice(1).map((record, offset) => ({
      assetId: asset.assetId,
      recordId: record.recordId,
      index: record.index,
      sourceId: record.sourceId,
      sourceCrs: null,
      geometry:
        offset === 0
          ? {
              type: 'GeometryCollection' as const,
              geometries: [
                { type: 'Point' as const, coordinates: [116, 40] },
                { type: 'Point' as const, coordinates: [117, 41] },
              ],
            }
          : { type: 'Point' as const, coordinates: [118, 42] },
    }));
    return {
      assetId: asset.assetId,
      columns: structuredClone(columns),
      records,
      features,
    };
  });
  const batch: FrozenCandidateDataset['batch'] = {
    reference: structuredClone(reference),
    parserVersion: 'synthetic-inventory-fixture-1',
    status: 'READY',
    createdAt: '2026-10-06T00:00:00Z',
    assets,
  };
  const prepared = assets.map((asset, index) => ({
    assetId: asset.assetId,
    sha256: asset.sourceHash,
    sizeBytes: index + 7,
  }));
  function page(request: LoadRequest): LoadPage {
    const offset =
      request.after === undefined ? 0 : Number(request.after.split(':').at(-1));
    const width = Math.min(pageWidth, request.first);
    const entries =
      request.action === 'get'
        ? assets
        : request.action === 'records'
          ? materials.find((item) => item.assetId === request.assetId)!.records
          : materials.find((item) => item.assetId === request.assetId)!
              .features;
    const nextCursor =
      offset + width < entries.length
        ? `synthetic:${request.action}:${request.assetId ?? 'batch'}:${offset + width}`
        : null;
    if (request.action === 'get')
      return {
        ...batch,
        assets: assets.slice(offset, offset + width),
        totalAssetCount: assets.length,
        knownRecordCount: assets.reduce(
          (sum, asset) => sum + (asset.recordCount ?? 0),
          0,
        ),
        knownFeatureCount: assets.reduce(
          (sum, asset) => sum + (asset.featureCount ?? 0),
          0,
        ),
        unknownAssetCount: assets.filter(
          (asset) => asset.recordCount === null || asset.featureCount === null,
        ).length,
        nextCursor,
      };
    const material = materials.find(
      (item) => item.assetId === request.assetId,
    )!;
    return request.action === 'records'
      ? {
          reference: batch.reference,
          assetId: material.assetId,
          columns: material.columns,
          records: material.records.slice(offset, offset + width),
          nextCursor,
        }
      : {
          reference: batch.reference,
          assetId: material.assetId,
          crs: 'EPSG:4326',
          features: material.features.slice(offset, offset + width),
          nextCursor,
        };
  }
  const requests: LoadRequest[] = [];
  const close = vi.fn();
  type Change = (
    reply: LoadReply,
    request: LoadRequest,
    ordinal: number,
  ) => LoadReply | Promise<LoadReply>;
  function adapter(change?: Change): CandidateLoadHttpAdapter {
    return {
      send: async (request) => {
        requests.push(request);
        const body = structuredClone(page(request));
        const reply: LoadReply = {
          boundary: 'api-http',
          status: 200,
          contentType: 'application/json; charset=utf-8',
          wireBytes: Buffer.byteLength(JSON.stringify(body)),
          body,
        };
        return change ? change(reply, request, requests.length) : reply;
      },
      close,
      diagnostics: () => ({
        activeRequests: 0,
        closed: close.mock.calls.length > 0,
      }),
    };
  }
  const options = (change?: Change): CandidateInventoryCollectorOptions => ({
    dataset: 'SYNTHETIC-S10',
    reference: structuredClone(batch.reference),
    prepared: structuredClone(prepared),
    adapter: adapter(change),
  });
  function expectedInventory() {
    return {
      batch: structuredClone(batch),
      materials: materials.map((material) => ({
        assetId: material.assetId,
        columns: material.columns,
        recordsDigest: expectedDigest(
          'records',
          material.columns,
          material.records,
        ),
        geometryDigest: expectedDigest('geometry', [], material.features),
      })),
      firstPages: (['get', 'records', 'geometry'] as const).flatMap((action) =>
        ([50, 200] as const).flatMap((first) =>
          (action === 'get'
            ? [null]
            : assets.map((asset) => asset.assetId)
          ).map((assetId) => ({
            action,
            first,
            assetId,
            digest: pageFingerprint(
              page(
                immutableLoadRequest({
                  method: 'GET',
                  action,
                  first,
                  reference: batch.reference,
                  ...(assetId === null ? {} : { assetId }),
                }),
              ),
              fingerprint,
            ),
          })),
        ),
      ),
    };
  }
  return {
    assets,
    batch,
    materials,
    prepared,
    page,
    requests,
    close,
    adapter,
    options,
    expectedInventory,
  };
}
async function collect(
  f: ReturnType<typeof fixture>,
  change?: Parameters<typeof f.options>[0],
) {
  const collector = createCandidateInventoryCollector(f.options(change));
  const result = await collector.collect();
  return { collector, result };
}

it('control: synthetic pages, including gap indexes and GeometryCollection, satisfy actual public schemas', () => {
  const f = fixture();
  expect(IngestionCandidateBatchSchema.safeParse(f.batch).success).toBe(true);
  for (const action of ['get', 'records', 'geometry'] as const) {
    for (const first of [50, 200] as const) {
      const request = immutableLoadRequest({
        method: 'GET',
        action,
        first,
        reference,
        ...(action === 'get' ? {} : { assetId: f.assets[0]!.assetId }),
      });
      const schema = {
        get: IngestionCandidateAssetPageSchema,
        records: IngestionCandidateRecordPageSchema,
        geometry: IngestionCandidateGeometryPageSchema,
      }[action];
      expect(schema.safeParse(f.page(request)).success).toBe(true);
    }
  }
  expect(expectedDigest('records', columns, f.materials[0]!.records)).toBe(
    traversalContentDigest(
      'records',
      columns,
      f.materials[0]!.records,
      fingerprint,
    ),
  );
  expect(expectedDigest('geometry', [], f.materials[0]!.features)).toBe(
    traversalContentDigest(
      'geometry',
      [],
      f.materials[0]!.features,
      fingerprint,
    ),
  );
});

it('collects only actual batch, material digests and both first-page sizes, preserving API asset order', async () => {
  const f = fixture();
  const { result, collector } = await collect(f);
  expect(result.status).toBe('collected');
  if (result.status !== 'collected') return;
  expect(Object.keys(result.inventory).sort()).toEqual([
    'batch',
    'firstPages',
    'materials',
  ]);
  expect(result.inventory.batch).toEqual(f.expectedInventory().batch);
  expect(result.inventory.materials).toEqual(f.expectedInventory().materials);
  expect(
    [...result.inventory.firstPages].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  ).toEqual(
    [...f.expectedInventory().firstPages].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  );
  expect(result.inventory.firstPages).toHaveLength(10);
  expect(f.requests.length).toBeGreaterThan(10);
  expect(
    f.requests.every(
      (request) =>
        request.method === 'GET' &&
        [50, 200].includes(request.first) &&
        JSON.stringify(request.reference) === JSON.stringify(reference),
    ),
  ).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(collector.diagnostics()).toEqual({
    activeCollections: 0,
    closed: true,
  });
  expect(JSON.stringify(result)).not.toContain('SOURCE-LOCAL-ROW-1');
  expect(JSON.stringify(result)).not.toContain('coordinates');
  expect(JSON.stringify(result)).not.toContain('verified');
});

it('independently reads first 50 and 200 when their actual material prefixes differ', async () => {
  const f = fixture(200);
  const material = f.materials[0]!;
  const original = material.records[0]!;
  material.records = Array.from({ length: 51 }, (_, offset) => ({
    ...structuredClone(original),
    recordId: uuid(7000 + offset),
    index: offset * 2 + 1,
    sourceId: offset === 0 ? original.sourceId : null,
    values: offset === 0 ? { 原值: null } : offset === 1 ? { 原值: '' } : {},
    hasGeometry: offset === 1 || offset === 2,
  }));
  material.features = material.features.map((feature, offset) => ({
    ...feature,
    recordId: material.records[offset + 1]!.recordId,
    index: material.records[offset + 1]!.index,
  }));
  f.assets[0]!.recordCount = 51;
  const { result } = await collect(f);
  expect(result.status).toBe('collected');
  if (result.status !== 'collected') return;
  for (const page of result.inventory.firstPages) {
    expect(
      f.requests.some(
        (request) =>
          request.action === page.action &&
          request.first === page.first &&
          (request.assetId ?? null) === page.assetId &&
          request.after === undefined,
      ),
    ).toBe(true);
  }
  const actual = result.inventory.firstPages.filter(
    (page) =>
      page.action === 'records' && page.assetId === f.assets[0]!.assetId,
  );
  expect(actual).toHaveLength(2);
  const small = actual.find((page) => page.first === 50)!;
  const large = actual.find((page) => page.first === 200)!;
  expect(small.digest).not.toBe(large.digest);
  expect(small.digest).toBe(
    pageFingerprint(
      f.page(
        immutableLoadRequest({
          method: 'GET',
          action: 'records',
          first: 50,
          reference,
          assetId: f.assets[0]!.assetId,
        }),
      ),
      fingerprint,
    ),
  );
  expect(large.digest).toBe(
    pageFingerprint(
      f.page(
        immutableLoadRequest({
          method: 'GET',
          action: 'records',
          first: 200,
          reference,
          assetId: f.assets[0]!.assetId,
        }),
      ),
      fingerprint,
    ),
  );
  expect(result.inventory.materials).toEqual(f.expectedInventory().materials);
});

it('content digests do not depend on legal page boundaries; first-page fingerprints do', async () => {
  const one = await collect(fixture(1));
  const two = await collect(fixture(2));
  expect(one.result.status).toBe('collected');
  expect(two.result.status).toBe('collected');
  if (one.result.status !== 'collected' || two.result.status !== 'collected')
    return;
  expect(one.result.inventory.materials).toEqual(
    two.result.inventory.materials,
  );
  expect(one.result.inventory.batch).toEqual(two.result.inventory.batch);
  expect(one.result.inventory.firstPages).not.toEqual(
    two.result.inventory.firstPages,
  );
});

it('does not sort by prepared order or UUID, and freezes the returned source-local inventory', async () => {
  const f = fixture();
  const input = f.options();
  const collector = createCandidateInventoryCollector({
    ...input,
    prepared: [...input.prepared].reverse(),
  });
  const result = await collector.collect();
  expect(result.status).toBe('collected');
  if (result.status !== 'collected') return;
  expect(result.inventory.batch.assets.map((asset) => asset.assetId)).toEqual([
    uuid(202),
    uuid(101),
  ]);
  expect(Object.isFrozen(result.inventory)).toBe(true);
  expect(Object.isFrozen(result.inventory.batch.assets)).toBe(true);
  expect(Object.isFrozen(result.inventory.materials[0]!.columns[0])).toBe(true);
});

it('keeps missing, null, empty strings, source IDs, gap indexes, ordered columns and one GeometryCollection', async () => {
  const f = fixture();
  const { result } = await collect(f);
  expect(result.status).toBe('collected');
  if (result.status !== 'collected') return;
  expect(result.inventory.materials[0]!.recordsDigest).toBe(
    expectedDigest('records', columns, f.materials[0]!.records),
  );
  expect(result.inventory.materials[0]!.geometryDigest).toBe(
    expectedDigest('geometry', [], f.materials[0]!.features),
  );
  expect(result.inventory.batch.assets[0]!.featureCount).toBe(2);
  expect(result.inventory.batch.assets[1]!.recordCount).toBe(0);
  const changed = structuredClone(f.materials[0]!.records);
  changed[2]!.values = { 原值: null };
  expect(result.inventory.materials[0]!.recordsDigest).not.toBe(
    expectedDigest('records', columns, changed),
  );
  expect(result.inventory.materials[0]!.recordsDigest).not.toBe(
    expectedDigest('records', [...columns].reverse(), f.materials[0]!.records),
  );
});

it('collects a count-known PARTIAL batch without changing status or granting the formal READY gate', async () => {
  const f = fixture();
  f.batch.status = 'PARTIAL';
  f.assets[0]!.status = 'PARTIAL';
  f.assets[0]!.reason = 'LOCATION_UNKNOWN';
  expect(IngestionCandidateBatchSchema.safeParse(f.batch).success).toBe(true);
  const { result } = await collect(f);
  expect(result.status).toBe('collected');
  if (result.status !== 'collected') return;
  expect(result.inventory.batch.status).toBe('PARTIAL');
  expect(result.inventory.batch.assets[0]!.status).toBe('PARTIAL');
  expect(
    readFrozenCandidateInput({
      dataset: 'SYNTHETIC-S10',
      provenance: {
        kind: 'standard-intake-http',
        receiptSha256: 'c'.repeat(64),
        inventorySha256: 'd'.repeat(64),
      },
      ...result.inventory,
    }),
  ).toEqual({ status: 'not_run', reason: 'incomplete_inventory' });
});

it('unknown counts remain not_run and are never filled with zero or followed by material reads', async () => {
  const f = fixture();
  f.batch.status = 'PARTIAL';
  Object.assign(f.assets[1]!, {
    status: 'UNSUPPORTED',
    recordCount: null,
    featureCount: null,
    reason: 'FORMAT_NOT_SUPPORTED',
  });
  expect(IngestionCandidateBatchSchema.safeParse(f.batch).success).toBe(true);
  const { result } = await collect(f);
  expect(result).toEqual({ status: 'not_run', reason: 'incomplete_inventory' });
  expect(f.requests.length).toBeGreaterThan(0);
  expect(f.requests.every((request) => request.action === 'get')).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'extra', 'hash'] as const)(
  'prepared %s mismatch fails the bidirectional actual asset check',
  async (change) => {
    const f = fixture();
    const input = f.options();
    const prepared = input.prepared.map((asset) => ({ ...asset }));
    if (change === 'missing') prepared.pop();
    if (change === 'extra')
      prepared.push({
        assetId: uuid(303),
        sha256: '3'.repeat(64),
        sizeBytes: 9,
      });
    if (change === 'hash') prepared[0]!.sha256 = 'f'.repeat(64);
    const collector = createCandidateInventoryCollector({ ...input, prepared });
    expect(await collector.collect()).toEqual({
      status: 'not_run',
      reason: 'drift',
    });
    expect(f.requests.every((request) => request.action === 'get')).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
  },
);

it.each([
  'parserVersion',
  'createdAt',
  'status',
  'totalAssetCount',
  'knownRecordCount',
  'knownFeatureCount',
  'unknownAssetCount',
] as const)('rejects %s drift across actual get pages', async (field) => {
  const f = fixture();
  const { result } = await collect(f, (reply, request) => {
    if (request.action === 'get' && request.after !== undefined) {
      const body = reply.body as Record<string, unknown>;
      body[field] =
        field === 'parserVersion'
          ? 'other-parser'
          : field === 'createdAt'
            ? '2026-10-07T00:00:00Z'
            : field === 'status'
              ? 'PARTIAL'
              : (body[field] as number) + 1;
    }
    return reply;
  });
  expect(result).toEqual({ status: 'not_run', reason: 'drift' });
  expect(f.close).toHaveBeenCalledTimes(1);
});

it.each(['recordCount', 'featureCount'] as const)(
  'rejects declared %s exceeding the actual index bound before material reads',
  async (field) => {
    const f = fixture();
    f.assets[0]![field] = 2_000_001;
    if (field === 'featureCount') f.assets[0]!.recordCount = 2_000_001;
    expect(IngestionCandidateBatchSchema.safeParse(f.batch).success).toBe(true);
    const { result } = await collect(f);
    expect(result).toEqual({ status: 'not_run', reason: 'invalid' });
    expect(f.requests.every((request) => request.action === 'get')).toBe(true);
  },
);

it.each(['knownRecordCount', 'knownFeatureCount'] as const)(
  'rejects stable but false %s totals before reading any material',
  async (field) => {
    const f = fixture();
    const { result } = await collect(f, (reply, request) => {
      if (request.action === 'get') {
        const body = reply.body as Record<string, unknown>;
        body[field] = (body[field] as number) + 1;
        expect(IngestionCandidateAssetPageSchema.safeParse(body).success).toBe(
          true,
        );
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'drift' });
    expect(f.requests.every((request) => request.action === 'get')).toBe(true);
  },
);

it.each(['get', 'records', 'geometry'] as const)(
  'rejects repeated asset or record identities in %s across separately valid pages',
  async (action) => {
    const f = fixture();
    const { result } = await collect(f, (reply, request) => {
      if (request.action !== action || request.after === undefined)
        return reply;
      if (action === 'get') {
        const body = reply.body as { assets: unknown[] };
        body.assets = [structuredClone(f.assets[0])];
      } else {
        const body = reply.body as {
          records?: { recordId: string }[];
          features?: { recordId: string }[];
        };
        const entries = body.records ?? body.features!;
        entries[0]!.recordId =
          action === 'records'
            ? f.materials[0]!.records[0]!.recordId
            : f.materials[0]!.features[0]!.recordId;
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'invalid' });
  },
);

it.each(['records', 'geometry'] as const)(
  'rejects decreasing %s indexes across separately valid pages',
  async (action) => {
    const f = fixture();
    const { result } = await collect(f, (reply, request) => {
      if (request.action === action && request.after !== undefined) {
        const body = reply.body as {
          records?: { index: number }[];
          features?: { index: number }[];
        };
        (body.records ?? body.features!)[0]!.index = 1;
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'invalid' });
  },
);

it.each(['key', 'label', 'order'] as const)(
  'rejects ordered columns %s drift across record pages',
  async (field) => {
    const f = fixture();
    const { result } = await collect(f, (reply, request) => {
      if (request.action === 'records' && request.after !== undefined) {
        const body = reply.body as { columns: typeof columns };
        if (field === 'order') body.columns.reverse();
        else body.columns[1]![field] = 'another-column';
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'drift' });
  },
);

it.each(['records', 'geometry'] as const)(
  'rejects %s totals smaller than declared without substituting an observed count',
  async (action) => {
    const f = fixture();
    const { result } = await collect(f, (reply, request) => {
      if (
        request.action === action &&
        request.assetId === f.assets[0]!.assetId &&
        request.after === undefined
      ) {
        (reply.body as { nextCursor: string | null }).nextCursor = null;
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'drift' });
  },
);

it.each(['get', 'records', 'geometry'] as const)(
  'rejects %s empty continuation pages',
  async (action) => {
    const f = fixture();
    const { result } = await collect(f, (reply, request) => {
      if (request.action === action && request.after !== undefined) {
        const body = reply.body as Record<string, unknown>;
        body[
          action === 'get'
            ? 'assets'
            : action === 'records'
              ? 'records'
              : 'features'
        ] = [];
        body['nextCursor'] = 'synthetic:another:1';
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'invalid' });
  },
);

it.each(['echo', 'cycle', 'overlong', 'after-count'] as const)(
  'rejects %s cursor instead of unbounded reads',
  async (change) => {
    const f = fixture();
    if (change === 'cycle') {
      f.materials[0]!.records.push({
        ...structuredClone(f.materials[0]!.records[2]!),
        recordId: uuid(1020),
        index: 9,
        hasGeometry: false,
      });
      f.assets[0]!.recordCount = 4;
    }
    const { result } = await collect(f, (reply, request) => {
      if (
        request.action === 'records' &&
        request.assetId === f.assets[0]!.assetId
      ) {
        const body = reply.body as { nextCursor: string | null };
        if (change === 'echo' && request.after !== undefined)
          body.nextCursor = request.after;
        if (change === 'cycle' && request.after?.endsWith(':2'))
          body.nextCursor = `synthetic:records:${f.assets[0]!.assetId}:1`;
        if (change === 'overlong') body.nextCursor = 'x'.repeat(2049);
        if (change === 'after-count' && request.after?.endsWith(':2'))
          body.nextCursor = 'synthetic:records:extra:3';
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'invalid' });
    expect(f.requests.length).toBeLessThan(20);
  },
);

it('rejects a foreign asset, a changed fixed candidate reference, and unsupported geometry CRS', async () => {
  for (const field of ['assetId', 'reference', 'crs'] as const) {
    const f = fixture();
    const { result } = await collect(f, (reply, request) => {
      if (
        request.action === 'geometry' &&
        request.assetId === f.assets[0]!.assetId
      ) {
        const body = reply.body as Record<string, unknown>;
        body[field] =
          field === 'assetId'
            ? uuid(999)
            : field === 'reference'
              ? { ...reference, reviewHash: 'b'.repeat(64) }
              : 'EPSG:3857';
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'invalid' });
  }
});

it('rejects content changes in the independently requested first-50 prefix', async () => {
  const f = fixture();
  const { result } = await collect(f, (reply, request) => {
    if (
      request.action === 'records' &&
      request.first === 50 &&
      request.assetId === f.assets[0]!.assetId
    ) {
      (
        reply.body as { records: { values: Record<string, unknown> }[] }
      ).records[0]!.values = { 原值: 'changed-original' };
    }
    return reply;
  });
  expect(result).toEqual({ status: 'not_run', reason: 'drift' });
});

it.each(['wire', 'dto', 'content-type', 'boundary'] as const)(
  'retains the 3 MiB and HTTP envelope guard for %s',
  async (field) => {
    const f = fixture(field === 'dto' ? 200 : 1);
    if (field === 'dto') {
      const material = f.materials[0]!;
      const original = material.records[0]!;
      material.records = Array.from({ length: 14 }, (_, offset) => ({
        ...structuredClone(original),
        recordId: uuid(4000 + offset),
        index: offset + 1,
        values: { 原值: 'x'.repeat(230_000) },
      }));
      f.assets[0]!.recordCount = 14;
      expect(
        material.records.every(
          (record) => IngestionCandidateRecordSchema.safeParse(record).success,
        ),
      ).toBe(true);
    }
    const { result } = await collect(f, (reply, request) => {
      if (field === 'wire') return { ...reply, wireBytes: LOAD_PAGE_BYTES + 1 };
      if (field === 'content-type')
        return { ...reply, contentType: 'text/html' };
      if (field === 'boundary') return { ...reply, boundary: 'web-bff' };
      if (
        field === 'dto' &&
        request.action === 'records' &&
        request.assetId === f.assets[0]!.assetId
      ) {
        // Synthetic declared transport bytes stay small so the DTO budget itself
        // must reject 14 individually schema-valid original rows.
        return { ...reply, wireBytes: 1000 };
      }
      return reply;
    });
    expect(result).toEqual({ status: 'not_run', reason: 'invalid' });
  },
);

it.each([
  [401, 'denied'],
  [403, 'denied'],
  [404, 'stale'],
  [409, 'stale'],
  [410, 'stale'],
  [413, 'invalid'],
  [415, 'invalid'],
  [422, 'invalid'],
  [500, 'unavailable'],
] as const)(
  'classifies status %s without reading or retaining a sensitive response body',
  async (status, reason) => {
    const f = fixture();
    let bodyReads = 0;
    const { result } = await collect(f, (reply) => {
      const response = { ...reply, status };
      Object.defineProperty(response, 'body', {
        get: () => {
          bodyReads += 1;
          throw new Error('SECRET-ERROR-BODY');
        },
      });
      return response;
    });
    expect(result).toEqual({ status: 'not_run', reason });
    expect(bodyReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  },
);

it('snapshots reference and prepared inputs before awaiting the first GET and freezes transport requests', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const input = f.options(async (reply, request, ordinal) => {
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.reference)).toBe(true);
    if (ordinal === 1) await hold;
    return reply;
  });
  const collector = createCandidateInventoryCollector(input);
  const pending = collector.collect();
  (input.reference as { reviewHash: string }).reviewHash = 'e'.repeat(64);
  (input.prepared[0] as { sha256: string }).sha256 = 'f'.repeat(64);
  release!();
  const result = await pending;
  expect(result.status).toBe('collected');
  if (result.status !== 'collected') return;
  expect(result.inventory.batch.reference).toEqual(reference);
  expect(
    f.requests.every(
      (request) => request.reference.reviewHash === reference.reviewHash,
    ),
  ).toBe(true);
});

it.each(['options', 'reference', 'prepared', 'asset', 'adapter'] as const)(
  'rejects %s accessors before evaluating them',
  (where) => {
    const f = fixture();
    const input = f.options();
    let getterCalls = 0;
    const target =
      where === 'options'
        ? input
        : where === 'reference'
          ? input.reference
          : where === 'prepared'
            ? input.prepared
            : where === 'asset'
              ? input.prepared[0]!
              : input.adapter;
    const key =
      where === 'options'
        ? 'dataset'
        : where === 'reference'
          ? 'reviewHash'
          : where === 'prepared'
            ? '0'
            : where === 'asset'
              ? 'sha256'
              : 'send';
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('SECRET-CONFIG-ACCESSOR');
      },
    });
    expect(() => createCandidateInventoryCollector(input)).toThrow(
      CandidateLoadTransportError,
    );
    expect(getterCalls).toBe(0);
    expect(f.requests).toHaveLength(0);
    expect(f.close).not.toHaveBeenCalled();
  },
);

it.each([
  'dataset',
  'empty',
  'duplicate',
  'hash',
  'size',
  'reference',
  'caller-inventory',
] as const)(
  'rejects malformed %s configuration and cannot accept a caller-built final inventory',
  (field) => {
    const f = fixture();
    const input = f.options();
    const malformed: Record<string, unknown> = { ...input };
    if (field === 'dataset') malformed['dataset'] = 'CALLER-APPROVED';
    if (field === 'empty') malformed['prepared'] = [];
    if (field === 'duplicate')
      malformed['prepared'] = [input.prepared[0], input.prepared[0]];
    if (field === 'hash')
      malformed['prepared'] = [{ ...input.prepared[0], sha256: 'bad' }];
    if (field === 'size')
      malformed['prepared'] = [{ ...input.prepared[0], sizeBytes: 0 }];
    if (field === 'reference')
      malformed['reference'] = { ...reference, ingestionId: 'bad' };
    if (field === 'caller-inventory')
      malformed['inventory'] = f.expectedInventory();
    expect(() =>
      createCandidateInventoryCollector(
        malformed as unknown as CandidateInventoryCollectorOptions,
      ),
    ).toThrow(CandidateLoadTransportError);
    expect(f.requests).toHaveLength(0);
    expect(f.close).not.toHaveBeenCalled();
  },
);

it('uses the native abort state without evaluating a caller-owned aborted accessor', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  let getterCalls = 0;
  Object.defineProperty(controller.signal, 'aborted', {
    get: () => {
      getterCalls += 1;
      return false;
    },
  });
  const collector = createCandidateInventoryCollector({
    ...f.options(),
    signal: controller.signal,
  });
  expect(await collector.collect()).toEqual({
    status: 'not_run',
    reason: 'cancelled',
  });
  expect(getterCalls).toBe(0);
  expect(f.requests).toHaveLength(0);
  expect(f.close).toHaveBeenCalledTimes(1);
});

it.each(['abort', 'close'] as const)(
  'settles %s while an adapter promise is pending, ignores its late reply and closes only its own adapter',
  async (action) => {
    const f = fixture();
    const controller = new AbortController();
    let resolveLate: ((reply: LoadReply) => void) | undefined;
    const pendingReply = new Promise<LoadReply>((resolve) => {
      resolveLate = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const other = fixture().adapter();
    const otherClose = vi.spyOn(other, 'close');
    const collector = createCandidateInventoryCollector({
      ...f.options(() => {
        markStarted!();
        return pendingReply;
      }),
      signal: controller.signal,
    });
    const pending = collector.collect();
    // An explicit handshake distinguishes a pending read from a stub which
    // settles without dispatch. It also permits valid microtask scheduling.
    const phase = await Promise.race([
      started.then(() => 'started'),
      pending.then(() => 'settled-before-start'),
    ]);
    expect(phase).toBe('started');
    if (action === 'abort') controller.abort();
    else collector.close();
    expect(await pending).toEqual({ status: 'not_run', reason: 'cancelled' });
    expect(f.requests).toHaveLength(1);
    resolveLate!({
      boundary: 'api-http',
      status: 200,
      contentType: 'application/json',
      wireBytes: 1,
      body: {},
    });
    await Promise.resolve();
    expect(f.requests).toHaveLength(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(otherClose).not.toHaveBeenCalled();
    expect(collector.diagnostics()).toEqual({
      activeCollections: 0,
      closed: true,
    });
  },
);

it('reuses one collection promise and never starts additional GETs after terminal close', async () => {
  const f = fixture();
  const collector = createCandidateInventoryCollector(f.options());
  const first = collector.collect();
  const second = collector.collect();
  expect(first).toBe(second);
  expect((await first).status).toBe('collected');
  const count = f.requests.length;
  collector.close();
  collector.close();
  expect(await collector.collect()).toEqual(await first);
  expect(f.requests).toHaveLength(count);
  expect(f.close).toHaveBeenCalledTimes(1);
});

it.each(['denied', 'stale', 'cancelled', 'unavailable'] as const)(
  'cleanup cannot replace the first %s cause or leak exception text',
  async (cause) => {
    const f = fixture();
    const input = f.options(() => {
      throw cause === 'unavailable'
        ? new Error('SECRET-TRANSPORT-PAYLOAD')
        : new CandidateLoadTransportError(cause);
    });
    const adapter = {
      ...input.adapter,
      close: vi.fn(() => {
        throw new Error('SECRET-CLEANUP-PAYLOAD');
      }),
    };
    const collector = createCandidateInventoryCollector({ ...input, adapter });
    const result = await collector.collect();
    expect(result).toEqual({ status: 'not_run', reason: cause });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(adapter.close).toHaveBeenCalledTimes(1);
    expect(collector.diagnostics()).toEqual({
      activeCollections: 0,
      closed: true,
    });
  },
);

it('does not claim collection success if its own terminal cleanup fails', async () => {
  const f = fixture();
  const input = f.options();
  const adapter = {
    ...input.adapter,
    close: vi.fn(() => {
      throw new Error('SECRET-CLEANUP-ONLY');
    }),
  };
  const collector = createCandidateInventoryCollector({ ...input, adapter });
  const result = await collector.collect();
  expect(result).toEqual({ status: 'not_run', reason: 'unavailable' });
  expect(adapter.close).toHaveBeenCalledTimes(1);
  expect(collector.diagnostics()).toEqual({
    activeCollections: 0,
    closed: true,
  });
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
