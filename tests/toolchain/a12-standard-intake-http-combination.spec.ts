import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CompleteUploadSessionOutputSchema,
  CreateIngestionInputSchema,
  CreateIngestionOutputSchema,
  CreateUploadSessionOutputSchema,
  GetIngestionOutputSchema,
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordPageSchema,
  OperationEventPageSchema,
  OperationOutputSchema,
  OperationSchema,
} from '../../packages/data-contracts/src/index.ts';
import {
  createA12StandardIntakeCollector,
  type A12FreshIntakeOptions,
  type A12StandardIntakeCollector,
} from '../../apps/web/e2e-live/support/a12-standard-intake-collector.ts';
import { createA12StandardIntakeHttpAdapter } from '../../apps/web/e2e-live/support/a12-standard-intake-http.ts';
import {
  createCandidateLoadHttpAdapter,
  type CandidateLoadHttpAdapter,
} from '../../apps/web/e2e-live/support/a12-candidate-load-http.ts';
import { createCandidateOriginalHttpAdapter } from '../../apps/web/e2e-live/support/a12-candidate-original-http.ts';
import {
  createCandidateInventoryCollector,
  type CandidateInventoryCollector,
  type CandidateInventoryCollectorOptions,
} from '../../apps/web/e2e-live/support/a12-candidate-inventory-collector.ts';
import { readFrozenCandidateInput } from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import { traversalContentDigest } from '../../apps/web/e2e-live/support/a12-candidate-load-traversal.ts';

// Task-owned, ephemeral HTTP composition only. Every payload/token below is
// synthetic. These tests prove neither real Auth/RLS/SQL nor normal Worker scan,
// standard intake authority, A12 performance, S10 scale, or the Goal's completion.
// No HTTP adapter, candidate traversal or binary original reader is mocked.
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => sha(JSON.stringify(value));
const at = '2026-10-06T00:00:00Z';
const scope = { tenantId: uuid(1), projectId: uuid(2), purpose: 'research' };
// Prepared source ordinals intentionally differ from UUID sort order.
const assetIds = [uuid(4), uuid(3)];
const ingestionId = uuid(5),
  operationId = uuid(6),
  uploadSessionId = uuid(7);
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId,
  processingBatchId: uuid(8),
  reviewHash: 'a'.repeat(64),
};
const keys = {
  createUpload: uuid(10),
  completeUpload: uuid(11),
  createIngestion: uuid(12),
  submitIngestion: uuid(13),
};
const token = 'synthetic-local-token-never-persist';
const signature = 'synthetic-signature-never-persist';
const message = 'synthetic-private-event-message-never-persist';
const rawValue = 'synthetic-record-value-never-persist';
const eventCursor = 'synthetic-event-cursor-never-persist';
// Non-UTF8 bytes force real binary streaming, rather than JSON/HEAD substitution.
const originalBytes = [
  Buffer.from([0xff, 0x00, 0x61, 0x80, 0x62]),
  Buffer.from([0xfe, 0x10, 0x63, 0x81, 0x64, 0x00]),
];
type Mode =
  | 'ok'
  | 'submit-denied'
  | 'event-second-denied'
  | 'candidate-next-denied'
  | 'original-drift'
  | 'original-truncated'
  | 'final-get-denied'
  | 'final-reference-drift'
  | 'final-reference-ingestion-drift'
  | 'final-reference-batch-drift'
  | 'final-ingestion-version-regressed'
  | 'final-operation-denied'
  | 'final-operation-id-drift'
  | 'final-operation-capability-drift'
  | 'final-operation-version-regressed'
  | 'final-operation-failed'
  | 'final-operation-cancelled';
type Hit = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: Buffer;
};
const columns = [{ key: 'value', label: '合成原值' }];
const records = assetIds.map((assetId, ordinal) => [
  {
    recordId: uuid(100 + ordinal * 2),
    assetId,
    index: 1,
    sourceId: null,
    values: { value: rawValue },
    hasGeometry: true,
  },
  {
    recordId: uuid(101 + ordinal * 2),
    assetId,
    index: 3,
    sourceId: null,
    values: { value: null },
    hasGeometry: true,
  },
]);
const features = records.map((items) =>
  items.map((item) => ({
    recordId: item.recordId,
    assetId: item.assetId,
    index: item.index,
    sourceId: null,
    sourceCrs: null,
    geometry: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [116, 40] },
        { type: 'Point', coordinates: [117, 41] },
      ],
    },
  })),
);
const assets = assetIds.map((assetId, ordinal) => ({
  assetId,
  sourceHash: sha(originalBytes[ordinal]!),
  status: 'READY' as const,
  reason: null,
  recordCount: 2,
  featureCount: 2,
}));
const batch = IngestionCandidateBatchSchema.parse({
  reference,
  parserVersion: 'synthetic-http-combination',
  status: 'READY',
  assets,
  createdAt: at,
});
const session = (completed = false) => ({
  uploadSessionId,
  tenantId: scope.tenantId,
  projectId: scope.projectId,
  status: completed ? 'COMPLETED' : 'OPEN',
  assetIds,
  version: completed ? 2 : 1,
  expiresAt: '2030-01-01T00:00:00Z',
  createdAt: at,
  ...(completed ? { completedAt: at } : {}),
});
const operation = (status = 'WAITING_REVIEW', version = 3) => ({
  operationId,
  tenantId: scope.tenantId,
  projectId: scope.projectId,
  capabilityId: 'data.ingestion.create',
  status,
  resource: `operation://${operationId}`,
  progressPercent: 0,
  version,
  createdAt: at,
  updatedAt: at,
});
const getIngestion = (pending: boolean) => ({
  ingestion: {
    ingestionId,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    assetIds,
    intendedUses: ['analysis'],
    requestedSecurityLevel: 'L1_INTERNAL',
    state: pending ? 'RECEIVED' : 'REVIEW_REQUIRED',
    operationId,
    version: pending ? 2 : 3,
    createdAt: at,
    updatedAt: at,
  },
  candidateReference: pending ? null : reference,
});
// Every final response mutation below remains a valid public DTO. The real
// HTTP helper, followed by the collector's continuity checks, classifies it.
const finalIngestion = (mode: Mode) => {
  const body = getIngestion(false);
  if (mode === 'final-reference-drift')
    body.candidateReference = { ...reference, reviewHash: 'd'.repeat(64) };
  if (mode === 'final-reference-ingestion-drift')
    body.candidateReference = { ...reference, ingestionId: uuid(90) };
  if (mode === 'final-reference-batch-drift')
    body.candidateReference = { ...reference, processingBatchId: uuid(91) };
  if (mode === 'final-ingestion-version-regressed') body.ingestion.version = 2;
  return body;
};
function finalOperation(mode: Mode): unknown {
  if (mode === 'final-operation-id-drift')
    return {
      ...operation(),
      operationId: uuid(92),
      resource: `operation://${uuid(92)}`,
    };
  if (mode === 'final-operation-capability-drift')
    return { ...operation(), capabilityId: 'data.ingestion.submit' };
  if (mode === 'final-operation-version-regressed')
    return operation('WAITING_REVIEW', 2);
  if (mode === 'final-operation-failed')
    return {
      ...operation('FAILED'),
      completedAt: at,
      error: { code: 'SYNTHETIC_FAILURE', message, retryable: false },
    };
  if (mode === 'final-operation-cancelled')
    return { ...operation('CANCELLED'), completedAt: at };
  return operation();
}
const finalIngestionCases = [
  ['final-get-denied', 'denied'],
  ['final-reference-drift', 'drift'],
  // The HTTP helper itself rejects cross-ingestion reference identity.
  ['final-reference-ingestion-drift', 'invalid'],
  ['final-reference-batch-drift', 'drift'],
  ['final-ingestion-version-regressed', 'drift'],
] as const;
const finalOperationCases = [
  ['final-operation-denied', 'denied'],
  // A schema-valid different Operation ID violates the helper's requested ID.
  ['final-operation-id-drift', 'invalid'],
  ['final-operation-capability-drift', 'invalid'],
  ['final-operation-version-regressed', 'drift'],
  ['final-operation-failed', 'unavailable'],
  ['final-operation-cancelled', 'cancelled'],
] as const;
const event = (ordinal: number) => ({
  eventId: uuid(200 + ordinal),
  operationId,
  sequence: ordinal === 1 ? 1 : 3,
  eventType: 'WAITING_REVIEW',
  status: 'WAITING_REVIEW',
  progressPercent: 0,
  operationVersion: 3,
  occurredAt: at,
  message,
});
const target = (storagePort: number, ordinal: number) => ({
  assetId: assetIds[ordinal],
  method: 'PRESIGNED_PUT',
  uploadUrl: `http://127.0.0.1:${storagePort}/synthetic-object-${ordinal}?X-Amz-Signature=${signature}`,
  headers: {
    'content-length': String(originalBytes[ordinal]!.length),
    'content-type': 'application/octet-stream',
    'x-amz-meta-sha256': sha(originalBytes[ordinal]!),
  },
});
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid synthetic object');
  return value as Record<string, unknown>;
}
const decode = (bytes: Uint8Array): unknown =>
  JSON.parse(Buffer.from(bytes).toString('utf8'));
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function denial(res: ServerResponse) {
  json(res, 403, { code: 'FORBIDDEN', message: `${message} ${token}` });
}
async function requestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes: unknown = chunk;
    if (!(bytes instanceof Uint8Array))
      throw new Error('invalid synthetic request bytes');
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}
function hit(req: IncomingMessage, body: Buffer): Hit {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return {
    method: req.method ?? '',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: { ...req.headers },
    body,
  };
}
async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('synthetic listener unavailable');
  return address.port;
}
const servers: ReturnType<typeof createServer>[] = [];
const collectors: A12StandardIntakeCollector[] = [];
const fallbackClosers: (() => void)[] = [];
afterEach(async () => {
  for (const collector of collectors.splice(0)) collector.close();
  for (const close of fallbackClosers.splice(0)) close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
});

async function fixture(mode: Mode = 'ok', throwOnClose = false) {
  const hits: Hit[] = [],
    wireErrors: string[] = [];
  let ingestionReads = 0,
    operationReads = 0,
    eventReads = 0,
    storagePort = 0;
  const candidateBase = `/api/data/v1/ingestions/${ingestionId}/candidates/${reference.processingBatchId}`;
  const contentBase = `/api/data/v1/tenants/${scope.tenantId}/projects/${scope.projectId}/ingestions/${ingestionId}/candidates/${reference.processingBatchId}/assets`;
  function candidatePage(path: string, query: Record<string, string>): unknown {
    if (
      query.kind !== reference.kind ||
      query.reviewHash !== reference.reviewHash ||
      !['50', '200'].includes(query.first ?? '') ||
      Object.keys(query).some(
        (key) => !['kind', 'reviewHash', 'first', 'after'].includes(key),
      )
    )
      throw new Error('unexpected synthetic candidate query');
    if (
      path === candidateBase &&
      query.after !== undefined &&
      query.after !== 'synthetic-assets-after-1'
    )
      throw new Error('unexpected synthetic asset continuation');
    const offset = query.after === undefined ? 0 : 1;
    if (path === candidateBase)
      return IngestionCandidateAssetPageSchema.parse({
        ...batch,
        assets: assets.slice(offset, offset + 1),
        totalAssetCount: 2,
        knownRecordCount: 4,
        knownFeatureCount: 4,
        unknownAssetCount: 0,
        nextCursor: offset === 0 ? 'synthetic-assets-after-1' : null,
      });
    const ordinal = assetIds.findIndex((assetId) =>
      path.includes(`/${assetId}/`),
    );
    if (ordinal < 0) throw new Error('unexpected synthetic candidate asset');
    const assetId = assetIds[ordinal];
    const action =
      path === `${candidateBase}/${assetId}/records`
        ? 'records'
        : path === `${candidateBase}/${assetId}/geometry`
          ? 'geometry'
          : null;
    if (action === null)
      throw new Error('unexpected synthetic candidate route');
    if (
      query.after !== undefined &&
      query.after !== `synthetic-${action}-${ordinal}-after-1`
    )
      throw new Error('unexpected synthetic material continuation');
    if (action === 'records')
      return IngestionCandidateRecordPageSchema.parse({
        reference,
        assetId,
        columns,
        records: records[ordinal]!.slice(offset, offset + 1),
        nextCursor:
          offset === 0 ? `synthetic-records-${ordinal}-after-1` : null,
      });
    return IngestionCandidateGeometryPageSchema.parse({
      reference,
      assetId,
      crs: 'EPSG:4326',
      features: features[ordinal]!.slice(offset, offset + 1),
      nextCursor: offset === 0 ? `synthetic-geometry-${ordinal}-after-1` : null,
    });
  }
  async function apiHandler(req: IncomingMessage, res: ServerResponse) {
    const request = hit(req, await requestBody(req));
    hits.push(request);
    const { method, path, query } = request;
    if (method === 'POST' && path === '/api/data/v1/upload-sessions')
      return json(
        res,
        201,
        CreateUploadSessionOutputSchema.parse({
          uploadSession: session(),
          uploadTargets: [target(storagePort, 0), target(storagePort, 1)],
        }),
      );
    if (
      method === 'POST' &&
      path === `/api/data/v1/upload-sessions/${uploadSessionId}/complete`
    )
      return json(
        res,
        200,
        CompleteUploadSessionOutputSchema.parse({
          uploadSession: session(true),
        }),
      );
    if (method === 'POST' && path === '/api/data/v1/ingestions')
      return json(
        res,
        202,
        CreateIngestionOutputSchema.parse({
          ingestionId,
          operation: operation('WAITING_INPUT', 1),
        }),
      );
    if (
      method === 'POST' &&
      path === `/api/data/v1/ingestions/${ingestionId}/submit`
    ) {
      if (mode === 'submit-denied') return denial(res);
      return json(
        res,
        202,
        OperationOutputSchema.parse({ operation: operation('RUNNING', 2) }),
      );
    }
    if (method === 'GET' && path === `/api/data/v1/ingestions/${ingestionId}`) {
      ingestionReads += 1;
      if (ingestionReads === 3 && mode === 'final-get-denied')
        return denial(res);
      const body =
        ingestionReads === 3
          ? finalIngestion(mode)
          : getIngestion(ingestionReads === 1);
      return json(res, 200, GetIngestionOutputSchema.parse(body));
    }
    if (method === 'GET' && path === `/api/data/v1/operations/${operationId}`) {
      operationReads += 1;
      if (operationReads === 2 && mode === 'final-operation-denied')
        return denial(res);
      return json(
        res,
        200,
        OperationSchema.parse(
          operationReads === 2 ? finalOperation(mode) : operation(),
        ),
      );
    }
    if (
      method === 'GET' &&
      path === `/api/data/v1/operations/${operationId}/events`
    ) {
      eventReads += 1;
      if (mode === 'event-second-denied' && eventReads === 2)
        return denial(res);
      const item = OperationEventPageSchema.parse({
        items: [event(eventReads)],
      }).items[0]!;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        ...(eventReads === 1 ? { 'X-Next-Cursor': eventCursor } : {}),
      });
      return res.end(
        `id: ${item.eventId}\nevent: ${item.eventType}\ndata: ${JSON.stringify(item)}\n\n`,
      );
    }
    if (method === 'GET' && path.startsWith(contentBase + '/')) {
      const ordinal = assetIds.findIndex(
        (assetId) => path === `${contentBase}/${assetId}/content`,
      );
      if (ordinal < 0) throw new Error('unexpected synthetic original asset');
      const bytes = Buffer.from(originalBytes[ordinal]!);
      if (mode === 'original-drift' && ordinal === 0) bytes[0] = bytes[0]! ^ 1;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.length,
      });
      if (mode === 'original-truncated' && ordinal === 0) {
        res.write(bytes.subarray(0, 1));
        // A real response abort exercises the binary helper's cleanup. It must
        // not be relabeled as a complete/hash-verified body by the orchestrator.
        setImmediate(() => res.destroy());
        return;
      }
      res.write(bytes.subarray(0, 2));
      return setImmediate(() => res.end(bytes.subarray(2)));
    }
    if (
      method === 'GET' &&
      (path === candidateBase || path.startsWith(candidateBase + '/'))
    ) {
      if (
        mode === 'candidate-next-denied' &&
        path === candidateBase &&
        query.after !== undefined
      )
        return denial(res);
      return json(res, 200, candidatePage(path, query));
    }
    throw new Error('unexpected synthetic HTTP route');
  }
  const apiServer = createServer((req, res) => {
    void apiHandler(req, res).catch(() => {
      wireErrors.push('synthetic API handler failure');
      if (!res.headersSent) json(res, 500, { code: 'FIXTURE_ERROR' });
      else res.destroy();
    });
  });
  servers.push(apiServer);
  const apiPort = await listen(apiServer);
  const storageServer = createServer((req, res) => {
    void requestBody(req)
      .then((body) => {
        hits.push(hit(req, body));
        res.writeHead(200, { ETag: '"synthetic-etag-never-persist"' });
        res.end();
      })
      .catch(() => {
        wireErrors.push('synthetic storage handler failure');
        res.destroy();
      });
  });
  servers.push(storageServer);
  storagePort = await listen(storageServer);
  const httpOptions = {
    apiOrigin: `http://127.0.0.1:${apiPort}`,
    taskApiPort: apiPort,
    ...scope,
    accessToken: () => Promise.resolve(token),
  };
  const api = createA12StandardIntakeHttpAdapter({
    ...httpOptions,
    storageOrigin: `http://127.0.0.1:${storagePort}`,
    taskStoragePort: storagePort,
  });
  const original = createCandidateOriginalHttpAdapter(httpOptions);
  fallbackClosers.push(api.close, original.close);
  const closeCalls = { api: 0, original: 0, inventoryTransport: 0 };
  const inventories: CandidateInventoryCollector[] = [],
    inventoryTransports: CandidateLoadHttpAdapter[] = [];
  // Ownership instrumentation delegates all send/read/put and diagnostics to
  // the actual adapters. Only close adds counts and an optional cleanup fault.
  const options: A12FreshIntakeOptions = {
    dataset: 'SYNTHETIC-S10',
    scope,
    prepared: originalBytes.map((bytes, ordinal) => ({
      object: {
        fileName: `a12-${ordinal + 1}.bin`,
        mediaType: 'application/octet-stream',
        sizeBytes: bytes.length,
        sha256: sha(bytes),
      },
      bytes: Uint8Array.from(bytes),
      sha256: sha(bytes),
      sizeBytes: bytes.length,
    })),
    idempotencyKeys: keys,
    createIngestionInput: (orderedAssetIds) =>
      CreateIngestionInputSchema.parse({
        ownerProjectId: scope.projectId,
        assetIds: [...orderedAssetIds],
        intendedUses: ['analysis'],
        requestedSecurityLevel: 'L1_INTERNAL',
      }),
    api: {
      send: api.send,
      put: api.put,
      diagnostics: api.diagnostics,
      close: () => {
        closeCalls.api += 1;
        api.close();
        if (throwOnClose) throw new Error('synthetic-cleanup-fault');
      },
    },
    original: {
      read: original.read,
      diagnostics: original.diagnostics,
      close: () => {
        closeCalls.original += 1;
        original.close();
      },
    },
    createInventory: (
      input: Pick<
        CandidateInventoryCollectorOptions,
        'dataset' | 'reference' | 'prepared'
      >,
    ) => {
      const transport = createCandidateLoadHttpAdapter(httpOptions);
      inventoryTransports.push(transport);
      fallbackClosers.push(transport.close);
      const inventory = createCandidateInventoryCollector({
        ...input,
        adapter: {
          send: transport.send,
          diagnostics: transport.diagnostics,
          close: () => {
            closeCalls.inventoryTransport += 1;
            transport.close();
          },
        },
      });
      inventories.push(inventory);
      return inventory;
    },
    maximumStatusReads: 3,
    maximumEventPages: 3,
  };
  const collector = createA12StandardIntakeCollector(options);
  collectors.push(collector);
  return {
    collector,
    hits,
    wireErrors,
    api,
    original,
    inventories,
    inventoryTransports,
    closeCalls,
    candidateBase,
    contentBase,
  };
}

describe(
  'fresh standard intake composition over owned synthetic HTTP',
  { concurrent: false },
  () => {
    it('independently admits the complete synthetic public DTO fixtures before collector dispatch', () => {
      expect(
        CreateUploadSessionOutputSchema.safeParse({
          uploadSession: session(),
          uploadTargets: [target(19000, 0), target(19000, 1)],
        }).success,
      ).toBe(true);
      expect(
        CompleteUploadSessionOutputSchema.safeParse({
          uploadSession: session(true),
        }).success,
      ).toBe(true);
      expect(
        CreateIngestionOutputSchema.safeParse({
          ingestionId,
          operation: operation('WAITING_INPUT', 1),
        }).success,
      ).toBe(true);
      expect(
        GetIngestionOutputSchema.safeParse(getIngestion(true)).success,
      ).toBe(true);
      expect(
        GetIngestionOutputSchema.safeParse(getIngestion(false)).success,
      ).toBe(true);
      expect(
        OperationOutputSchema.safeParse({ operation: operation('RUNNING', 2) })
          .success,
      ).toBe(true);
      expect(OperationSchema.safeParse(operation()).success).toBe(true);
      for (const [mode] of finalIngestionCases)
        expect(
          GetIngestionOutputSchema.safeParse(finalIngestion(mode)).success,
        ).toBe(true);
      for (const [mode] of finalOperationCases)
        expect(OperationSchema.safeParse(finalOperation(mode)).success).toBe(
          true,
        );
      // Candidate reference kind is a public literal, so there is no second
      // DTO-valid kind to treat as an actual HTTP continuity counterexample.
      expect(
        GetIngestionOutputSchema.safeParse({
          ...getIngestion(false),
          candidateReference: { ...reference, kind: 'synthetic-other-kind' },
        }).success,
      ).toBe(false);
      expect(
        OperationEventPageSchema.safeParse({ items: [event(1), event(2)] })
          .success,
      ).toBe(true);
      for (const [ordinal, assetId] of assetIds.entries()) {
        expect(
          IngestionCandidateRecordPageSchema.safeParse({
            reference,
            assetId,
            columns,
            records: records[ordinal],
            nextCursor: null,
          }).success,
        ).toBe(true);
        expect(
          IngestionCandidateGeometryPageSchema.safeParse({
            reference,
            assetId,
            crs: 'EPSG:4326',
            features: features[ordinal],
            nextCursor: null,
          }).success,
        ).toBe(true);
      }
      expect(
        IngestionCandidateAssetPageSchema.safeParse({
          ...batch,
          assets: [assets[0]],
          totalAssetCount: 2,
          knownRecordCount: 4,
          knownFeatureCount: 4,
          unknownAssetCount: 0,
          nextCursor: 'synthetic-assets-after-1',
        }).success,
      ).toBe(true);
    });

    it('collects the entire real-helper chain once with ordered assets, distinct versions, cursor pages, binary originals and safe capture', async () => {
      const f = await fixture();
      const first = f.collector.collect(),
        concurrent = f.collector.collect();
      const [result, second] = await Promise.all([first, concurrent]);
      expect(result.status).toBe('collected');
      expect(second).toEqual(result);
      if (result.status === 'collected' && second.status === 'collected') {
        expect(second.receiptBytes).not.toBe(result.receiptBytes);
        expect(second.receiptBytes.buffer).not.toBe(result.receiptBytes.buffer);
        expect(second.inventoryBytes).not.toBe(result.inventoryBytes);
        expect(second.inventoryBytes.buffer).not.toBe(
          result.inventoryBytes.buffer,
        );
        expect(second.captureBytes).not.toBe(result.captureBytes);
        expect(second.captureBytes.buffer).not.toBe(result.captureBytes.buffer);
      }
      if (result.status !== 'collected')
        throw new Error('expected synthetic HTTP composition');
      expect(f.wireErrors).toEqual([]);
      const paths = f.hits.map(({ method, path }) => `${method} ${path}`);
      expect(paths.slice(0, 10)).toEqual([
        'POST /api/data/v1/upload-sessions',
        'PUT /synthetic-object-0',
        'PUT /synthetic-object-1',
        `POST /api/data/v1/upload-sessions/${uploadSessionId}/complete`,
        'POST /api/data/v1/ingestions',
        `GET /api/data/v1/ingestions/${ingestionId}`,
        `POST /api/data/v1/ingestions/${ingestionId}/submit`,
        `GET /api/data/v1/ingestions/${ingestionId}`,
        `GET /api/data/v1/operations/${operationId}`,
        `GET /api/data/v1/operations/${operationId}/events`,
      ]);
      const commands = f.hits.filter(({ method }) => method === 'POST');
      expect(commands.map((entry) => entry.headers['idempotency-key'])).toEqual(
        [
          keys.createUpload,
          keys.completeUpload,
          keys.createIngestion,
          keys.submitIngestion,
        ],
      );
      expect(JSON.parse(commands[0]!.body.toString())).toMatchObject({
        ownerProjectId: scope.projectId,
        preferredMode: 'PRESIGNED_PUT',
        objects: originalBytes.map((bytes, ordinal) => ({
          fileName: `a12-${ordinal + 1}.bin`,
          sha256: sha(bytes),
          sizeBytes: bytes.length,
        })),
      });
      expect(commands[1]!.headers['if-match']).toBe('"v1"');
      expect(JSON.parse(commands[1]!.body.toString())).toEqual({
        expectedVersion: 1,
        objects: assetIds.map((assetId, ordinal) => ({
          assetId,
          sha256: sha(originalBytes[ordinal]!),
          sizeBytes: originalBytes[ordinal]!.length,
        })),
      });
      expect(object(decode(commands[2]!.body)).assetIds).toEqual(assetIds);
      expect(commands[3]!.headers['if-match']).toBe('"v2"');
      expect(JSON.parse(commands[3]!.body.toString())).toEqual({
        expectedVersion: 2,
      });
      const puts = f.hits.filter(({ method }) => method === 'PUT');
      expect(puts.map(({ body }) => body)).toEqual(originalBytes);
      expect(puts.map(({ headers }) => headers['x-amz-meta-sha256'])).toEqual(
        originalBytes.map(sha),
      );
      expect(
        puts.every(({ headers }) => headers.authorization === undefined),
      ).toBe(true);
      const authenticated = f.hits.filter(({ method }) => method !== 'PUT');
      expect(
        authenticated.every(
          ({ headers }) =>
            headers.authorization === `Bearer ${token}` &&
            headers['x-wiser-tenant-id'] === scope.tenantId &&
            headers['x-wiser-project-id'] === scope.projectId &&
            headers['x-wiser-purpose'] === scope.purpose,
        ),
      ).toBe(true);
      const eventHits = f.hits.filter(({ path }) => path.endsWith('/events'));
      expect(eventHits.map(({ query }) => query)).toEqual([
        { first: '200' },
        { first: '200', after: eventCursor },
      ]);
      const candidateHits = f.hits.filter(
        ({ path }) =>
          path === f.candidateBase || path.startsWith(f.candidateBase + '/'),
      );
      expect(candidateHits.some(({ query }) => query.after !== undefined)).toBe(
        true,
      );
      expect(
        candidateHits.every(
          ({ query }) =>
            query.kind === reference.kind &&
            query.reviewHash === reference.reviewHash &&
            ['50', '200'].includes(query.first!),
        ),
      ).toBe(true);
      for (const assetId of assetIds)
        for (const action of ['records', 'geometry']) {
          const requests = candidateHits.filter(
            ({ path }) => path === `${f.candidateBase}/${assetId}/${action}`,
          );
          expect(
            requests.some(
              ({ query }) => query.first === '50' && query.after === undefined,
            ),
          ).toBe(true);
          expect(
            requests.some(
              ({ query }) => query.first === '200' && query.after === undefined,
            ),
          ).toBe(true);
          expect(requests.some(({ query }) => query.after !== undefined)).toBe(
            true,
          );
        }
      const originalHits = f.hits.filter(({ path }) =>
        path.startsWith(f.contentBase + '/'),
      );
      expect(originalHits.map(({ path }) => path)).toEqual(
        assetIds.map((assetId) => `${f.contentBase}/${assetId}/content`),
      );
      expect(
        originalHits.every(
          ({ headers, query }) =>
            headers.range === undefined &&
            headers['accept-encoding'] === 'identity' &&
            query.reviewHash === reference.reviewHash,
        ),
      ).toBe(true);
      // Freeze only after a second authority read following the complete inventory
      // and both full originals. It must keep the original Operation and four-part
      // candidate identity, without replacing the read chain with caller flags.
      expect(paths.slice(-2)).toEqual([
        `GET /api/data/v1/ingestions/${ingestionId}`,
        `GET /api/data/v1/operations/${operationId}`,
      ]);
      expect(
        f.hits.filter(
          ({ path }) => path === `/api/data/v1/ingestions/${ingestionId}`,
        ),
      ).toHaveLength(3);
      expect(
        f.hits.filter(
          ({ path }) => path === `/api/data/v1/operations/${operationId}`,
        ),
      ).toHaveLength(2);
      expect(result.prepared).toEqual(
        assetIds.map((assetId, ordinal) => ({
          assetId,
          sha256: sha(originalBytes[ordinal]!),
          sizeBytes: originalBytes[ordinal]!.length,
        })),
      );
      const receipt = object(decode(result.receiptBytes));
      expect(Object.keys(receipt).sort()).toEqual([
        'completeUpload',
        'createIngestion',
        'createUpload',
        'events',
        'getIngestion',
        'operation',
      ]);
      expect(
        CreateIngestionOutputSchema.parse(
          object(receipt.createIngestion).output,
        ).operation.version,
      ).toBe(1);
      expect(
        GetIngestionOutputSchema.parse(receipt.getIngestion).ingestion.version,
      ).toBe(3);
      expect(OperationSchema.parse(receipt.operation)).toMatchObject({
        operationId,
        capabilityId: 'data.ingestion.create',
        version: 3,
      });
      expect(
        OperationEventPageSchema.parse(receipt.events).items.map(
          ({ sequence }) => sequence,
        ),
      ).toEqual([1, 3]);
      const inventory = object(decode(result.inventoryBytes));
      expect(IngestionCandidateBatchSchema.parse(inventory.batch)).toEqual(
        batch,
      );
      expect(inventory.materials).toEqual(
        assetIds.map((assetId, ordinal) => ({
          assetId,
          columns,
          recordsDigest: traversalContentDigest(
            'records',
            columns,
            records[ordinal]!,
            fingerprint,
          ),
          geometryDigest: traversalContentDigest(
            'geometry',
            [],
            features[ordinal]!,
            fingerprint,
          ),
        })),
      );
      expect(inventory.firstPages).toHaveLength(10);
      for (const bytes of [
        result.receiptBytes,
        result.inventoryBytes,
        result.captureBytes,
      ]) {
        const text = Buffer.from(bytes).toString('utf8');
        for (const sentinel of [
          token,
          signature,
          message,
          rawValue,
          eventCursor,
          'X-Amz-Signature',
          'http://127.0.0.1:',
          'synthetic-etag-never-persist',
        ])
          expect(text).not.toContain(sentinel);
      }
      expect(Buffer.from(result.captureBytes).toString('utf8')).toContain(
        'data.ingestion.submit',
      );
      expect(result.standardAuthority).toBe('unknown');
      const frozen = readFrozenCandidateInput({
        dataset: 'SYNTHETIC-S10',
        provenance: {
          kind: 'standard-intake-http',
          receiptSha256: sha(result.receiptBytes),
          inventorySha256: sha(result.inventoryBytes),
        },
        ...inventory,
      });
      expect(frozen.status).toBe('ready');
      if (frozen.status !== 'ready')
        throw new Error('expected complete synthetic inventory');
      expect(
        await f.collector.verifyStandardIntake({
          receipt,
          captureBytes: result.captureBytes,
          prepared: result.prepared,
          inventory: frozen.input,
        }),
      ).toBe('unknown');
      const dispatchCount = f.hits.length;
      f.collector.close();
      f.collector.close();
      const repeated = await f.collector.collect();
      expect(repeated).toEqual(result);
      if (repeated.status === 'collected') {
        expect(repeated.receiptBytes).not.toBe(result.receiptBytes);
        expect(repeated.receiptBytes.buffer).not.toBe(
          result.receiptBytes.buffer,
        );
        expect(repeated.inventoryBytes).not.toBe(result.inventoryBytes);
        expect(repeated.inventoryBytes.buffer).not.toBe(
          result.inventoryBytes.buffer,
        );
        expect(repeated.captureBytes).not.toBe(result.captureBytes);
        expect(repeated.captureBytes.buffer).not.toBe(
          result.captureBytes.buffer,
        );
      }
      expect(f.hits).toHaveLength(dispatchCount);
      expect(f.closeCalls).toEqual({
        api: 1,
        original: 1,
        inventoryTransport: 1,
      });
      expect(f.api.diagnostics()).toEqual({ activeRequests: 0, closed: true });
      expect(f.original.diagnostics()).toEqual({
        activeRequests: 0,
        closed: true,
      });
      expect(f.inventoryTransports).toHaveLength(1);
      expect(f.inventoryTransports[0]!.diagnostics()).toEqual({
        activeRequests: 0,
        closed: true,
      });
      expect(f.inventories).toHaveLength(1);
      expect(f.collector.diagnostics()).toEqual({
        activeCollections: 0,
        closed: true,
      });
    });

    it('preserves a real submit 403 as the first cause even when owned close throws, without retry or downstream reads', async () => {
      const f = await fixture('submit-denied', true);
      const result = await f.collector.collect();
      expect(result).toMatchObject({ status: 'failed', reason: 'denied' });
      expect(f.wireErrors).toEqual([]);
      expect(f.hits.at(-1)?.path).toBe(
        `/api/data/v1/ingestions/${ingestionId}/submit`,
      );
      expect(
        f.hits.filter(({ path }) => path.endsWith('/submit')),
      ).toHaveLength(1);
      expect(
        f.hits.filter(({ path }) => path === '/api/data/v1/upload-sessions'),
      ).toHaveLength(1);
      expect(f.inventories).toHaveLength(0);
      expect(f.closeCalls).toEqual({
        api: 1,
        original: 1,
        inventoryTransport: 0,
      });
      expect(f.api.diagnostics()).toEqual({ activeRequests: 0, closed: true });
      expect(f.original.diagnostics()).toEqual({
        activeRequests: 0,
        closed: true,
      });
      const count = f.hits.length;
      f.collector.close();
      f.collector.close();
      expect(await f.collector.collect()).toBe(result);
      expect(f.hits).toHaveLength(count);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain(message);
      expect(JSON.stringify(result)).not.toContain('synthetic-cleanup-fault');
    });

    it('consumes SSE X-Next-Cursor and propagates second-page 403 instead of freezing a successful first-page prefix', async () => {
      const f = await fixture('event-second-denied');
      const result = await f.collector.collect();
      expect(result).toMatchObject({ status: 'failed', reason: 'denied' });
      expect(f.wireErrors).toEqual([]);
      expect(
        f.hits
          .filter(({ path }) => path.endsWith('/events'))
          .map(({ query }) => query),
      ).toEqual([{ first: '200' }, { first: '200', after: eventCursor }]);
      expect(f.inventories).toHaveLength(0);
      expect(f.closeCalls).toEqual({
        api: 1,
        original: 1,
        inventoryTransport: 0,
      });
      expect(JSON.stringify(result)).not.toContain(eventCursor);
    });

    it('consumes actual candidate asset continuation and keeps its 403 rather than certifying an incomplete inventory', async () => {
      const f = await fixture('candidate-next-denied');
      const result = await f.collector.collect();
      expect(result).toMatchObject({ status: 'failed', reason: 'denied' });
      expect(f.wireErrors).toEqual([]);
      const candidateHits = f.hits.filter(
        ({ path }) => path === f.candidateBase,
      );
      expect(
        candidateHits.some(
          ({ query }) => query.after === 'synthetic-assets-after-1',
        ),
      ).toBe(true);
      expect(
        f.hits.some(({ path }) => path.startsWith(f.contentBase + '/')),
      ).toBe(false);
      expect(f.inventories).toHaveLength(1);
      expect(f.closeCalls).toEqual({
        api: 1,
        original: 1,
        inventoryTransport: 1,
      });
      expect(f.inventoryTransports[0]!.diagnostics()).toEqual({
        activeRequests: 0,
        closed: true,
      });
    });

    it('detects same-length original SHA drift after real binary GET and never reads the next original or returns a collected capture', async () => {
      const f = await fixture('original-drift');
      const result = await f.collector.collect();
      expect(result).toMatchObject({ status: 'failed', reason: 'drift' });
      expect(f.wireErrors).toEqual([]);
      expect(
        f.hits
          .filter(({ path }) => path.startsWith(f.contentBase + '/'))
          .map(({ path }) => path),
      ).toEqual([`${f.contentBase}/${assetIds[0]}/content`]);
      expect(f.closeCalls).toEqual({
        api: 1,
        original: 1,
        inventoryTransport: 1,
      });
      expect(f.original.diagnostics()).toEqual({
        activeRequests: 0,
        closed: true,
      });
      expect(Object.hasOwn(result, 'captureBytes')).toBe(false);
    });

    it('rejects an actually truncated original stream, closes active requests and does not call a prefix a verified original', async () => {
      const f = await fixture('original-truncated');
      const result = await f.collector.collect();
      expect(result).toMatchObject({ status: 'failed', reason: 'unavailable' });
      expect(f.wireErrors).toEqual([]);
      expect(
        f.hits
          .filter(({ path }) => path.startsWith(f.contentBase + '/'))
          .map(({ path }) => path),
      ).toEqual([`${f.contentBase}/${assetIds[0]}/content`]);
      expect(f.original.diagnostics()).toEqual({
        activeRequests: 0,
        closed: true,
      });
      expect(f.closeCalls).toEqual({
        api: 1,
        original: 1,
        inventoryTransport: 1,
      });
    });

    it.each(finalIngestionCases)(
      'rejects %s in the final real HTTP authority recheck after both originals',
      async (mode, reason) => {
        const f = await fixture(mode);
        const result = await f.collector.collect();
        expect(result).toMatchObject({ status: 'failed', reason });
        expect(f.wireErrors).toEqual([]);
        expect(
          f.hits
            .filter(({ path }) => path.startsWith(f.contentBase + '/'))
            .map(({ path }) => path),
        ).toEqual(
          assetIds.map((assetId) => `${f.contentBase}/${assetId}/content`),
        );
        expect(f.hits.at(-1)?.path).toBe(
          `/api/data/v1/ingestions/${ingestionId}`,
        );
        expect(
          f.hits.filter(
            ({ path }) => path === `/api/data/v1/ingestions/${ingestionId}`,
          ),
        ).toHaveLength(3);
        expect(
          f.hits.filter(
            ({ path }) => path === `/api/data/v1/operations/${operationId}`,
          ),
        ).toHaveLength(1);
        expect(f.closeCalls).toEqual({
          api: 1,
          original: 1,
          inventoryTransport: 1,
        });
        expect(Object.hasOwn(result, 'captureBytes')).toBe(false);
        for (const adapter of [f.api, f.original, ...f.inventoryTransports])
          expect(adapter.diagnostics()).toEqual({
            activeRequests: 0,
            closed: true,
          });
      },
    );

    it.each(finalOperationCases)(
      'rejects %s in the final real HTTP Operation recheck after both originals and final ingestion GET',
      async (mode, reason) => {
        const f = await fixture(mode);
        const result = await f.collector.collect();
        expect(result).toMatchObject({ status: 'failed', reason });
        expect(f.wireErrors).toEqual([]);
        expect(
          f.hits
            .filter(({ path }) => path.startsWith(f.contentBase + '/'))
            .map(({ path }) => path),
        ).toEqual(
          assetIds.map((assetId) => `${f.contentBase}/${assetId}/content`),
        );
        expect(
          f.hits.slice(-2).map(({ method, path }) => `${method} ${path}`),
        ).toEqual([
          `GET /api/data/v1/ingestions/${ingestionId}`,
          `GET /api/data/v1/operations/${operationId}`,
        ]);
        expect(
          f.hits.filter(
            ({ path }) => path === `/api/data/v1/ingestions/${ingestionId}`,
          ),
        ).toHaveLength(3);
        expect(
          f.hits.filter(
            ({ path }) => path === `/api/data/v1/operations/${operationId}`,
          ),
        ).toHaveLength(2);
        expect(f.closeCalls).toEqual({
          api: 1,
          original: 1,
          inventoryTransport: 1,
        });
        expect(Object.hasOwn(result, 'captureBytes')).toBe(false);
        for (const adapter of [f.api, f.original, ...f.inventoryTransports])
          expect(adapter.diagnostics()).toEqual({
            activeRequests: 0,
            closed: true,
          });
        expect(f.collector.diagnostics()).toEqual({
          activeCollections: 0,
          closed: true,
        });
        const dispatchCount = f.hits.length;
        f.collector.close();
        f.collector.close();
        expect(await f.collector.collect()).toEqual(result);
        expect(f.hits).toHaveLength(dispatchCount);
        expect(JSON.stringify(result)).not.toContain(token);
        expect(JSON.stringify(result)).not.toContain(message);
      },
    );
  },
);
