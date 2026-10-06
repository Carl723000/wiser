import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  CompleteUploadSessionOutputSchema,
  CreateIngestionInputSchema,
  CreateIngestionOutputSchema,
  DATA_CAPABILITY_REGISTRY,
  CreateUploadSessionOutputSchema,
  GetIngestionOutputSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateAssetPageSchema,
  IngestionCandidateRecordPageSchema,
  IngestionCandidateGeometryPageSchema,
  OperationEventPageSchema,
  OperationOutputSchema,
  OperationSchema,
} from '../../packages/data-contracts/src/index.ts';
import {
  CandidateLoadTransportError,
  pageFingerprint,
  readFrozenCandidateInput,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import { traversalContentDigest } from '../../apps/web/e2e-live/support/a12-candidate-load-traversal.ts';
import type { A12StandardIntakeCheck } from '../../apps/web/e2e-live/support/a12-candidate-load-runner.ts';
import { createA12StandardIntakeCollector } from '../../apps/web/e2e-live/support/a12-standard-intake-collector.ts';
import type {
  A12StandardIntakeCapability,
  A12StandardIntakeRequest,
} from '../../apps/web/e2e-live/support/a12-standard-intake-http.ts';
import type { A12FreshIntakeOptions } from '../../apps/web/e2e-live/support/a12-standard-intake-collector.ts';

// Synthetic orchestration fixtures for task-private standard intake collection.
// They do not prove current HTTP/Auth/RLS, normal scanning, real intake or A12.
// After helper submit is supported, parent should also add actual owned loopback
// combination using the existing HTTP/original/inventory adapters; no real service.
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const fingerprint = (value: unknown) => sha(JSON.stringify(value));
const decoded = (bytes: Uint8Array): unknown =>
  JSON.parse(Buffer.from(bytes).toString('utf8'));
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid synthetic object fixture');
  return value as Record<string, unknown>;
}
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-06T00:00:00Z';
const scope = { tenantId: uuid(1), projectId: uuid(2), purpose: 'research' };
// Deliberately not UUID-sorted: this is the prepared/source ordinal order.
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
const marker = 'private-original-never-report';
const preparedBytes = [Buffer.from('columnA\n'), Buffer.from('columnB\n')];
function fixture(mode = 'ok') {
  const calls: {
    id: string;
    input?: unknown;
    ifMatch?: string;
    key?: string;
  }[] = [];
  const bytesSeen: Buffer[] = [];
  const outputs: { id: string; body: unknown }[] = [];
  let ingestionReads = 0,
    eventReads = 0;
  const prepared = preparedBytes.map((bytes, i) => ({
    object: {
      fileName: `a12-000${i + 1}.csv`,
      mediaType: 'text/csv',
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    },
    bytes: Uint8Array.from(bytes),
    sizeBytes: bytes.length,
    sha256: sha(bytes),
  }));
  const assetMetadata = assetIds.map((assetId, i) => ({
    assetId,
    sourceHash: sha(preparedBytes[i]!),
    status: 'EMPTY' as const,
    reason: null,
    recordCount: 0,
    featureCount: 0,
  }));
  if (mode === 'partial')
    Object.assign(assetMetadata[0]!, {
      status: 'PARTIAL',
      reason: 'FORMAT_COMPANION',
    });
  if (mode === 'inventory-order') assetMetadata.reverse();
  if (mode === 'candidate-hash') assetMetadata[0]!.sourceHash = 'd'.repeat(64);
  const batch = IngestionCandidateBatchSchema.parse({
    reference,
    parserVersion: 'tiny-synthetic-control',
    status: mode === 'partial' ? 'PARTIAL' : 'READY',
    assets: assetMetadata,
    createdAt: at,
  });
  const getPage = IngestionCandidateAssetPageSchema.parse({
    ...batch,
    totalAssetCount: assetIds.length,
    knownRecordCount: 0,
    knownFeatureCount: 0,
    unknownAssetCount: 0,
    nextCursor: null,
  });
  const materials = assetIds.map((assetId) => ({
    assetId,
    columns: [],
    recordsDigest: traversalContentDigest('records', [], [], fingerprint),
    geometryDigest: traversalContentDigest('geometry', [], [], fingerprint),
  }));
  const firstPages = ([50, 200] as const).flatMap((first) => [
    {
      action: 'get' as const,
      first,
      assetId: null,
      digest: pageFingerprint(getPage, fingerprint),
    },
    ...assetIds.flatMap((assetId) => [
      {
        action: 'records' as const,
        first,
        assetId,
        digest: pageFingerprint(
          IngestionCandidateRecordPageSchema.parse({
            reference,
            assetId,
            columns: [],
            records: [],
            nextCursor: null,
          }),
          fingerprint,
        ),
      },
      {
        action: 'geometry' as const,
        first,
        assetId,
        digest: pageFingerprint(
          IngestionCandidateGeometryPageSchema.parse({
            reference,
            assetId,
            crs: 'EPSG:4326',
            features: [],
            nextCursor: null,
          }),
          fingerprint,
        ),
      },
    ]),
  ]);
  const inventory = { batch, materials, firstPages };
  // This control validates the synthetic frozen shape only, never its intake provenance.
  const frozenControl = {
    dataset: 'AUTHENTICATED-REAL',
    provenance: {
      kind: 'standard-intake-http',
      receiptSha256: sha('synthetic receipt'),
      inventorySha256: sha(JSON.stringify(inventory)),
    },
    ...inventory,
  };
  const inventoryClose = vi.fn(),
    apiClose = vi.fn(),
    originalClose = vi.fn();
  const publicSession = (completed = false) => ({
    uploadSessionId,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    status: completed ? 'COMPLETED' : 'OPEN',
    assetIds:
      (mode === 'session-order' && !completed) ||
      (mode === 'completed-order' && completed)
        ? [...assetIds].reverse()
        : [...assetIds],
    version: completed ? 2 : 1,
    expiresAt: at,
    createdAt: at,
    ...(completed ? { completedAt: at } : {}),
  });
  const operation = (
    status = 'WAITING_REVIEW',
    version = 3,
    fixedId = operationId,
    fixedCapability = mode === 'wrong-capability'
      ? 'data.uploadSession.create'
      : 'data.ingestion.create',
  ) =>
    OperationSchema.parse({
      operationId: fixedId,
      tenantId: scope.tenantId,
      projectId: mode === 'foreign-operation' ? uuid(90) : scope.projectId,
      capabilityId: fixedCapability,
      status,
      resource: `operation://${fixedId}`,
      progressPercent: 0,
      version,
      createdAt: at,
      updatedAt: at,
    });
  const target = (i: number) => ({
    assetId: assetIds[i],
    method: 'PRESIGNED_PUT',
    uploadUrl: `http://127.0.0.1:19000/object-${i}?X-Amz-Signature=${marker}`,
    headers: {
      'content-length': String(preparedBytes[i]!.length),
      'content-type': 'text/csv',
      ...(mode === 'missing-sha-header'
        ? {}
        : { 'x-amz-meta-sha256': sha(preparedBytes[i]!) }),
    },
  });
  const targets = [target(0), target(1)];
  if (mode === 'target-order') targets.reverse();
  const api = {
    send: vi.fn(
      (request: A12StandardIntakeRequest<A12StandardIntakeCapability>) => {
        DATA_CAPABILITY_REGISTRY[request.capabilityId].inputSchema.parse(
          request.input,
        );
        calls.push({
          id: request.capabilityId,
          input: request.input,
          ...(request.ifMatch === undefined
            ? {}
            : { ifMatch: request.ifMatch }),
          ...(request.idempotencyKey === undefined
            ? {}
            : { key: request.idempotencyKey }),
        });
        if (
          mode === 'denied' &&
          request.capabilityId === 'data.ingestion.submit'
        )
          return Promise.reject(new CandidateLoadTransportError('denied'));
        let body: unknown,
          status = 200;
        switch (request.capabilityId) {
          case 'data.uploadSession.create':
            body = CreateUploadSessionOutputSchema.parse({
              uploadSession: publicSession(),
              uploadTargets: targets,
            });
            status = 201;
            break;
          case 'data.uploadSession.complete':
            body = CompleteUploadSessionOutputSchema.parse({
              uploadSession: publicSession(true),
            });
            break;
          case 'data.ingestion.create':
            body = CreateIngestionOutputSchema.parse({
              ingestionId,
              operation: operation('WAITING_INPUT', 1),
            });
            status = 202;
            break;
          case 'data.ingestion.submit':
            body = OperationOutputSchema.parse({
              operation: operation(
                'RUNNING',
                2,
                mode === 'submit-operation-id' ? uuid(91) : operationId,
                mode === 'submit-operation-capability'
                  ? 'data.ingestion.submit'
                  : 'data.ingestion.create',
              ),
            });
            status = 202;
            break;
          case 'data.operation.get':
            body =
              mode === 'status-limit'
                ? operation('RUNNING', 2)
                : operation(
                    'WAITING_REVIEW',
                    3,
                    mode === 'current-operation-id' ? uuid(91) : operationId,
                  );
            break;
          case 'data.ingestion.get': {
            ingestionReads += 1;
            const pending = ingestionReads === 1 || mode === 'status-limit';
            body = GetIngestionOutputSchema.parse({
              ingestion: {
                ingestionId,
                tenantId: scope.tenantId,
                projectId: scope.projectId,
                assetIds:
                  mode === 'ingestion-order'
                    ? [...assetIds].reverse()
                    : [...assetIds],
                intendedUses: ['analysis'],
                requestedSecurityLevel: 'L1_INTERNAL',
                state: pending ? 'RECEIVED' : 'REVIEW_REQUIRED',
                operationId:
                  mode === 'ingestion-operation-id' ? uuid(91) : operationId,
                version: pending ? 2 : 3,
                createdAt: at,
                updatedAt: at,
              },
              candidateReference: pending ? null : reference,
            });
            break;
          }
          case 'data.operation.events': {
            eventReads += 1;
            const sequence = mode === 'sequence-repeat' ? 1 : eventReads;
            body = OperationEventPageSchema.parse({
              items: [
                {
                  eventId: uuid(50 + eventReads),
                  operationId,
                  sequence,
                  eventType: 'WAITING_REVIEW',
                  status: 'WAITING_REVIEW',
                  progressPercent: 0,
                  operationVersion: 3,
                  occurredAt: at,
                  message: marker,
                },
              ],
              ...(mode === 'cursor-cycle'
                ? { nextCursor: 'opaque-cycle-never-report' }
                : mode === 'event-limit'
                  ? { nextCursor: `opaque-page-${eventReads}-never-report` }
                  : mode === 'sequence-repeat' && eventReads === 1
                    ? { nextCursor: 'opaque-page-1-never-report' }
                    : {}),
            });
            break;
          }
          default:
            throw new Error(marker);
        }
        outputs.push({ id: request.capabilityId, body: structuredClone(body) });
        return Promise.resolve({
          capabilityId: request.capabilityId,
          status,
          contentType: 'application/json',
          wireBytes: Buffer.byteLength(JSON.stringify(body)),
          wireSha256: sha(JSON.stringify(body)),
          body,
        });
      },
    ),
    put: vi.fn(
      (input: {
        target: { assetId: string };
        bytes: Uint8Array;
        sizeBytes: number;
        sha256: string;
      }) => {
        calls.push({
          id: 'PUT',
          input: {
            assetId: input.target.assetId,
            sizeBytes: input.sizeBytes,
            sha256: input.sha256,
          },
        });
        bytesSeen.push(Buffer.from(input.bytes));
        return Promise.resolve({
          status: 200,
          requestBytes: input.bytes.length,
          requestSha256: sha(input.bytes),
          wireBytes: 0,
          wireSha256: sha(''),
          etag: '"synthetic-etag"',
        });
      },
    ),
    close: apiClose,
    diagnostics: () => ({ activeRequests: 0, closed: false }),
  };
  const original = {
    read: vi.fn(
      (input: {
        assetId: string;
        expectedSha256: string;
        expectedSizeBytes: number;
      }) => {
        calls.push({ id: 'original', input });
        return Promise.resolve({
          status: 200 as const,
          sha256:
            mode === 'original-drift' ? 'd'.repeat(64) : input.expectedSha256,
          sizeBytes: input.expectedSizeBytes,
        });
      },
    ),
    close: originalClose,
    diagnostics: () => ({ activeRequests: 0, closed: false }),
  };
  const createInventory = vi.fn(() => ({
    collect: vi.fn(() => {
      calls.push({ id: 'inventory' });
      return Promise.resolve({ status: 'collected' as const, inventory });
    }),
    close: inventoryClose,
    diagnostics: () => ({ activeCollections: 0, closed: true }),
  }));
  const options = {
    dataset: 'AUTHENTICATED-REAL',
    scope,
    prepared,
    idempotencyKeys: {
      createUpload: uuid(10),
      completeUpload: uuid(11),
      createIngestion: uuid(12),
      submitIngestion: uuid(13),
    },
    createIngestionInput: (orderedAssetIds: readonly string[]) =>
      CreateIngestionInputSchema.parse({
        assetIds:
          mode === 'builder-order'
            ? [...orderedAssetIds].reverse()
            : [...orderedAssetIds],
        ownerProjectId: scope.projectId,
        intendedUses: ['analysis'],
        requestedSecurityLevel: 'L1_INTERNAL',
      }),
    api,
    original,
    createInventory,
    maximumStatusReads: 3,
    maximumEventPages: 3,
  } as unknown as A12FreshIntakeOptions;
  return {
    options,
    calls,
    bytesSeen,
    outputs,
    frozenControl,
    api,
    original,
    createInventory,
    apiClose,
    originalClose,
    inventoryClose,
  };
}

it('accepts the independent complete synthetic frozen input shape as a fixture control only', () => {
  expect(readFrozenCandidateInput(fixture().frozenControl).status).toBe(
    'ready',
  );
});
it('performs fresh create/PUT/complete/create/current-get/submit/poll/events/inventory/original in owned order', async () => {
  const f = fixture();
  const value = createA12StandardIntakeCollector(f.options);
  const result = await value.collect();
  expect(result.status).toBe('collected');
  expect(f.calls.map(({ id }) => id)).toEqual([
    'data.uploadSession.create',
    'PUT',
    'PUT',
    'data.uploadSession.complete',
    'data.ingestion.create',
    'data.ingestion.get',
    'data.ingestion.submit',
    'data.ingestion.get',
    'data.operation.get',
    'data.operation.events',
    'inventory',
    'original',
    'original',
  ]);
  const submit = f.calls.find(({ id }) => id === 'data.ingestion.submit');
  expect(submit).toMatchObject({
    input: { ingestionId, expectedVersion: 2 },
    ifMatch: '"v2"',
    key: uuid(13),
  });
  expect(
    CreateIngestionOutputSchema.parse(
      f.outputs.find(({ id }) => id === 'data.ingestion.create')!.body,
    ).operation,
  ).toMatchObject({
    operationId,
    version: 1,
    capabilityId: 'data.ingestion.create',
  });
  expect(
    OperationOutputSchema.parse(
      f.outputs.find(({ id }) => id === 'data.ingestion.submit')!.body,
    ).operation,
  ).toMatchObject({
    operationId,
    version: 2,
    capabilityId: 'data.ingestion.create',
  });
  expect(
    f.calls.find(({ id }) => id === 'data.uploadSession.complete'),
  ).toMatchObject({
    input: { uploadSessionId, expectedVersion: 1 },
    ifMatch: '"v1"',
    key: uuid(11),
  });
  expect(
    f.calls.find(({ id }) => id === 'data.uploadSession.create'),
  ).toMatchObject({
    input: {
      ownerProjectId: scope.projectId,
      objects: f.options.prepared.map((entry) => entry.object),
      preferredMode: 'PRESIGNED_PUT',
    },
    key: uuid(10),
  });
  expect(
    f.calls.find(({ id }) => id === 'data.ingestion.create'),
  ).toMatchObject({
    input: { assetIds, ownerProjectId: scope.projectId },
    key: uuid(12),
  });
  expect(f.createInventory).toHaveBeenCalledWith({
    dataset: 'AUTHENTICATED-REAL',
    reference,
    prepared: assetIds.map((assetId, i) => ({
      assetId,
      sha256: sha(preparedBytes[i]!),
      sizeBytes: preparedBytes[i]!.length,
    })),
  });
  expect(
    f.calls.filter(({ id }) => id === 'data.operation.get')[0],
  ).toMatchObject({ input: { operationId } });
  expect(
    f.calls.filter(({ id }) => id === 'data.operation.events')[0],
  ).toMatchObject({ input: { operationId, first: 200 } });
  expect(value.diagnostics()).toEqual({ activeCollections: 0, closed: true });
  if (result.status === 'collected') {
    const receipt = object(decoded(result.receiptBytes));
    expect(Object.keys(receipt).sort()).toEqual([
      'completeUpload',
      'createIngestion',
      'createUpload',
      'events',
      'getIngestion',
      'operation',
    ]);
    expect(
      CreateIngestionOutputSchema.parse(object(receipt.createIngestion).output)
        .operation,
    ).toMatchObject({
      operationId,
      capabilityId: 'data.ingestion.create',
      version: 1,
    });
    expect(
      GetIngestionOutputSchema.parse(receipt.getIngestion).ingestion,
    ).toMatchObject({ ingestionId, operationId, version: 3, assetIds });
    expect(OperationSchema.parse(receipt.operation)).toMatchObject({
      operationId,
      capabilityId: 'data.ingestion.create',
      version: 3,
    });
    expect(result.prepared.map((entry) => entry.assetId)).toEqual(assetIds);
    expect(
      f.calls.filter(({ id }) => id === 'PUT').map(({ input }) => input),
    ).toEqual(
      assetIds.map((assetId, i) => ({
        assetId,
        sizeBytes: preparedBytes[i]!.length,
        sha256: sha(preparedBytes[i]!),
      })),
    );
    expect(
      IngestionCandidateBatchSchema.parse(
        object(decoded(result.inventoryBytes)).batch,
      ).assets.map((entry) => entry.assetId),
    ).toEqual(assetIds);
    expect(f.original.read.mock.calls.map(([input]) => input)).toEqual(
      assetIds.map((assetId, i) => ({
        reference,
        assetId,
        expectedSha256: sha(preparedBytes[i]!),
        expectedSizeBytes: preparedBytes[i]!.length,
      })),
    );
    const captureText = Buffer.from(result.captureBytes).toString('utf8');
    expect(captureText).toContain('data.ingestion.submit');
    expect(captureText).toContain(
      sha(
        JSON.stringify(
          f.outputs.find(({ id }) => id === 'data.ingestion.submit')!.body,
        ),
      ),
    );
    for (const bytes of [
      result.receiptBytes,
      result.inventoryBytes,
      result.captureBytes,
    ]) {
      expect(Buffer.from(bytes).toString('utf8')).not.toContain(marker);
      expect(Buffer.from(bytes).toString('utf8')).not.toContain(
        'X-Amz-Signature',
      );
    }
  }
});
it.each(['target-order', 'session-order', 'missing-sha-header'])(
  'rejects task A12 target binding %s before any PUT; public optional-SHA contract stays intact',
  async (mode) => {
    const f = fixture(mode);
    const result = await createA12StandardIntakeCollector(f.options).collect();
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid' });
    expect(f.calls.map(({ id }) => id)).toEqual(['data.uploadSession.create']);
  },
);
it('copies exact prepared bytes before asynchronous dispatch and records only generated asset IDs', async () => {
  const f = fixture();
  const value = createA12StandardIntakeCollector(f.options);
  const pending = value.collect();
  for (const entry of f.options.prepared) entry.bytes.fill(0);
  const result = await pending;
  expect(result.status).toBe('collected');
  expect(f.bytesSeen).toEqual(preparedBytes);
});
it.each(['foreign-operation', 'wrong-capability'])(
  'fails an operation not bound to this scope/capability: %s',
  async (mode) => {
    const f = fixture(mode);
    const result = await createA12StandardIntakeCollector(f.options).collect();
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid' });
    expect(f.original.read).not.toHaveBeenCalled();
  },
);
it.each(['cursor-cycle', 'sequence-repeat', 'event-limit'])(
  'bounds cross-page event history and rejects %s without exposing cursor/message',
  async (mode) => {
    const f = fixture(mode);
    const result = await createA12StandardIntakeCollector(f.options).collect();
    expect(result).toMatchObject({
      status: 'failed',
      reason: mode === 'event-limit' ? 'event_bound_exhausted' : 'invalid',
    });
    expect(
      f.calls.filter(({ id }) => id === 'data.operation.events'),
    ).toHaveLength(mode === 'event-limit' ? 3 : 2);
    expect(JSON.stringify(result)).not.toContain('opaque-');
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(f.createInventory).not.toHaveBeenCalled();
  },
);
it('stops bounded pending status polling after three post-submit read rounds without reading unbounded events', async () => {
  const f = fixture('status-limit');
  const result = await createA12StandardIntakeCollector(f.options).collect();
  expect(result).toMatchObject({
    status: 'failed',
    reason: 'status_bound_exhausted',
  });
  expect(f.calls.filter(({ id }) => id === 'data.ingestion.get')).toHaveLength(
    4,
  );
  expect(f.calls.filter(({ id }) => id === 'data.operation.get')).toHaveLength(
    3,
  );
  expect(
    f.calls.filter(({ id }) => id === 'data.operation.events'),
  ).toHaveLength(0);
  expect(f.createInventory).not.toHaveBeenCalled();
});
it('preserves a typed submit denial, retains earlier dispatch and never retries/replaces it', async () => {
  const f = fixture('denied');
  const result = await createA12StandardIntakeCollector(f.options).collect();
  expect(result).toMatchObject({ status: 'failed', reason: 'denied' });
  expect(
    f.calls.filter(({ id }) => id === 'data.ingestion.submit'),
  ).toHaveLength(1);
  expect(
    f.calls.filter(({ id }) => id === 'data.uploadSession.create'),
  ).toHaveLength(1);
  expect(f.createInventory).not.toHaveBeenCalled();
});
it('stops after binary original mismatch rather than claiming scanner verification', async () => {
  const f = fixture('original-drift');
  const result = await createA12StandardIntakeCollector(f.options).collect();
  expect(result).toMatchObject({ status: 'failed', reason: 'drift' });
  expect(f.original.read).toHaveBeenCalledTimes(1);
});
it('does not mint verified from DTO/hash/JSON flags when the normal scan window is unknown', async () => {
  const f = fixture();
  const value = createA12StandardIntakeCollector(f.options);
  const result = await value.collect();
  expect(result.status).toBe('collected');
  if (result.status !== 'collected')
    throw new Error('expected synthetic full collection before verifier check');
  expect(result.standardAuthority).toBe('unknown');
  const frozen = readFrozenCandidateInput({
    ...f.frozenControl,
    provenance: {
      kind: 'standard-intake-http',
      receiptSha256: sha(result.receiptBytes),
      inventorySha256: sha(result.inventoryBytes),
    },
    ...object(decoded(result.inventoryBytes)),
  });
  expect(frozen.status).toBe('ready');
  if (frozen.status !== 'ready')
    throw new Error('incomplete synthetic frozen collection');
  const check: A12StandardIntakeCheck = {
    receipt: decoded(result.receiptBytes),
    captureBytes: result.captureBytes,
    prepared: result.prepared,
    inventory: frozen.input,
  };
  expect(await value.verifyStandardIntake(check)).toBe('unknown');
  const cloneOwner = createA12StandardIntakeCollector(fixture().options);
  expect(await cloneOwner.verifyStandardIntake(check)).toBe('rejected');
  expect(
    await value.verifyStandardIntake({
      ...check,
      captureBytes: Uint8Array.from(
        Buffer.from('copied-valid-json-is-not-an-owned-capture'),
      ),
    }),
  ).toBe('rejected');
});
it('closes only transferred owned adapters once and no second collect can dispatch again', async () => {
  const f = fixture();
  const value = createA12StandardIntakeCollector(f.options);
  await value.collect();
  const before = f.calls.length;
  value.close();
  value.close();
  await value.collect();
  expect(f.calls).toHaveLength(before);
  expect(f.apiClose).toHaveBeenCalledTimes(1);
  expect(f.originalClose).toHaveBeenCalledTimes(1);
});

it('collects known PARTIAL inventory faithfully without turning it into a formal READY dataset', async () => {
  const f = fixture('partial');
  const result = await createA12StandardIntakeCollector(f.options).collect();
  expect(result.status).toBe('collected');
  if (result.status !== 'collected')
    throw new Error('expected synthetic complete collection');
  expect(
    IngestionCandidateBatchSchema.parse(
      object(decoded(result.inventoryBytes)).batch,
    ).status,
  ).toBe('PARTIAL');
  expect(
    readFrozenCandidateInput({
      ...f.frozenControl,
      ...object(decoded(result.inventoryBytes)),
    }).status,
  ).toBe('not_run');
});
it('rejects accessor configuration without evaluating it or taking ownership of adapters', () => {
  const f = fixture();
  const getter = vi.fn(() => {
    throw new Error(marker);
  });
  const input = { ...f.options };
  Object.defineProperty(input, 'prepared', { get: getter, enumerable: true });
  expect(() => createA12StandardIntakeCollector(input)).toThrow(
    CandidateLoadTransportError,
  );
  expect(getter).not.toHaveBeenCalled();
  expect(f.api.send).not.toHaveBeenCalled();
  expect(f.apiClose).not.toHaveBeenCalled();
});
it('rejects SHA/size of pre-sanitize original when it differs from actual prepared bytes before dispatch', () => {
  const f = fixture();
  f.options.prepared[0]!.bytes.fill(0);
  expect(() => createA12StandardIntakeCollector(f.options)).toThrow(
    CandidateLoadTransportError,
  );
  expect(f.api.send).not.toHaveBeenCalled();
  expect(f.apiClose).not.toHaveBeenCalled();
});
it('close before collection preserves not_run/cancelled and transfers no raw error to result', async () => {
  const f = fixture();
  const value = createA12StandardIntakeCollector(f.options);
  value.close();
  expect(await value.collect()).toEqual({
    status: 'not_run',
    reason: 'cancelled',
    attemptedHttp: 0,
  });
  expect(f.api.send).not.toHaveBeenCalled();
  expect(f.apiClose).toHaveBeenCalledTimes(1);
  expect(f.originalClose).toHaveBeenCalledTimes(1);
});

it('retains submit denial as first cause even when owned cleanup throws private text', async () => {
  const f = fixture('denied');
  f.apiClose.mockImplementation(() => {
    throw new Error(marker);
  });
  const result = await createA12StandardIntakeCollector(f.options).collect();
  expect(result).toMatchObject({ status: 'failed', reason: 'denied' });
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(f.originalClose).toHaveBeenCalledTimes(1);
});
it('reuses the same in-flight collection without issuing a duplicate fresh upload', async () => {
  const f = fixture();
  const value = createA12StandardIntakeCollector(f.options);
  const [left, right] = await Promise.all([value.collect(), value.collect()]);
  expect(left.status).toBe('collected');
  expect(right).toEqual(left);
  expect(
    f.calls.filter(({ id }) => id === 'data.uploadSession.create'),
  ).toHaveLength(1);
  expect(f.apiClose).toHaveBeenCalledTimes(1);
  expect(f.originalClose).toHaveBeenCalledTimes(1);
});

it.each([
  'ingestion-operation-id',
  'submit-operation-id',
  'submit-operation-capability',
  'current-operation-id',
])(
  'rejects valid-schema DTO that changes the owned Operation binding: %s',
  async (mode) => {
    const f = fixture(mode);
    const result = await createA12StandardIntakeCollector(f.options).collect();
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid' });
    if (mode === 'ingestion-operation-id')
      expect(
        f.calls.filter(({ id }) => id === 'data.ingestion.submit'),
      ).toHaveLength(0);
    if (mode.startsWith('submit-'))
      expect(
        f.calls.filter(({ id }) => id === 'data.ingestion.get'),
      ).toHaveLength(1);
    expect(
      f.calls.filter(({ id }) => id === 'data.operation.events'),
    ).toHaveLength(0);
    expect(f.createInventory).not.toHaveBeenCalled();
    expect(f.original.read).not.toHaveBeenCalled();
  },
);
it.each([
  'completed-order',
  'builder-order',
  'ingestion-order',
  'inventory-order',
])(
  'rejects same-set asset reorder in stage %s instead of using set membership as ordinal proof',
  async (mode) => {
    const f = fixture(mode);
    const result = await createA12StandardIntakeCollector(f.options).collect();
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid' });
    if (mode === 'completed-order' || mode === 'builder-order')
      expect(
        f.calls.filter(({ id }) => id === 'data.ingestion.create'),
      ).toHaveLength(0);
    if (mode === 'ingestion-order')
      expect(
        f.calls.filter(({ id }) => id === 'data.ingestion.submit'),
      ).toHaveLength(0);
    if (mode === 'inventory-order')
      expect(f.createInventory).toHaveBeenCalledTimes(1);
    expect(f.original.read).not.toHaveBeenCalled();
  },
);
it('rejects candidate source SHA drift despite valid public schema and generated asset-set identity', async () => {
  const f = fixture('candidate-hash');
  const result = await createA12StandardIntakeCollector(f.options).collect();
  expect(result).toMatchObject({ status: 'failed', reason: 'drift' });
  expect(f.original.read).not.toHaveBeenCalled();
});
