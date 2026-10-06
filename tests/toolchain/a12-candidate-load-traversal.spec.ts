import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordPageSchema,
} from '../../packages/data-contracts/src/index.ts';
import type {
  FrozenCandidateDataset,
  LoadAction,
  LoadPage,
  LoadPorts,
  LoadReply,
  LoadRequest,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import {
  runCandidateLoadTraversal,
  traversalContentDigest,
} from '../../apps/web/e2e-live/support/a12-candidate-load-traversal.ts';

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
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
// Independent fixture oracle; does not call the pending production helper.
function expectedDigest(
  action: LoadAction,
  labels: readonly { readonly key: string; readonly label: string }[],
  entries: readonly unknown[],
): string {
  let chain = fingerprint({ domain: 'a12-traversal-v1', action, columns: labels });
  for (const [index, entry] of entries.entries()) {
    chain = fingerprint({
      domain: 'a12-traversal-entry-v1',
      previous: chain,
      ordinal: index + 1,
      entry: canonical(entry),
    });
  }
  return fingerprint({ domain: 'a12-traversal-end-v1', count: entries.length, chain });
}
function fixture() {
  const assets = [0, 1].map((ordinal) => ({
    assetId: uuid(100 + ordinal),
    status: 'READY' as const,
    sourceHash: String(ordinal + 1).repeat(64),
    recordCount: 3,
    featureCount: 2,
    reason: null,
  }));
  const materials = assets.map((asset, ordinal) => {
    const records = [1, 3, 7].map((index, offset) => ({
      assetId: asset.assetId,
      recordId: uuid(1000 + ordinal * 10 + offset),
      index,
      sourceId: null,
      values: offset === 0 ? { 原值: null } : offset === 1 ? { 原值: '' } : {},
      hasGeometry: offset > 0,
    }));
    const features = records.slice(1).map((record, offset) => ({
      assetId: asset.assetId,
      recordId: record.recordId,
      index: record.index,
      sourceId: null,
      sourceCrs: null,
      geometry: offset === 0
        ? { type: 'GeometryCollection' as const, geometries: [
          { type: 'Point' as const, coordinates: [116, 40] },
          { type: 'Point' as const, coordinates: [117, 41] },
        ] }
        : { type: 'Point' as const, coordinates: [118, 42] },
    }));
    return { assetId: asset.assetId, columns, records, features };
  });
  const batch: FrozenCandidateDataset['batch'] = {
    reference,
    parserVersion: 'synthetic-traversal-fixture-1',
    status: 'READY',
    createdAt: '2026-10-06T00:00:00Z',
    assets,
  };
  const getPage = (offset: number): LoadPage => ({
    ...batch,
    totalAssetCount: assets.length,
    knownRecordCount: 6,
    knownFeatureCount: 4,
    unknownAssetCount: 0,
    assets: assets.slice(offset, offset + 1),
    nextCursor: offset + 1 < assets.length ? `private-get-${offset + 1}` : null,
  });
  const materialPage = (action: 'records' | 'geometry', assetId: string, offset: number): LoadPage => {
    const material = materials.find((x) => x.assetId === assetId)!;
    const entries = action === 'records' ? material.records : material.features;
    const nextCursor = offset + 1 < entries.length ? `private-${action}-${offset + 1}` : null;
    return action === 'records'
      ? { reference, assetId, columns: material.columns, records: material.records.slice(offset, offset + 1), nextCursor }
      : { reference, assetId, crs: 'EPSG:4326', features: material.features.slice(offset, offset + 1), nextCursor };
  };
  const frozen: FrozenCandidateDataset = {
    dataset: 'SYNTHETIC-S10',
    provenance: { kind: 'standard-intake-http', receiptSha256: 'c'.repeat(64), inventorySha256: 'd'.repeat(64) },
    batch,
    materials: materials.map((material) => ({
      assetId: material.assetId,
      columns,
      recordsDigest: expectedDigest('records', columns, material.records),
      geometryDigest: expectedDigest('geometry', [], material.features),
    })),
    firstPages: (['get', 'records', 'geometry'] as const).flatMap((action) =>
      ([50, 200] as const).flatMap((first) =>
        (action === 'get' ? [null] : assets.map((asset) => asset.assetId)).map((assetId) => {
          const page = action === 'get' ? getPage(0) : materialPage(action, assetId!, 0);
          return { action, first, assetId, digest: fingerprint(Object.fromEntries(Object.entries(page).filter(([key]) => key !== 'nextCursor'))) };
        }),
      ),
    ),
  };
  const requests: LoadRequest[] = [];
  let iteration = 0;
  const reply = (request: LoadRequest): LoadReply => {
    const offset = request.after === undefined ? 0 : Number(request.after.split('-').at(-1));
    const page = request.action === 'get' ? getPage(offset) : materialPage(request.action, request.assetId!, offset);
    return { boundary: 'api-http', status: 200, contentType: 'application/json', wireBytes: 1000, body: structuredClone(page) };
  };
  const ports = (change?: (response: LoadReply, request: LoadRequest, round: number) => LoadReply): LoadPorts => ({
    now: () => 0,
    fingerprint,
    send: async (request) => {
      requests.push(request);
      if (request.action === 'get' && request.after === undefined) iteration += 1;
      const response = reply(request);
      return change?.(response, request, iteration) ?? response;
    },
  });
  return { frozen, assets, materials, getPage, materialPage, ports, requests };
}

it('control: all synthetic traversal pages and batch satisfy public candidate schemas', () => {
  const f = fixture();
  expect(IngestionCandidateBatchSchema.safeParse(f.frozen.batch).success).toBe(true);
  expect(IngestionCandidateAssetPageSchema.safeParse(f.getPage(0)).success).toBe(true);
  expect(IngestionCandidateRecordPageSchema.safeParse(f.materialPage('records', f.assets[0]!.assetId, 0)).success).toBe(true);
  expect(IngestionCandidateGeometryPageSchema.safeParse(f.materialPage('geometry', f.assets[0]!.assetId, 0)).success).toBe(true);
});
it('defines the reusable ordered full-content SHA256 chain without retaining entries', () => {
  const entries = fixture().materials[0]!.records;
  expect(traversalContentDigest('records', columns, entries, fingerprint)).toBe(expectedDigest('records', columns, entries));
});
it('distinguishes missing, null, empty values and ordered column labels', () => {
  const entries = fixture().materials[0]!.records;
  const base = traversalContentDigest('records', columns, entries, fingerprint);
  const missingChanged = structuredClone(entries);
  missingChanged[2]!.values = { 原值: null };
  expect(traversalContentDigest('records', columns, missingChanged, fingerprint)).not.toBe(base);
  const emptyChanged = structuredClone(entries);
  emptyChanged[1]!.values = { 原值: null };
  expect(traversalContentDigest('records', columns, emptyChanged, fingerprint)).not.toBe(base);
  expect(traversalContentDigest('records', [...columns].reverse(), entries, fingerprint)).not.toBe(base);
  expect(traversalContentDigest('records', [{...columns[0]!, label:'不同标签'}, columns[1]!], entries, fingerprint)).not.toBe(base);
});
it('canonicalizes object keys while preserving arrays and original index gaps', () => {
  const left = [{ index: 7, values: { 状态: '', 原值: null }, assetId: uuid(100) }];
  const right = [{ assetId: uuid(100), values: { 原值: null, 状态: '' }, index: 7 }];
  expect(traversalContentDigest('records', columns, left, fingerprint)).toBe(traversalContentDigest('records', columns, right, fingerprint));
  expect(traversalContentDigest('records', columns, [left[0], {...left[0], index: 9}], fingerprint)).not.toBe(traversalContentDigest('records', columns, [{...left[0], index: 9}, left[0]], fingerprint));
});
it('completes all twenty first=200 traversals against the fixed standard intake baseline', async () => {
  const f = fixture();
  const result = await runCandidateLoadTraversal(f.frozen, f.ports());
  expect(result.status).toBe('passed');
  expect(result.iterations).toHaveLength(20);
  expect(result.iterations.map((x) => x.ordinal)).toEqual(Array.from({length:20},(_,i)=>i+1));
  expect(result.iterations.every((x) => x.outcome === 'completed' && x.counts.assets === 2 && x.counts.records === 6 && x.counts.geometry === 4 && Object.values(x.checks).every(Boolean))).toBe(true);
  expect(f.requests.every((r) => r.method === 'GET' && r.first === 200 && ['get','records','geometry'].includes(r.action))).toBe(true);
  expect(f.requests).toHaveLength(240);
});
it('unknown frozen counts prevent requests rather than measuring an invented inventory', async () => {
  const f = fixture();
  const unknown = structuredClone(f.frozen);
  unknown.batch.assets[0]!.recordCount = null;
  const result = await runCandidateLoadTraversal(unknown, f.ports());
  expect(result.status).toBe('not_run');
  expect(result.reason).toBe('incomplete_inventory');
  expect(f.requests).toHaveLength(0);
});
it('compares every run with the frozen digest even when all twenty changed runs agree', async () => {
  const f = fixture();
  const changed = {
    ...f.frozen,
    materials: f.frozen.materials.map((material, index) =>
      index === 0 ? { ...material, recordsDigest: 'e'.repeat(64) } : material,
    ),
  };
  const result = await runCandidateLoadTraversal(changed, f.ports());
  expect(result.status).toBe('failed');
  expect(result.iterations.some((x) => x.outcome === 'drift')).toBe(true);
});
it('flags a content change on the twentieth traversal instead of only cross-run agreement', async () => {
  const f = fixture();
  const result = await runCandidateLoadTraversal(f.frozen, f.ports((reply, request, round) => {
    if (round === 20 && request.action === 'records' && request.after !== undefined) {
      const body = reply.body as {records: Array<{values: Record<string, unknown>}>};
      body.records[0]!.values = {原值:'changed-private-original'};
    }
    return reply;
  }));
  expect(result.status).toBe('failed');
  expect(result.iterations.at(-1)?.outcome).toBe('drift');
});
for (const mutation of ['duplicate', 'index-backwards', 'empty-continuation', 'cursor-cycle', 'cursor-too-long', 'count-ahead', 'count-short', 'labels', 'asset-order', 'state'] as const) {
  it(`fails a complete traversal on ${mutation} without an unbounded request history`, async () => {
    const f = fixture();
    const result = await runCandidateLoadTraversal(f.frozen, f.ports((reply, request) => {
      if (mutation === 'asset-order' && request.action === 'get') {
        (reply.body as {assets:unknown[]}).assets = [request.after === undefined ? f.assets[1]! : f.assets[0]!];
      } else if (mutation === 'state' && request.action === 'get' && request.after !== undefined) {
        (reply.body as {status:string}).status = 'PARTIAL';
      } else if (request.action === 'records' && request.after !== undefined) {
        const body = reply.body as {records:Array<{recordId:string;index:number}>;nextCursor:string|null;columns:typeof columns};
        if (mutation === 'duplicate') body.records[0]!.recordId = f.materials[0]!.records[0]!.recordId;
        if (mutation === 'index-backwards') body.records[0]!.index = 1;
        if (mutation === 'empty-continuation') body.records = [];
        if (mutation === 'cursor-cycle') body.nextCursor = request.after;
        if (mutation === 'cursor-too-long') body.nextCursor = 'private'.repeat(1200);
        if (mutation === 'count-ahead') body.nextCursor = 'private-records-3';
        if (mutation === 'count-short') body.nextCursor = null;
        if (mutation === 'labels') body.columns = [{...columns[0]!,label:'changed-private-label'},columns[1]!];
      }
      return reply;
    }));
    expect(result.status).toBe('failed');
    expect(result.iterations.some((x) => x.outcome !== 'completed')).toBe(true);
    expect(f.requests.length).toBeLessThanOrEqual(240);
  });
}
it('records loss of permission without retries replacing the failed traversal', async () => {
  const f = fixture();
  const result = await runCandidateLoadTraversal(f.frozen, f.ports((reply, request) => request.action === 'geometry' && request.after !== undefined ? {...reply,status:403,body:{private:'private-response-body'}} : reply));
  expect(result.status).toBe('failed');
  expect(result.iterations.some((x) => x.outcome === 'denied')).toBe(true);
});
it('returns only ordinal/count/checks/digest outcomes, never raw material, cursor or error', async () => {
  const f = fixture();
  const ports = f.ports();
  const result = await runCandidateLoadTraversal(f.frozen, {
    ...ports,
    send: async (request) => {
      if (request.after !== undefined) throw new Error('private-cursor /private-url private-error-original');
      return ports.send(request);
    },
  });
  expect(result.status).toBe('failed');
  const serialized = JSON.stringify(result);
  for (const marker of ['private-cursor','private-url','private-error-original','reference','recordId','assetId','sourceId','columns','values','coordinates','after','nextCursor']) {
    expect(serialized.includes(marker)).toBe(false);
  }
});
