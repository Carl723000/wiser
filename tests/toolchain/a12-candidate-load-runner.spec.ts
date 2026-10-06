import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  CompleteUploadSessionInputSchema,
  CompleteUploadSessionOutputSchema,
  CreateIngestionInputSchema,
  CreateIngestionOutputSchema,
  CreateUploadSessionInputSchema,
  CreateUploadSessionOutputSchema,
  GetIngestionOutputSchema,
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordPageSchema,
  OperationEventPageSchema,
  OperationSchema,
} from '../../packages/data-contracts/src/index.ts';
import {
  CandidateLoadTransportError,
  pageFingerprint,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import type {
  LoadAction,
  LoadPage,
  LoadRequest,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import { traversalContentDigest } from '../../apps/web/e2e-live/support/a12-candidate-load-traversal.ts';
import type { CandidateLoadAuthCondition } from '../../apps/web/e2e-live/support/a12-candidate-load-auth.ts';
import {
  admitA12RunInput,
  runA12CandidateMatrix,
} from '../../apps/web/e2e-live/support/a12-candidate-load-runner.ts';
import type {
  A12ArtifactPin,
  A12DispatchLocation,
  A12RunInput,
  A12RunnerPorts,
} from '../../apps/web/e2e-live/support/a12-candidate-load-runner.ts';

// Pure synthetic tool test. No actual HTTP/Auth/SQL/scanner or S10-scale receipt.
// The eventual implementation must call existing real driver/once-traversal,
// rather than mock them. A fake transport does not prove formal A12 or latency.
const hashBytes = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const fingerprint = (value: unknown) =>
  hashBytes(Buffer.from(JSON.stringify(value)));
const uuid = (ordinal: number) =>
  `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
const at = '2026-10-06T00:00:00Z';
const rawMarker = 'private-original-never-report';
const scope = { tenantId: uuid(1), projectId: uuid(2), purpose: 'research' };
const columns = [
  { key: 'original', label: '原值' },
  { key: 'missing', label: '来源缺项' },
];
function fixture(pagedRecords = false) {
  const artifacts = new Map<string, Uint8Array>();
  const pin = (path: string, bytes: Uint8Array): A12ArtifactPin => {
    artifacts.set(path, bytes);
    return { path, sha256: hashBytes(bytes) };
  };
  const jsonPin = (path: string, value: unknown) =>
    pin(path, Buffer.from(JSON.stringify(value)));
  function member(ordinal: number) {
    const preparedBytes = Buffer.from(`benign independent source ${ordinal}`);
    const assetId = uuid(100 + ordinal),
      ingestionId = uuid(200 + ordinal);
    const operationId = uuid(300 + ordinal),
      uploadSessionId = uuid(400 + ordinal);
    const preparedSha = hashBytes(preparedBytes);
    const reference = {
      kind: 'ingestion-candidate' as const,
      ingestionId,
      processingBatchId: uuid(500 + ordinal),
      reviewHash: fingerprint({ ordinal }),
    };
    const asset = {
      assetId,
      status: 'READY' as const,
      sourceHash: preparedSha,
      recordCount: 2,
      featureCount: 1,
      reason: null,
    };
    const records = [
      {
        assetId,
        recordId: uuid(600 + ordinal * 2),
        index: 1,
        sourceId: null,
        values: { original: null },
        hasGeometry: false,
      },
      {
        assetId,
        recordId: uuid(601 + ordinal * 2),
        index: 3,
        sourceId: null,
        values: { original: '', missing: rawMarker },
        hasGeometry: true,
      },
    ];
    const features = [
      {
        assetId,
        recordId: records[1]!.recordId,
        index: 3,
        sourceId: null,
        sourceCrs: null,
        geometry: {
          type: 'GeometryCollection' as const,
          geometries: [
            { type: 'Point' as const, coordinates: [0, 0] },
            { type: 'Point' as const, coordinates: [1, 1] },
          ],
        },
      },
    ];
    const batch = IngestionCandidateBatchSchema.parse({
      reference,
      parserVersion: 'tiny-tool-control-1',
      status: 'READY',
      createdAt: at,
      assets: [asset],
    });
    const pages: Record<LoadAction, LoadPage> = {
      get: IngestionCandidateAssetPageSchema.parse({
        ...batch,
        totalAssetCount: 1,
        knownRecordCount: 2,
        knownFeatureCount: 1,
        unknownAssetCount: 0,
        nextCursor: null,
      }),
      records: IngestionCandidateRecordPageSchema.parse({
        reference,
        assetId,
        columns,
        records: pagedRecords ? records.slice(0, 1) : records,
        nextCursor: pagedRecords ? 'synthetic-page-2' : null,
      }),
      geometry: IngestionCandidateGeometryPageSchema.parse({
        reference,
        assetId,
        crs: 'EPSG:4326',
        features,
        nextCursor: null,
      }),
    };
    const inventory = {
      batch,
      materials: [
        {
          assetId,
          columns,
          recordsDigest: traversalContentDigest(
            'records',
            columns,
            records,
            fingerprint,
          ),
          geometryDigest: traversalContentDigest(
            'geometry',
            [],
            features,
            fingerprint,
          ),
        },
      ],
      firstPages: (['get', 'records', 'geometry'] as const).flatMap((action) =>
        ([50, 200] as const).map((first) => ({
          action,
          first,
          assetId: action === 'get' ? null : assetId,
          digest: pageFingerprint(pages[action], fingerprint),
        })),
      ),
    };
    const uploadSession = {
      uploadSessionId,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      status: 'OPEN' as const,
      assetIds: [assetId],
      version: 1,
      expiresAt: '2026-10-07T00:00:00Z',
      createdAt: at,
    };
    const operation = {
      operationId,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      capabilityId: 'data.ingestion.create',
      status: 'WAITING_REVIEW' as const,
      resource: `operation://${operationId}`,
      progressPercent: 90,
      version: 3,
      createdAt: at,
      updatedAt: at,
    };
    const receipt = {
      createUpload: {
        input: CreateUploadSessionInputSchema.parse({
          ownerProjectId: scope.projectId,
          objects: [
            {
              fileName: `benign-${ordinal}.txt`,
              mediaType: 'text/plain',
              sizeBytes: preparedBytes.length,
              sha256: preparedSha,
            },
          ],
        }),
        output: CreateUploadSessionOutputSchema.parse({
          uploadSession,
          uploadTargets: [
            {
              assetId,
              method: 'PRESIGNED_PUT',
              uploadUrl: 'http://127.0.0.1:1/no-request',
              headers: {},
            },
          ],
        }),
      },
      completeUpload: {
        input: CompleteUploadSessionInputSchema.parse({
          uploadSessionId,
          expectedVersion: 1,
          objects: [
            { assetId, sizeBytes: preparedBytes.length, sha256: preparedSha },
          ],
        }),
        output: CompleteUploadSessionOutputSchema.parse({
          uploadSession: {
            ...uploadSession,
            status: 'COMPLETED',
            version: 2,
            completedAt: at,
          },
        }),
      },
      createIngestion: {
        input: CreateIngestionInputSchema.parse({
          assetIds: [assetId],
          ownerProjectId: scope.projectId,
          intendedUses: ['research'],
          requestedSecurityLevel: 'L1_INTERNAL',
        }),
        output: CreateIngestionOutputSchema.parse({ ingestionId, operation }),
      },
      getIngestion: GetIngestionOutputSchema.parse({
        ingestion: {
          ingestionId,
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          assetIds: [assetId],
          intendedUses: ['research'],
          requestedSecurityLevel: 'L1_INTERNAL',
          state: 'REVIEW_REQUIRED',
          operationId,
          version: 3,
          createdAt: at,
          updatedAt: at,
        },
        candidateReference: reference,
      }),
      operation: OperationSchema.parse(operation),
      events: OperationEventPageSchema.parse({
        items: [
          {
            eventId: uuid(700 + ordinal),
            operationId,
            sequence: 1,
            eventType: 'WAITING_REVIEW',
            status: 'WAITING_REVIEW',
            progressPercent: 90,
            operationVersion: 3,
            occurredAt: at,
          },
        ],
      }),
    };
    const definition = {
      receipt: jsonPin(`receipt-${ordinal}`, receipt),
      inventory: jsonPin(`inventory-${ordinal}`, inventory),
      standardCapture: jsonPin(`capture-${ordinal}`, {
        scope: 'synthetic-tool-only',
        ordinal,
      }),
      preparedAssets: [
        {
          assetId,
          artifact: pin(`prepared-${ordinal}`, preparedBytes),
          sizeBytes: preparedBytes.length,
        },
      ],
    };
    return {
      ordinal,
      assetId,
      reference,
      pages,
      secondRecordsPage: IngestionCandidateRecordPageSchema.parse({
        reference,
        assetId,
        columns,
        records: records.slice(1),
        nextCursor: null,
      }),
      receipt,
      inventory,
      definition,
    };
  }
  const members = [member(1), member(2), member(3), member(4)];
  const input = {
    registrationId: 'GOAL101-A12-20261004',
    scope,
    tracks: [
      {
        dataset: 'AUTHENTICATED-REAL',
        declared: { members: 2, assets: 2, records: 4, geometry: 2 },
        sampleMembers: { get: 1, records: 1, geometry: 2 },
        members: [members[0]!.definition, members[1]!.definition],
      },
      {
        dataset: 'SYNTHETIC-S10',
        declared: { members: 2, assets: 2, records: 4, geometry: 2 },
        sampleMembers: { get: 1, records: 1, geometry: 2 },
        members: [members[2]!.definition, members[3]!.definition],
      },
    ],
  } satisfies A12RunInput;
  const requests: { location: A12DispatchLocation; request: LoadRequest }[] =
    [];
  const transports: {
    close: ReturnType<typeof vi.fn>;
    active: number;
    peak: number;
    location: A12DispatchLocation;
  }[] = [];
  let ticks = 0,
    dispatches = 0;
  let failAt: number | null = null,
    failKind: 'denied' | 'unavailable' = 'denied';
  let failedTraversalMember: number | null = null;
  let generation = 0;
  let guardClosed = false;
  let tokenReads = 0;
  const summary = {
    identityDigest: 'a'.repeat(64),
    authorityDigest: 'b'.repeat(64),
    claimsVerified: true as const,
    sessionTokenMatched: true as const,
    identityMatched: true as const,
    necessaryCandidateScopes: true as const,
    maintainerScope: false,
    reviewerScope: false,
    candidateAuthority: 'requires-current-candidate-get' as const,
  };
  const guard = {
    verifyCondition: vi.fn(() => {
      const ownGeneration = ++generation;
      return Promise.resolve({
        summary,
        accessToken: () => {
          tokenReads += 1;
          if (guardClosed)
            return Promise.reject(new CandidateLoadTransportError('cancelled'));
          if (generation !== ownGeneration)
            return Promise.reject(new CandidateLoadTransportError('stale'));
          return Promise.resolve('synthetic-tool-token-never-report');
        },
      });
    }),
    close: vi.fn(() => {
      guardClosed = true;
    }),
  };
  const ports: A12RunnerPorts = {
    readArtifact: vi.fn((artifact: A12ArtifactPin) => {
      const bytes = artifacts.get(artifact.path);
      if (bytes === undefined) return Promise.reject(Error(rawMarker));
      return Promise.resolve(Uint8Array.from(bytes));
    }),
    verifyStandardIntake: vi.fn(() => Promise.resolve('verified' as const)),
    authenticate: vi.fn(() => Promise.resolve(guard)),
    createTransport: vi.fn(
      (
        currentCondition: CandidateLoadAuthCondition,
        location: A12DispatchLocation,
      ) => {
        const state = {
          close: vi.fn(),
          active: 0,
          peak: 0,
          location: structuredClone(location),
        };
        transports.push(state);
        return {
          send: async (request: LoadRequest) => {
            state.active += 1;
            state.peak = Math.max(state.peak, state.active);
            try {
              if (state.close.mock.calls.length !== 0)
                throw new CandidateLoadTransportError('cancelled');
              await currentCondition.accessToken();
              requests.push({ location: structuredClone(location), request });
              dispatches += 1;
              await Promise.resolve();
              if (
                dispatches === failAt ||
                (location.phase === 'traversal' &&
                  location.trackOrdinal === 1 &&
                  location.roundOrdinal === 1 &&
                  location.memberOrdinal === failedTraversalMember)
              )
                throw new CandidateLoadTransportError(failKind);
              const selected = members.find(
                (item) =>
                  item.reference.ingestionId === request.reference.ingestionId,
              );
              if (selected === undefined) throw Error(rawMarker);
              const body = structuredClone(
                pagedRecords &&
                  request.action === 'records' &&
                  request.after !== undefined
                  ? selected.secondRecordsPage
                  : selected.pages[request.action],
              );
              return {
                boundary: 'api-http' as const,
                status: 200,
                contentType: 'application/json',
                wireBytes: Buffer.byteLength(JSON.stringify(body)),
                body,
              };
            } finally {
              state.active -= 1;
            }
          },
          close: state.close,
          diagnostics: () => ({
            activeRequests: state.active,
            closed: state.close.mock.calls.length !== 0,
          }),
        };
      },
    ),
    now: () => ++ticks, // Tool-only fake clock; never actual performance evidence.
    fingerprint,
  };
  const repinReceipt = (index: number) => {
    const selected = members[index]!;
    selected.definition.receipt = jsonPin(
      `receipt-${selected.ordinal}`,
      selected.receipt,
    );
  };
  const repinInventory = (index: number) => {
    const selected = members[index]!;
    selected.definition.inventory = jsonPin(
      `inventory-${selected.ordinal}`,
      selected.inventory,
    );
  };
  return {
    input,
    ports,
    members,
    requests,
    transports,
    guard,
    tokenReadCount: () => tokenReads,
    artifacts,
    repinReceipt,
    repinInventory,
    fail: (ordinal: number, kind: 'denied' | 'unavailable' = 'denied') => {
      failAt = ordinal;
      failKind = kind;
    },
    failTraversal: (memberOrdinal: number) => {
      failedTraversalMember = memberOrdinal;
    },
  };
}
function expectNoDispatch(f: ReturnType<typeof fixture>) {
  expect(f.ports.authenticate).not.toHaveBeenCalled();
  expect(f.ports.createTransport).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(0);
}

it('control: the independent synthetic fixture uses actual public DTO schemas and actual byte pins', () => {
  const f = fixture();
  for (const m of f.members) {
    expect(
      IngestionCandidateBatchSchema.safeParse(m.inventory.batch).success,
    ).toBe(true);
    expect(hashBytes(f.artifacts.get(m.definition.receipt.path)!)).toBe(
      m.definition.receipt.sha256,
    );
    expect(hashBytes(f.artifacts.get(m.definition.inventory.path)!)).toBe(
      m.definition.inventory.sha256,
    );
    expect(m.pages.geometry).toMatchObject({
      features: [{ geometry: { type: 'GeometryCollection' } }],
    });
  }
  expect(f.requests).toHaveLength(0);
});

it('admits all independently pinned receipts/inventories/prepared bytes before Auth; snapshots input immutably', async () => {
  const f = fixture();
  const result = await admitA12RunInput(f.input, f.ports);
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') return;
  expect(result.input.tracks.map((track) => track.members.length)).toEqual([
    2, 2,
  ]);
  expect(f.ports.verifyStandardIntake).toHaveBeenCalledTimes(4);
  for (const [index, member] of f.members.entries()) {
    const check = vi.mocked(f.ports.verifyStandardIntake).mock.calls[index]![0];
    expect(check.receipt).toEqual(member.receipt);
    expect(Array.from(check.captureBytes)).toEqual(
      Array.from(f.artifacts.get(member.definition.standardCapture.path)!),
    );
    expect(check.prepared).toEqual([
      {
        assetId: member.assetId,
        sha256: member.definition.preparedAssets[0]!.artifact.sha256,
        sizeBytes: member.definition.preparedAssets[0]!.sizeBytes,
      },
    ]);
    expect(check.inventory.batch).toEqual(member.inventory.batch);
  }
  expect(Object.isFrozen(result.input)).toBe(true);
  expect(
    Object.isFrozen(result.input.tracks[0]!.members[0]!.batch.reference),
  ).toBe(true);
  const before = result.input.tracks[0]!.members[0]!.batch.reference.reviewHash;
  f.members[0]!.inventory.batch.reference.reviewHash = 'e'.repeat(64);
  expect(result.input.tracks[0]!.members[0]!.batch.reference.reviewHash).toBe(
    before,
  );
  expectNoDispatch(f);
});

it.each(['receipt', 'inventory', 'prepared', 'standardCapture'] as const)(
  'rejects changed actual %s bytes despite valid 64-hex declaration',
  async (kind) => {
    const f = fixture(),
      definition = f.members[0]!.definition;
    const artifact =
      kind === 'prepared'
        ? definition.preparedAssets[0]!.artifact
        : definition[kind];
    f.artifacts.set(artifact.path, Buffer.from('actual changed private bytes'));
    expect(await admitA12RunInput(f.input, f.ports)).toEqual({
      status: 'not_run',
      reason: 'artifact_hash_mismatch',
    });
    expectNoDispatch(f);
  },
);

it('rejects self-certified step labels and SHA-shaped strings as standard-intake receipt proof', async () => {
  const f = fixture(),
    definition = f.members[0]!.definition;
  const bytes = Buffer.from(
    JSON.stringify({
      status: 'ok',
      steps: ['upload', 'scan', 'fingerprint', 'ready'],
      receiptSha256: 'a'.repeat(64),
      inventorySha256: 'b'.repeat(64),
    }),
  );
  f.artifacts.set(definition.receipt.path, bytes);
  definition.receipt = {
    path: definition.receipt.path,
    sha256: hashBytes(bytes),
  };
  expect(await admitA12RunInput(f.input, f.ports)).toEqual({
    status: 'not_run',
    reason: 'receipt_link_mismatch',
  });
  expectNoDispatch(f);
});

it('valid existing public receipts without actual scanner/fingerprint capture remain not_run', async () => {
  const f = fixture();
  const ports = {
    ...f.ports,
    verifyStandardIntake: vi.fn(() => Promise.resolve('unknown' as const)),
  };
  expect(await admitA12RunInput(f.input, ports)).toEqual({
    status: 'not_run',
    reason: 'standard_intake_unverified',
  });
  expectNoDispatch(f);
});

it.each([
  'tenant',
  'incomplete-upload',
  'operation',
  'reference',
  'submitted-hash',
] as const)(
  'rejects a hash-valid receipt with broken %s association',
  async (fault) => {
    const f = fixture(),
      receipt = f.members[0]!.receipt;
    if (fault === 'tenant')
      receipt.completeUpload.output.uploadSession.tenantId = uuid(999);
    if (fault === 'incomplete-upload')
      receipt.completeUpload.output.uploadSession.status = 'OPEN';
    if (fault === 'operation')
      delete receipt.getIngestion.ingestion.operationId;
    if (fault === 'reference')
      receipt.getIngestion.candidateReference!.processingBatchId = uuid(999);
    if (fault === 'submitted-hash')
      receipt.completeUpload.input.objects[0]!.sha256 = 'e'.repeat(64);
    f.repinReceipt(0);
    expect(await admitA12RunInput(f.input, f.ports)).toEqual({
      status: 'not_run',
      reason: 'receipt_link_mismatch',
    });
    expectNoDispatch(f);
  },
);

it('a consistent Operation for another capability cannot prove standard ingestion', async () => {
  const f = fixture(),
    receipt = f.members[0]!.receipt;
  receipt.createIngestion.output.operation.capabilityId = 'data.upload.create';
  receipt.operation.capabilityId = 'data.upload.create';
  f.repinReceipt(0);
  expect(await admitA12RunInput(f.input, f.ports)).toEqual({
    status: 'not_run',
    reason: 'receipt_link_mismatch',
  });
  expectNoDispatch(f);
});

it('receipt association permits normal pending-to-waiting progress and an approved readable candidate without requiring publication', async () => {
  const f = fixture();
  f.members[0]!.receipt.createIngestion.output.operation.status = 'PENDING';
  f.members[0]!.receipt.createIngestion.output.operation.version = 1;
  f.members[0]!.receipt.createIngestion.output.operation.progressPercent = 0;
  f.repinReceipt(0);
  expect((await admitA12RunInput(f.input, f.ports)).status).toBe('ready');
  expectNoDispatch(f);
  const g = fixture();
  g.members[0]!.receipt.getIngestion.ingestion.state = 'APPROVED';
  g.members[0]!.receipt.operation.status = 'SUCCEEDED';
  g.members[0]!.receipt.operation.completedAt = at;
  g.repinReceipt(0);
  expect((await admitA12RunInput(g.input, g.ports)).status).toBe('ready');
  expectNoDispatch(g);
});

it('candidate sourceHash must match the actual uploaded prepared bytes, not a plausible original SHA', async () => {
  const f = fixture();
  f.members[0]!.inventory.batch.assets[0]!.sourceHash = 'e'.repeat(64);
  f.repinInventory(0);
  expect(await admitA12RunInput(f.input, f.ports)).toEqual({
    status: 'not_run',
    reason: 'receipt_link_mismatch',
  });
  expectNoDispatch(f);
});

it('an accessor is rejected without evaluating private input or contacting any port', async () => {
  const f = fixture(),
    getter = vi.fn(() => {
      throw Error(rawMarker);
    });
  const value = { ...f.input };
  Object.defineProperty(value, 'tracks', { enumerable: true, get: getter });
  expect(await admitA12RunInput(value, f.ports)).toEqual({
    status: 'not_run',
    reason: 'configuration',
  });
  expect(getter).not.toHaveBeenCalled();
  expect(f.ports.readArtifact).not.toHaveBeenCalled();
  expectNoDispatch(f);
});

it('independent manifest totals reject omitted members and unknown counts; never learn a denominator from first GET', async () => {
  const f = fixture();
  f.input.tracks[0].members.pop();
  expect(await admitA12RunInput(f.input, f.ports)).toEqual({
    status: 'not_run',
    reason: 'incomplete_inventory',
  });
  expectNoDispatch(f);
  const g = fixture();
  g.members[0]!.inventory.batch.assets[0]!.recordCount = null;
  g.repinInventory(0);
  expect(await admitA12RunInput(g.input, g.ports)).toEqual({
    status: 'not_run',
    reason: 'incomplete_inventory',
  });
  expectNoDispatch(g);
});

it('unknown registration/profile/track does not acquire invented or fallback thresholds', async () => {
  const f = fixture();
  expect(
    await admitA12RunInput(
      { ...f.input, registrationId: 'unknown-profile' },
      f.ports,
    ),
  ).toEqual({ status: 'not_run', reason: 'configuration' });
  expect(
    await admitA12RunInput(
      { ...f.input, thresholds: { medianMs: 99999 } },
      f.ports,
    ),
  ).toEqual({ status: 'not_run', reason: 'configuration' });
  expect(
    await admitA12RunInput(
      {
        ...f.input,
        tracks: [
          { ...f.input.tracks[0], dataset: 'UNKNOWN' },
          f.input.tracks[1],
        ],
      },
      f.ports,
    ),
  ).toEqual({ status: 'not_run', reason: 'configuration' });
  expectNoDispatch(f);
});

it('runs 18 fixed conditions per track with the existing 5+100 driver; uses all members in 20 real ordered rounds', async () => {
  const f = fixture(),
    result = await runA12CandidateMatrix(f.input, f.ports);
  expect(result.status).toBe('passed');
  expect(result.formalA12).toBe('not_run');
  expect(result.conditions).toHaveLength(36);
  for (const trackOrdinal of [1, 2]) {
    const conditions = result.conditions.filter(
      (item) => item.trackOrdinal === trackOrdinal,
    );
    expect(conditions.map((item) => item.result.condition)).toEqual(
      (['get', 'records', 'geometry'] as const).flatMap((action) =>
        ([50, 200] as const).flatMap((first) =>
          ([1, 4, 8] as const).map((concurrency) => ({
            dataset: f.input.tracks[trackOrdinal - 1]!.dataset,
            action,
            first,
            concurrency,
          })),
        ),
      ),
    );
    for (const item of conditions) {
      expect(item.result.status).toBe('passed');
      expect(item.result.warmup).toHaveLength(5);
      expect(item.result.measured).toHaveLength(100);
      expect(item.result.statistics.completed).toBe(100);
      expect(item.memberOrdinal).toBe(
        item.result.condition.action === 'geometry' ? 2 : 1,
      );
      const actual = f.requests.filter(
        (request) =>
          request.location.phase === 'condition' &&
          request.location.trackOrdinal === trackOrdinal &&
          request.location.conditionOrdinal === item.ordinal,
      );
      expect(actual).toHaveLength(105);
      for (const request of actual) {
        expect(request.request.action).toBe(item.result.condition.action);
        expect(request.request.first).toBe(item.result.condition.first);
        expect(request.request.after).toBeUndefined();
        expect(request.request.reference).toEqual(
          f.members[(trackOrdinal - 1) * 2 + item.memberOrdinal - 1]!.reference,
        );
      }
      const transport = f.transports.find(
        (entry) =>
          entry.location.phase === 'condition' &&
          entry.location.trackOrdinal === trackOrdinal &&
          entry.location.conditionOrdinal === item.ordinal,
      );
      expect(transport?.peak).toBe(item.result.condition.concurrency);
      expect(transport?.active).toBe(0);
    }
    expect(
      result.rounds
        .filter((round) => round.trackOrdinal === trackOrdinal)
        .map((round) => ({
          ordinal: round.ordinal,
          members: round.members.map((m) => ({
            memberOrdinal: m.memberOrdinal,
            outcome: m.result.outcome,
            counts: m.result.counts,
          })),
        })),
    ).toEqual(
      Array.from({ length: 20 }, (_, i) => ({
        ordinal: i + 1,
        members: [1, 2].map((memberOrdinal) => ({
          memberOrdinal,
          outcome: 'completed',
          counts: { assets: 1, records: 2, geometry: 1 },
        })),
      })),
    );
    const starts = f.requests.filter(
      (item) =>
        item.location.phase === 'traversal' &&
        item.location.trackOrdinal === trackOrdinal &&
        item.request.action === 'get',
    );
    expect(
      starts.map((item) => ({
        round: item.location.roundOrdinal,
        member: item.location.memberOrdinal,
        reference: item.request.reference.ingestionId,
      })),
    ).toEqual(
      Array.from({ length: 20 }, (_, i) =>
        [1, 2].map((member) => ({
          round: i + 1,
          member,
          reference:
            f.members[(trackOrdinal - 1) * 2 + member - 1]!.reference
              .ingestionId,
        })),
      ).flat(),
    );
  }
  expect(result.pageSamples).toHaveLength(240); // 2 tracks × 20 rounds × 2 members × 3 actual pages.
  expect(
    result.pageSamples.every(
      (sample) =>
        sample.elapsedMs !== null &&
        sample.elapsedMs > 0 &&
        sample.wireBytes !== null &&
        sample.wireBytes > 0,
    ),
  ).toBe(true);
  expect(
    f.requests.filter((item) => item.location.phase === 'condition'),
  ).toHaveLength(3780);
  expect(f.requests).toHaveLength(4020);
  expect(f.tokenReadCount()).toBe(4020);
  expect(f.transports.every((transport) => transport.active === 0)).toBe(true);
  expect(f.guard.verifyCondition).toHaveBeenCalledTimes(116); // 36 conditions + 80 member traversals.
  expect(
    f.transports.every((transport) => transport.close.mock.calls.length === 1),
  ).toBe(true);
  expect(f.guard.close).toHaveBeenCalledOnce();
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(rawMarker);
  expect(serialized).not.toContain('coordinates');
  for (const member of f.members)
    expect(serialized).not.toContain(member.reference.ingestionId);
});

it('denied after five warmups retains its first measured sample and stops all later conditions/rounds; no replacement', async () => {
  const f = fixture();
  f.fail(6);
  const result = await runA12CandidateMatrix(f.input, f.ports);
  expect(result.status).toBe('failed');
  expect(result.conditions).toHaveLength(1);
  expect(result.conditions[0]!.result.warmup).toHaveLength(5);
  expect(result.conditions[0]!.result.measured).toEqual([
    {
      ordinal: 1,
      elapsedMs: result.conditions[0]!.result.measured[0]?.elapsedMs,
      outcome: 'denied',
      wireBytes: null,
      dtoBytes: null,
    },
  ]);
  expect(result.conditions[0]!.result.measured[0]!.elapsedMs).toBeTypeOf(
    'number',
  );
  expect(f.requests).toHaveLength(6);
  expect(result.rounds).toHaveLength(0);
  expect(result.pageSamples).toHaveLength(0);
  expect(f.guard.close).toHaveBeenCalledOnce();
});

it('an unavailable measured sample is retained among exactly100 started samples and never replaced by a successful retry', async () => {
  const f = fixture();
  f.fail(6, 'unavailable');
  const result = await runA12CandidateMatrix(f.input, f.ports);
  expect(result.status).toBe('failed');
  expect(result.conditions).toHaveLength(1);
  expect(result.conditions[0]!.result.warmup).toHaveLength(5);
  expect(result.conditions[0]!.result.measured).toHaveLength(100);
  expect(result.conditions[0]!.result.measured[0]).toMatchObject({
    ordinal: 1,
    outcome: 'unavailable',
    wireBytes: null,
    dtoBytes: null,
  });
  expect(result.conditions[0]!.result.statistics).toMatchObject({
    completed: 99,
    failed: 1,
  });
  expect(f.requests).toHaveLength(105);
  expect(result.rounds).toHaveLength(0);
});

it('a first real page that differs from the frozen hash fails after dispatch instead of relearning the inventory', async () => {
  const f = fixture();
  f.members[0]!.inventory.firstPages[0]!.digest = 'e'.repeat(64);
  f.repinInventory(0);
  const result = await runA12CandidateMatrix(f.input, f.ports);
  expect(result.status).toBe('failed');
  expect(result.conditions).toHaveLength(1);
  expect(result.conditions[0]!.result.warmup[0]).toMatchObject({
    outcome: 'drift',
  });
  expect(f.requests).toHaveLength(1);
  expect(result.rounds).toHaveLength(0);
});

it('a round/member failure retains started work and stops later members, rounds and track; never reorder or retry', async () => {
  const f = fixture();
  f.failTraversal(2);
  const result = await runA12CandidateMatrix(f.input, f.ports);
  expect(result.status).toBe('failed');
  const requests = f.requests.filter(
    (item) => item.location.phase === 'traversal',
  );
  expect(
    requests.map((item) => [
      item.location.trackOrdinal,
      item.location.roundOrdinal,
      item.location.memberOrdinal,
      item.request.action,
    ]),
  ).toEqual([
    [1, 1, 1, 'get'],
    [1, 1, 1, 'records'],
    [1, 1, 1, 'geometry'],
    [1, 1, 2, 'get'],
  ]);
  expect(result.rounds).toHaveLength(1);
  expect(result.rounds[0]!.members.map((m) => m.result.outcome)).toEqual([
    'completed',
    'denied',
  ]);
  expect(result.pageSamples.at(-1)).toMatchObject({
    trackOrdinal: 1,
    roundOrdinal: 1,
    memberOrdinal: 2,
    pageOrdinal: 1,
    outcome: 'denied',
    wireBytes: null,
  });
  expect(
    f.transports.every((transport) => transport.close.mock.calls.length === 1),
  ).toBe(true);
});

it('raw read errors are fixed not_run failures with no private cause/path/body in the report', async () => {
  const f = fixture();
  const result = await runA12CandidateMatrix(f.input, {
    ...f.ports,
    readArtifact: () => Promise.reject(Error(rawMarker)),
  });
  expect(result).toMatchObject({
    status: 'not_run',
    reason: 'artifact_read_failed',
    conditions: [],
    rounds: [],
    pageSamples: [],
  });
  expect(JSON.stringify(result)).not.toContain(rawMarker);
  expectNoDispatch(f);
});

it('two-page member traversals actually consume continuation pages within every round', async () => {
  const f = fixture(true),
    result = await runA12CandidateMatrix(f.input, f.ports);
  expect(result.status).toBe('passed');
  const continued = f.requests.filter(
    (entry) =>
      entry.location.phase === 'traversal' &&
      entry.request.action === 'records' &&
      entry.request.after !== undefined,
  );
  expect(continued).toHaveLength(80);
  expect(
    continued.every((entry) => entry.request.after === 'synthetic-page-2'),
  ).toBe(true);
  expect(result.pageSamples).toHaveLength(320);
  expect(f.requests).toHaveLength(4100);
  expect(
    result.rounds.every((round) =>
      round.members.every((member) => member.result.counts.records === 2),
    ),
  ).toBe(true);
  expect(
    f.transports.every(
      (entry) => entry.active === 0 && entry.close.mock.calls.length === 1,
    ),
  ).toBe(true);
});

it.each(['denied', 'stale', 'cancelled'] as const)(
  'a later Auth verification %s preserves completed work and closes its guard',
  async (kind) => {
    const f = fixture();
    f.guard.verifyCondition.mockImplementationOnce(() =>
      Promise.resolve({
        summary: {
          identityDigest: 'a'.repeat(64),
          authorityDigest: 'b'.repeat(64),
          claimsVerified: true,
          sessionTokenMatched: true,
          identityMatched: true,
          necessaryCandidateScopes: true,
          maintainerScope: false,
          reviewerScope: false,
          candidateAuthority: 'requires-current-candidate-get',
        },
        accessToken: () => Promise.resolve('synthetic-tool-token-never-report'),
      }),
    );
    f.guard.verifyCondition.mockImplementationOnce(() =>
      Promise.reject(new CandidateLoadTransportError(kind)),
    );
    const result = await runA12CandidateMatrix(f.input, f.ports);
    expect(result).toMatchObject({ status: 'failed', reason: kind });
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]!.result.status).toBe('passed');
    expect(f.requests).toHaveLength(105);
    expect(f.transports).toHaveLength(1);
    expect(f.transports[0]!.close).toHaveBeenCalledOnce();
    expect(f.guard.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('synthetic-tool-token');
  },
);

it('a transport constructor exception is sanitized and releases the already acquired Auth guard', async () => {
  const f = fixture();
  const result = await runA12CandidateMatrix(f.input, {
    ...f.ports,
    createTransport: () => {
      throw Error(rawMarker);
    },
  });
  expect(result).toMatchObject({
    status: 'not_run',
    reason: 'unavailable',
    conditions: [],
    rounds: [],
  });
  expect(f.requests).toHaveLength(0);
  expect(f.guard.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(rawMarker);
});

it('invalid material DTOs keep actual page timing and bytes and stop the current traversal', async () => {
  const f = fixture(),
    create = f.ports.createTransport;
  const result = await runA12CandidateMatrix(f.input, {
    ...f.ports,
    createTransport: (condition, location) => {
      const adapter = create(condition, location);
      return {
        ...adapter,
        send: async (request) => {
          const reply = await adapter.send(request);
          if (location.phase === 'traversal' && request.action === 'records') {
            const body = {
              ...(reply.body as Record<string, unknown>),
              records: 'invalid-private-fixture',
            };
            return {
              ...reply,
              body,
              wireBytes: Buffer.byteLength(JSON.stringify(body)),
            };
          }
          return reply;
        },
      };
    },
  });
  expect(result.status).toBe('failed');
  expect(result.rounds).toHaveLength(1);
  expect(result.rounds[0]!.members[0]!.result.outcome).toBe('invalid');
  expect(result.pageSamples).toHaveLength(2);
  expect(result.pageSamples.at(-1)).toMatchObject({
    trackOrdinal: 1,
    roundOrdinal: 1,
    memberOrdinal: 1,
    pageOrdinal: 2,
    action: 'records',
    outcome: 'invalid',
  });
  expect(result.pageSamples.at(-1)?.elapsedMs).toBeTypeOf('number');
  expect(result.pageSamples.at(-1)?.wireBytes).toBeTypeOf('number');
  const started = f.requests.filter(
    (entry) => entry.location.phase === 'traversal',
  );
  expect(started.map((entry) => entry.request.action)).toEqual([
    'get',
    'records',
  ]);
  expect(JSON.stringify(result)).not.toContain('invalid-private-fixture');
  expect(
    f.transports.every(
      (entry) => entry.active === 0 && entry.close.mock.calls.length === 1,
    ),
  ).toBe(true);
});

it('a port accessor is rejected without reading it or invoking standard intake and Auth', async () => {
  const f = fixture(),
    getter = vi.fn(() => {
      throw Error(rawMarker);
    });
  const ports = { ...f.ports };
  Object.defineProperty(ports, 'authenticate', {
    enumerable: true,
    get: getter,
  });
  const result = await runA12CandidateMatrix(f.input, ports);
  expect(result).toMatchObject({ status: 'not_run', reason: 'configuration' });
  expect(getter).not.toHaveBeenCalled();
  expect(f.ports.readArtifact).not.toHaveBeenCalled();
  expectNoDispatch(f);
});

it('a cleanup exception preserves the first denial and its measured sample', async () => {
  const f = fixture();
  f.fail(6);
  f.guard.close.mockImplementation(() => {
    throw Error(rawMarker);
  });
  const result = await runA12CandidateMatrix(f.input, f.ports);
  expect(result).toMatchObject({ status: 'failed', reason: 'denied' });
  expect(f.requests).toHaveLength(6);
  expect(result.conditions).toHaveLength(1);
  expect(result.conditions[0]!.result.measured).toMatchObject([
    { ordinal: 1, outcome: 'denied' },
  ]);
  expect(f.guard.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(rawMarker);
});

it('a malformed returned Auth guard releases its own close without invoking its accessor', async () => {
  const f = fixture(),
    getter = vi.fn(() => {
      throw Error(rawMarker);
    });
  const ownGuard = { ...f.guard };
  Object.defineProperty(ownGuard, 'verifyCondition', {
    enumerable: true,
    get: getter,
  });
  const result = await runA12CandidateMatrix(f.input, {
    ...f.ports,
    authenticate: () => Promise.resolve(ownGuard),
  });
  expect(result).toMatchObject({ status: 'not_run', reason: 'configuration' });
  expect(getter).not.toHaveBeenCalled();
  expect(f.guard.verifyCondition).not.toHaveBeenCalled();
  expect(f.guard.close).toHaveBeenCalledOnce();
  expect(f.requests).toHaveLength(0);
  expect(f.ports.createTransport).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(rawMarker);
});

it('a malformed returned transport releases its own close without invoking its send accessor', async () => {
  const f = fixture(),
    create = f.ports.createTransport,
    getter = vi.fn(() => {
      throw Error(rawMarker);
    });
  const result = await runA12CandidateMatrix(f.input, {
    ...f.ports,
    createTransport: (condition, location) => {
      const ownAdapter = create(condition, location);
      Object.defineProperty(ownAdapter, 'send', {
        enumerable: true,
        get: getter,
      });
      return ownAdapter;
    },
  });
  expect(result).toMatchObject({ status: 'not_run', reason: 'configuration' });
  expect(getter).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(0);
  expect(f.transports).toHaveLength(1);
  expect(f.transports[0]!.close).toHaveBeenCalledOnce();
  expect(f.guard.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(rawMarker);
});
