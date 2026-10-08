import { describe, expect, it, vi } from 'vitest';
import { wordPairFixture } from './candidate-conversion-fixture.js';
import { createHash } from 'node:crypto';
import type { SourceRegistration } from '@wiser/data-contracts';

import type { ClaimedDataJob, DataPostgresPool } from '@wiser/data-infra';
import {
  FixtureFakeAiPlanner,
  FixtureFakeAiPlanValidator,
  PostgresIngestionAuthority,
  type IngestionRuntimePool,
} from '../src/adapters/ingestion-runtime.js';
import { createIngestionCandidateProcessor } from '../src/handlers/ingestion-candidate.js';

import { DataJobHandlerError } from '../src/handlers/registry.js';
import {
  DATA_INGESTION_PROCESS_JOB_TYPE,
  IngestionPipelinePortError,
  canonicalPipelineHash,
  createIngestionPipelineHandler,
  type FrozenIngestionCheckpoint,
  type IngestionAssetCheckpoint,
  type IngestionAuthorityPort,
  type PipelineIngestionState,
  type IngestionPipelineOptions,
  type IngestionTransitionRequest,
} from '../src/handlers/ingestion-pipeline.js';

const payload = {
  ingestionId: '33333333-3333-4333-8333-333333333333',
  expectedState: 'RECEIVED',
  expectedVersion: 1,
} as const;

const job: ClaimedDataJob = {
  jobId: '55555555-5555-4555-8555-555555555555',
  tenantId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  operationId: '66666666-6666-4666-8666-666666666666',
  jobType: DATA_INGESTION_PROCESS_JOB_TYPE,
  payload,
  attemptCount: 1,
  maxAttempts: 5,
  leaseOwner: 'worker-a',
  leaseExpiresAt: '2026-08-22T01:00:00.000Z',
  rowVersion: 2,
  cancelRequested: false,
  securityLevel: 'L0_PUBLIC',
  policyVersion: 9,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class FakeAuthority implements IngestionAuthorityPort {
  readonly order: string[];
  readonly transitions: IngestionTransitionRequest[] = [];
  commits = 0;
  frozenCheckpoint?: FrozenIngestionCheckpoint;
  sourceRegistration?: SourceRegistration;
  reviewGovernance?: unknown;
  state: PipelineIngestionState = 'RECEIVED';
  version = 1;
  versionId?: string;
  securityLevel: 'L0_PUBLIC' | 'L2_RESTRICTED' = 'L0_PUBLIC';
  assets: IngestionAssetCheckpoint[] = [
    {
      assetId: '44444444-4444-4444-8444-444444444444',
      ordinal: 0,
      uploadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      objectRef: 'quarantine/object-0',
      mediaType: 'application/pdf',
      sourceKind: 'document' as const,
      size: 128,
    },
  ];

  constructor(order: string[]) {
    this.order = order;
  }

  load() {
    this.order.push('authority:load');
    return Promise.resolve({
      state: this.state,
      version: this.version,
      securityLevel: this.securityLevel,
      policyVersion: 9,
      assets: this.assets,
      ...(this.reviewGovernance === undefined
        ? {}
        : { reviewGovernance: this.reviewGovernance }),
      ...(this.sourceRegistration === undefined
        ? {}
        : { sourceRegistration: this.sourceRegistration }),
      ...(this.frozenCheckpoint === undefined
        ? {}
        : { frozenCheckpoint: this.frozenCheckpoint }),
      ...(this.versionId === undefined ? {} : { versionId: this.versionId }),
    });
  }

  freezeCheckpoint(
    request: Parameters<IngestionAuthorityPort['freezeCheckpoint']>[0],
  ) {
    expect(request.expectedState).toBe(this.state);
    expect(request.expectedVersion).toBe(this.version);
    this.order.push(`authority:${request.toState}`);
    this.state = request.toState;
    this.version += 1;
    this.frozenCheckpoint = structuredClone(request.checkpoint);
    return Promise.resolve({
      state: request.toState,
      version: this.version,
      reviewHash: request.checkpoint.reviewHash,
    });
  }

  transition(request: IngestionTransitionRequest) {
    expect(request.expectedState).toBe(this.state);
    expect(request.expectedVersion).toBe(this.version);
    this.transitions.push(structuredClone(request));
    this.order.push(`authority:${request.toState}`);
    this.state = request.toState;
    this.version += 1;
    return Promise.resolve({ state: request.toState, version: this.version });
  }

  recordFingerprints(
    request: Parameters<IngestionAuthorityPort['recordFingerprints']>[0],
  ) {
    expect(request.expectedState).toBe(this.state);
    expect(request.expectedVersion).toBe(this.version);
    this.order.push('authority:FINGERPRINTED');
    this.assets = this.assets.map((asset, index) => ({
      ...asset,
      sourceHash: request.fingerprints[index]!.sourceHash,
    }));
    this.state = 'FINGERPRINTED';
    this.version += 1;
    return Promise.resolve({
      state: 'FINGERPRINTED' as const,
      version: this.version,
    });
  }

  commit(request: Parameters<IngestionAuthorityPort['commit']>[0]) {
    expect(request.expectedState).toBe('APPROVED');
    expect(request.expectedVersion).toBe(this.version);
    this.order.push('authority:COMMITTED');
    this.state = 'COMMITTED';
    this.version += 1;
    this.commits += 1;
    this.versionId = '77777777-7777-4777-8777-777777777777';
    return Promise.resolve({
      state: 'COMMITTED' as const,
      version: this.version,
      versionId: this.versionId,
    });
  }
}

function setup(
  overrides: {
    readonly clean?: boolean;
    readonly risk?: 'LOW' | 'HIGH';
    readonly restricted?: boolean;
    readonly aiConfidence?: number;
    readonly blockingFailure?: boolean;
    readonly parserError?: Error;
    readonly parserFailures?: number;
    readonly validatorError?: Error;
    readonly securityLevel?: 'L0_PUBLIC' | 'L2_RESTRICTED';
    readonly assetCount?: 1 | 2;
  } = {},
) {
  const order: string[] = [];
  const authority = new FakeAuthority(order);
  authority.securityLevel = overrides.securityLevel ?? 'L0_PUBLIC';
  if (overrides.assetCount === 2) {
    authority.assets = [
      ...authority.assets,
      {
        assetId: '99999999-9999-4999-8999-999999999999',
        ordinal: 1,
        uploadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        objectRef: 'quarantine/object-1',
        mediaType: 'application/geo+json',
        sourceKind: 'geojson',
        size: 256,
      },
    ];
  }
  let parserFailures = overrides.parserFailures ?? 0;
  const options: IngestionPipelineOptions = {
    authority,
    quarantine: {
      put: ({ asset }) => {
        order.push('quarantine');
        return Promise.resolve({
          objectRef: asset.objectRef,
          size: asset.size,
        });
      },
    },
    scanner: {
      scan: () => {
        order.push('scan');
        return Promise.resolve({ clean: overrides.clean ?? true });
      },
    },
    fingerprint: {
      sha256: ({ objectRef }) => {
        order.push('fingerprint');
        return Promise.resolve(
          objectRef.endsWith('object-1') ? 'b'.repeat(64) : 'a'.repeat(64),
        );
      },
    },
    parser: {
      parse: ({ objectRef, sourceKind }) => {
        order.push('parse');
        if (parserFailures > 0) {
          parserFailures -= 1;
          return Promise.reject(
            new IngestionPipelinePortError(
              'TIKA_TEMPORARY',
              true,
              'temporary parser failure',
            ),
          );
        }
        if (overrides.parserError) return Promise.reject(overrides.parserError);
        return Promise.resolve({
          kind: sourceKind,
          contentHash: objectRef.endsWith('object-1')
            ? 'b'.repeat(64)
            : 'a'.repeat(64),
          metadata: { title: 'Water report' },
        });
      },
    },
    profiler: {
      profile: () => {
        order.push('profile');
        return Promise.resolve({ profileHash: 'c'.repeat(64) });
      },
    },
    classifier: {
      classify: () => {
        order.push('classify');
        return Promise.resolve({
          risk: overrides.risk ?? ('LOW' as const),
          restricted: overrides.restricted ?? false,
          confidence: 0.95,
          classificationHash: 'd'.repeat(64),
        });
      },
    },
    aiPlanner: {
      propose: () => {
        order.push('ai-plan');
        return Promise.resolve({
          schema: { fields: ['flow'] },
          semantics: ['river-flow'],
        });
      },
    },
    aiValidator: {
      validate: () => {
        order.push('validate-ai');
        if (overrides.validatorError) throw overrides.validatorError;
        return {
          schemaPlan: { fields: ['flow'] },
          semanticPlan: { concepts: ['river-flow'] },
          confidence: overrides.aiConfidence ?? 0.95,
        };
      },
    },
    transformer: {
      transform: () => {
        order.push('transform');
        return Promise.resolve({
          artifactRef: 'raw/sha256/a',
          outputHash: 'e'.repeat(64),
        });
      },
    },
    quality: {
      check: () => {
        order.push('quality');
        return Promise.resolve([
          {
            ruleId: 'schema.required',
            status: overrides.blockingFailure
              ? ('FAILED' as const)
              : ('PASSED' as const),
            weight: 1,
            blocking: true,
          },
        ]);
      },
    },
    aligner: {
      align: () => {
        order.push('align');
        return Promise.resolve({ alignmentHash: 'f'.repeat(64) });
      },
    },
    minimumQualityScore: 0.75,
    minimumAiConfidence: 0.8,
  };
  return {
    order,
    authority,
    options,
    handler: (candidate: ClaimedDataJob) =>
      createIngestionPipelineHandler(options)({
        ...candidate,
        securityLevel: authority.securityLevel,
      }),
  };
}

async function registeredGeoJsonScenario(
  mutation?: 'missing-asset' | 'wrong-hash',
) {
  const fixture = setup({ assetCount: 2 });
  const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
  const geojson = {
    type: 'FeatureCollection',
    features: [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
        [4, 4],
      ],
    ].map((coordinates, index) => ({
      type: 'Feature',
      properties: {
        name: `synthetic-reference-${index + 1}`,
        license: 'ODbL-1.0',
        attribution: 'Synthetic reference fixture; no collected OSM object',
        positionRole: 'open-geographical-reference',
        notAMonthlyObservationReach: true,
        reviewStatus: 'pending',
      },
      geometry: { type: 'LineString', coordinates },
    })),
  };
  const sourceBytes = Buffer.from(JSON.stringify(geojson));
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const [manifestAsset, geoAsset] = fixture.authority.assets;
  const body = JSON.stringify({
    schemaVersion: 'wiser.source-registration.v1',
    sourceId: 'synthetic-reference',
    record: { synthetic: true, license: 'ODbL-1.0', notAnObservation: true },
    files: [
      {
        assetId: geoAsset!.assetId,
        path: 'synthetic-reference.geojson',
        sha256: mutation === 'wrong-hash' ? 'f'.repeat(64) : sourceHash,
        sizeBytes: sourceBytes.length,
        preparedSha256: mutation === 'wrong-hash' ? 'f'.repeat(64) : sourceHash,
        preparedSizeBytes: sourceBytes.length,
        artifactClass: 'geographical-reference',
        completeness: 'PARTIAL',
        disposition: 'IMPORT',
        relatedSourceIds: ['synthetic-reference'],
      },
    ],
  });
  const manifestBytes = Buffer.from(body);
  const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
  const registration: SourceRegistration = {
    sourceId: 'synthetic-reference',
    kind: 'FILE_COLLECTION',
    name: 'Synthetic reference fixture',
    bundleId: 'synthetic-reference-test',
    providerName: 'Synthetic test',
    accessStatus: 'synthetic_reference_only',
    completeness: 'PARTIAL',
    manifestAssetId: manifestAsset!.assetId,
    manifestSha256: manifestHash,
    limitations: [
      'Geographical reference only; no observation or authority claim.',
    ],
  };
  const inputs = [manifestAsset!, geoAsset!].map((asset, index) => ({
    state: 'RECEIVED',
    row_version: 1,
    security_level: 'L0_PUBLIC',
    policy_version: 9,
    source_registration: registration,
    review_policy_snapshot: policy,
    current_review_policy: policy,
    asset_id: asset.assetId,
    ordinal: index,
    storage_key: `tenants/${job.tenantId}/projects/${job.projectId}/quarantine/${asset.uploadId}/object`,
    media_type: index === 0 ? 'application/json' : 'application/geo+json',
    byte_size: index === 0 ? manifestBytes.length : sourceBytes.length,
    source_hash: null,
    content_blob_id: null,
  }));
  const nativePool: IngestionRuntimePool = {
    async connect() {
      return {
        async query(sql) {
          return { rows: sql.includes('ingestion.runtime.load') ? inputs : [] };
        },
        release() {},
      };
    },
  };
  const native = new PostgresIngestionAuthority({
    pool: nativePool,
    workerActorId: job.jobId,
    maximumPolicyVersion: 9,
    objectStore: {
      commitQuarantineObject() {
        throw new Error('No publication allowed');
      },
    },
  });
  const admitted = await native.load({
    tenantId: job.tenantId!,
    projectId: job.projectId!,
    ingestionId: payload.ingestionId,
    securityLevel: 'L0_PUBLIC',
    policyVersion: 9,
  });
  // Derive sourceKind from the actual native adapter, not a test-only override.
  fixture.authority.assets = [...admitted.assets];
  if (admitted.sourceRegistration === undefined)
    throw new Error('Native admission must retain source registration');
  fixture.authority.sourceRegistration = admitted.sourceRegistration;
  fixture.authority.reviewGovernance = admitted.reviewGovernance;
  if (mutation === 'missing-asset') fixture.authority.assets.pop();
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const reads: string[] = [];
  const pool: DataPostgresPool = {
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (sql.includes('candidate.load-checkpoint')) {
            const frozen = fixture.authority.frozenCheckpoint!;
            return {
              rows: [
                {
                  state: fixture.authority.state,
                  security_level: 'L0_PUBLIC',
                  policy_version: 9,
                  operation_id: job.operationId,
                  transform_plan_id: job.jobId,
                  frozen_checkpoint: frozen,
                  review_hash: frozen.reviewHash,
                  review_policy_snapshot: policy,
                  current_review_policy: policy,
                  submitted_by_actor_id: job.jobId,
                  submitted_actor_type: 'human',
                  submitted_delegator_actor_id: null,
                },
              ],
            };
          }
          if (sql.includes('candidate.load-assets'))
            return {
              rows: fixture.authority.assets.map((asset) => ({
                asset_id: asset.assetId,
                ordinal: asset.ordinal,
                upload_id: asset.uploadId,
                storage_key: asset.objectRef,
                source_hash: asset.sourceHash,
                media_type: asset.mediaType,
                byte_size: asset.size,
              })),
            };
          if (sql.includes('candidate.lease-fence'))
            return { rows: [{ job_id: job.jobId }] };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
    async end() {},
  };
  const process = createIngestionCandidateProcessor({
    pool,
    read(input) {
      reads.push(input.uploadId);
      return Promise.resolve(
        input.uploadId === manifestAsset!.uploadId
          ? manifestBytes
          : sourceBytes,
      );
    },
  });
  const planner = new FixtureFakeAiPlanner();
  const validator = new FixtureFakeAiPlanValidator();
  const propose = vi.spyOn(planner, 'propose').mockImplementation(() => {
    throw new Error('Fixture planner must not run');
  });
  const validate = vi.spyOn(validator, 'validate').mockImplementation(() => {
    throw new Error('Fixture validator must not run');
  });
  const handler = createIngestionPipelineHandler({
    ...fixture.options,
    aiPlanner: planner,
    aiValidator: validator,
    sourceRegistration: { readManifest: () => Promise.resolve(body) },
    fingerprint: {
      sha256: ({ objectRef }) =>
        Promise.resolve(
          objectRef === inputs[0]!.storage_key ? manifestHash : sourceHash,
        ),
    },
    pendingCandidate: { process },
  });
  return {
    fixture,
    geojson,
    sourceBytes,
    sourceHash,
    manifestHash,
    registration,
    admitted,
    calls,
    reads,
    propose,
    validate,
    handler,
  };
}

describe('registered GeoJSON candidate composition', () => {
  it('uses native admission and the production JSON parser while retaining independent review and source limitations', async () => {
    const value = await registeredGeoJsonScenario();
    const before = Buffer.from(value.sourceBytes);
    const result = await value.handler(job);
    expect(value.admitted.assets.map((asset) => asset.sourceKind)).toEqual([
      'document',
      'document',
    ]);
    expect(result).toMatchObject({
      status: 'WAITING_REVIEW',
      result: {
        state: 'REVIEW_REQUIRED',
        candidate: {
          status: 'PARTIAL',
          parsedRecordCount: 2,
          parsedFeatureCount: 2,
          unknownAssetCount: 1,
        },
      },
    });
    expect(value.propose).not.toHaveBeenCalled();
    expect(value.validate).not.toHaveBeenCalled();
    expect(value.fixture.authority.commits).toBe(0);
    expect(value.fixture.authority.versionId).toBeUndefined();
    expect(
      value.fixture.authority.frozenCheckpoint!.assetManifest,
    ).toMatchObject({
      validationScope: 'SOURCE_REGISTRATION',
      sourceRegistration: value.registration,
      reviewGovernance: { mode: 'REQUIRE_INDEPENDENT_REVIEW' },
      assets: [
        { sourceHash: value.manifestHash },
        { sourceHash: value.sourceHash },
      ],
    });
    expect(value.sourceBytes).toEqual(before);
    const finished = value.calls.filter((call) =>
      call.sql.includes('candidate.finish-asset'),
    );
    expect(finished[0]!.values.slice(2, 6)).toEqual([
      'UNSUPPORTED',
      'SOURCE_MANIFEST',
      null,
      null,
    ]);
    expect(finished[1]!.values.slice(2, 6)).toEqual(['READY', null, 2, 2]);
    const inserts = value.calls.filter((call) =>
      call.sql.includes('candidate.insert-records'),
    );
    expect(inserts).toHaveLength(1);
    const rows = JSON.parse(inserts[0]!.values.at(-1) as string) as Array<{
      geometry: unknown;
      values: Record<string, unknown>;
    }>;
    const columns = JSON.parse(finished[1]!.values[6] as string) as Array<{
      key: string;
      label: string;
    }>;
    expect(rows.map((row) => row.geometry)).toEqual(
      value.geojson.features.map((feature) => feature.geometry),
    );
    expect(
      rows.map((row) =>
        Object.fromEntries(
          columns.map((column) => [column.label, row.values[column.key]]),
        ),
      ),
    ).toEqual(value.geojson.features.map((feature) => feature.properties));
    expect(
      value.calls.some((call) =>
        /insert into (catalog\.analysis|event\.outbox)|update ingestion\.session/i.test(
          call.sql,
        ),
      ),
    ).toBe(false);
    expect(value.fixture.order).not.toContain('parse');
  });

  it.each(['missing-asset', 'wrong-hash'] as const)(
    'rejects %s binding before candidate reads or fixture AI decisions',
    async (mutation) => {
      const value = await registeredGeoJsonScenario(mutation);
      await expect(value.handler(job)).rejects.toMatchObject({
        category: 'SOURCE_REGISTRATION_INVALID',
        retryable: false,
      });
      expect(value.propose).not.toHaveBeenCalled();
      expect(value.validate).not.toHaveBeenCalled();
      expect(value.reads).toEqual([]);
      expect(value.calls).toEqual([]);
      expect(value.fixture.authority.frozenCheckpoint).toBeUndefined();
      expect(value.fixture.authority.commits).toBe(0);
      expect(value.fixture.authority.versionId).toBeUndefined();
    },
  );
});

describe('Agent-native ingestion pipeline', () => {
  it('retries a source manifest outage, then freezes source evidence without an AI plan or analytical parser', async () => {
    const fixture = setup({ securityLevel: 'L2_RESTRICTED' });
    const body = JSON.stringify({
      schemaVersion: 'wiser.source-registration.v1',
      sourceId: 'DS-0409',
      record: { title: 'Partial HydroATLAS capture' },
      files: [],
    });
    const hash = createHash('sha256').update(body).digest('hex');
    fixture.authority.assets = [
      {
        ...fixture.authority.assets[0]!,
        mediaType: 'application/json',
        size: Buffer.byteLength(body),
      },
    ];
    fixture.authority.sourceRegistration = {
      sourceId: 'DS-0409',
      kind: 'DATASET_INTERFACE',
      name: 'Partial HydroATLAS capture',
      bundleId: 'water-research-20260908',
      providerName: 'HydroSHEDS',
      accessStatus: 'bounded_sample_only',
      completeness: 'PARTIAL',
      manifestAssetId: fixture.authority.assets[0]!.assetId,
      manifestSha256: hash,
      limitations: ['Source registration only.'],
    };
    let unavailable = true;
    const handler = createIngestionPipelineHandler({
      ...fixture.options,
      fingerprint: { sha256: () => Promise.resolve(hash) },
      sourceRegistration: {
        readManifest: () => {
          if (unavailable) {
            unavailable = false;
            return Promise.reject(
              new IngestionPipelinePortError(
                'SOURCE_REGISTRATION_READ_FAILED',
                true,
                'Temporary dependency failure.',
              ),
            );
          }
          return Promise.resolve(body);
        },
      },
    });
    const candidate = { ...job, securityLevel: 'L2_RESTRICTED' as const };
    await expect(handler(candidate)).rejects.toMatchObject({
      category: 'SOURCE_REGISTRATION_READ_FAILED',
      retryable: true,
    });
    expect(await handler(candidate)).toMatchObject({
      status: 'WAITING_REVIEW',
    });
    expect(
      fixture.authority.frozenCheckpoint?.assetManifest['sourceRegistration'],
    ).toEqual(fixture.authority.sourceRegistration);
    expect(fixture.order).not.toContain('ai-plan');
    expect(fixture.order).not.toContain('validate-ai');
    expect(fixture.order).not.toContain('parse');
    expect(fixture.order).toContain('scan');
    expect(
      fixture.authority.transitions.some(
        ({ evidence }) => evidence.agentRun !== undefined,
      ),
    ).toBe(false);
  });
  it('has one static job type and strictly rejects malformed JSON payloads', async () => {
    expect(DATA_INGESTION_PROCESS_JOB_TYPE).toBe('data.ingestion.process');
    const { handler } = setup();
    for (const candidate of [
      { ...job, payload: { ...payload, ingestionId: '../escape' } },
      { ...job, payload: { ...payload, unexpected: true } },
      { ...job, jobType: 'data.ingestion.other' },
    ]) {
      await expect(handler(candidate)).rejects.toMatchObject({
        category: 'INVALID_INGESTION_JOB',
        retryable: false,
      });
    }
  });

  it('uses a deep canonical JSON hash with a fixed regression vector', () => {
    expect(
      canonicalPipelineHash({
        z: [{ beta: 2, alpha: 1 }, true],
        a: { nested: '水', number: -0 },
      }),
    ).toBe('59cb7d367be43ae34ad161a49488f5c2ee15c0825267e59521b2776f11ab3f61');
    expect(
      canonicalPipelineHash({
        a: { number: 0, nested: '水' },
        z: [{ alpha: 1, beta: 2 }, true],
      }),
    ).toBe('59cb7d367be43ae34ad161a49488f5c2ee15c0825267e59521b2776f11ab3f61');
  });

  it('runs the unique pipeline order and atomically commits ordinary passing L0 data', async () => {
    const { handler, order, authority } = setup();

    await expect(handler(job)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      result: {
        ingestionId: payload.ingestionId,
        state: 'COMMITTED',
        qualityGrade: 'A',
      },
    });

    expect(order).toEqual([
      'authority:load',
      'quarantine',
      'authority:QUARANTINED',
      'scan',
      'authority:SECURITY_SCANNED',
      'fingerprint',
      'authority:FINGERPRINTED',
      'parse',
      'profile',
      'authority:PROFILED',
      'classify',
      'authority:CLASSIFIED',
      'ai-plan',
      'validate-ai',
      'authority:SCHEMA_MAPPED',
      'authority:SEMANTIC_MAPPED',
      'transform',
      'quality',
      'authority:VALIDATED',
      'align',
      'authority:SPATIOTEMPORAL_ALIGNED',
      'authority:APPROVED',
      'authority:COMMITTED',
    ]);
    expect(authority.commits).toBe(1);
    for (const transition of authority.transitions) {
      expect(transition.evidence.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(transition.evidence.outputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(transition.evidence)).not.toContain('Water report');
      expect(JSON.stringify(transition.evidence)).not.toContain('river-flow');
    }
  });

  it.each([
    { securityLevel: 'L2_RESTRICTED' as const },
    { risk: 'HIGH' as const },
    { restricted: true },
    { aiConfidence: 0.4 },
  ])(
    'stops high-risk, restricted, or low-confidence data at REVIEW_REQUIRED',
    async (options) => {
      const { handler, authority } = setup(options);

      await expect(handler(job)).resolves.toMatchObject({
        status: 'WAITING_REVIEW',
        result: { state: 'REVIEW_REQUIRED' },
      });
      expect(authority.state).toBe('REVIEW_REQUIRED');
      expect(authority.commits).toBe(0);
    },
  );

  it('holds high-confidence public data under a trusted independent-review policy', async () => {
    const { handler, authority } = setup();
    const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
    authority.reviewGovernance = { frozen: policy, current: policy };

    await expect(handler(job)).resolves.toMatchObject({
      status: 'WAITING_REVIEW',
      result: { state: 'REVIEW_REQUIRED' },
    });
    expect(authority.commits).toBe(0);
    expect(authority.frozenCheckpoint?.assetManifest).toMatchObject({
      reviewGovernance: policy,
    });
    expect(authority.frozenCheckpoint?.reviewHash).toBe(
      canonicalPipelineHash({
        assetIds: authority.frozenCheckpoint?.assetIds,
        assetManifest: authority.frozenCheckpoint?.assetManifest,
        quality: authority.frozenCheckpoint?.quality,
        alignment: authority.frozenCheckpoint?.alignment,
      }),
    );
  });

  it('processes a governed candidate before waiting and resumes the same checkpoint after a temporary failure', async () => {
    const value = setup();
    const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
    value.authority.reviewGovernance = { frozen: policy, current: policy };
    let attempts = 0;
    const handler = createIngestionPipelineHandler({
      ...value.options,
      pendingCandidate: {
        async process(candidate) {
          await Promise.resolve();
          attempts += 1;
          expect(candidate.jobId).toBe(job.jobId);
          expect(value.authority.state).toBe('REVIEW_REQUIRED');
          expect(value.authority.commits).toBe(0);
          if (attempts === 1)
            throw new DataJobHandlerError('CANDIDATE_TEMPORARY', true, 'retry');
          return { status: 'READY', parsedRecordCount: 2 };
        },
      },
    });
    await expect(handler(job)).rejects.toMatchObject({
      category: 'CANDIDATE_TEMPORARY',
      retryable: true,
    });
    const frozenHash = value.authority.frozenCheckpoint?.reviewHash;
    const version = value.authority.version;
    await expect(handler({ ...job, attemptCount: 2 })).resolves.toMatchObject({
      status: 'WAITING_REVIEW',
      result: { state: 'REVIEW_REQUIRED', candidate: { status: 'READY' } },
    });
    expect(attempts).toBe(2);
    expect(value.authority.frozenCheckpoint?.reviewHash).toBe(frozenHash);
    expect(value.authority.version).toBe(version);
    expect(value.authority.commits).toBe(0);
  });

  it('never invokes candidate persistence for the unmanaged automatic-publication path', async () => {
    const value = setup();
    let attempts = 0;
    const handler = createIngestionPipelineHandler({
      ...value.options,
      pendingCandidate: {
        process() {
          attempts += 1;
          return Promise.resolve({ status: 'READY' });
        },
      },
    });
    await expect(handler(job)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(attempts).toBe(0);
  });

  it.each([
    null,
    { frozen: { mode: 'UNKNOWN', revision: 1 }, current: null },
    {
      frozen: { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 },
      current: { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 2 },
    },
    {
      frozen: { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 },
      current: null,
    },
  ])(
    'fails closed on unknown, withdrawn, or changed trusted review policy %j',
    async (policy) => {
      const value = setup();
      value.authority.reviewGovernance = policy;
      await expect(value.handler(job)).rejects.toMatchObject({
        category: 'INGESTION_REVIEW_GOVERNANCE_CONFLICT',
        retryable: false,
      });
      expect(value.order).toEqual(['authority:load']);
      expect(value.authority.commits).toBe(0);
    },
  );

  it('rejects an old approved checkpoint lacking the current review-policy hash binding', async () => {
    const original = setup({ securityLevel: 'L2_RESTRICTED' });
    await original.handler(job);
    const frozen = original.authority.frozenCheckpoint;
    if (frozen === undefined) throw new Error('missing frozen checkpoint');
    const value = setup({ securityLevel: 'L2_RESTRICTED' });
    const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
    value.authority.reviewGovernance = { frozen: policy, current: policy };
    value.authority.state = 'APPROVED';
    value.authority.version = 11;
    value.authority.frozenCheckpoint = frozen;
    await expect(
      value.handler({
        ...job,
        securityLevel: 'L2_RESTRICTED',
        payload: { ...payload, expectedState: 'APPROVED', expectedVersion: 11 },
      }),
    ).rejects.toMatchObject({
      category: 'INGESTION_REVIEW_GOVERNANCE_CONFLICT',
      retryable: false,
    });
    expect(value.order).toEqual(['authority:load']);
    expect(value.authority.commits).toBe(0);
  });

  it('persists infected scans as REJECTED and raises a non-retryable safe failure', async () => {
    const { handler, authority } = setup({ clean: false });
    await expect(handler(job)).rejects.toMatchObject({
      category: 'MALWARE_DETECTED',
      retryable: false,
    });
    expect(authority.state).toBe('REJECTED');
  });

  it('uses the deterministic quality gate and rejects blocking failures', async () => {
    const { handler, authority } = setup({ blockingFailure: true });
    await expect(handler(job)).rejects.toMatchObject({
      category: 'QUALITY_GATE_REJECTED',
      retryable: false,
    });
    expect(authority.state).toBe('REJECTED');
    expect(authority.commits).toBe(0);
  });

  it('resumes after a temporary parser failure from FINGERPRINTED and commits once', async () => {
    const { handler, authority, order } = setup({ parserFailures: 1 });
    await expect(handler(job)).rejects.toMatchObject({
      category: 'TIKA_TEMPORARY',
      retryable: true,
    });
    expect(authority.state).toBe('FINGERPRINTED');
    expect(authority.version).toBe(4);

    await expect(handler(job)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      result: { state: 'COMMITTED' },
    });
    expect(authority.commits).toBe(1);
    expect(
      order.filter((entry) => entry === 'authority:FINGERPRINTED'),
    ).toHaveLength(1);
  });

  it('processes two ordered authority assets into one committed version', async () => {
    const { handler, authority, order } = setup({ assetCount: 2 });
    await expect(handler(job)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      result: { state: 'COMMITTED' },
    });
    expect(authority.commits).toBe(1);
    expect(order.filter((entry) => entry === 'quarantine')).toHaveLength(2);
    expect(order.filter((entry) => entry === 'parse')).toHaveLength(2);
  });

  it('rejects non-contiguous authority ordinals before any external stage runs', async () => {
    const value = setup({ assetCount: 2 });
    value.authority.assets[1] = {
      ...value.authority.assets[1]!,
      ordinal: 2,
    };
    await expect(value.handler(job)).rejects.toMatchObject({
      category: 'INGESTION_AUTHORITY_CONFLICT',
      retryable: false,
    });
    expect(value.order).toEqual(['authority:load']);
  });

  it('commits an approved high-risk checkpoint without replaying any stage port', async () => {
    const reviewed = setup({ securityLevel: 'L2_RESTRICTED' });
    await expect(reviewed.handler(job)).resolves.toMatchObject({
      status: 'WAITING_REVIEW',
    });
    const frozen = reviewed.authority.frozenCheckpoint;
    expect(frozen).toBeDefined();
    if (frozen === undefined) throw new Error('missing frozen checkpoint');
    const manifestAssets = frozen.assetManifest.assets;
    const validatedPlan = frozen.assetManifest.validatedPlan;
    if (!Array.isArray(manifestAssets) || !isRecord(validatedPlan)) {
      throw new Error('invalid frozen checkpoint fixture');
    }
    const firstManifestAsset: unknown = manifestAssets[0];
    if (!isRecord(firstManifestAsset)) {
      throw new Error('invalid frozen asset fixture');
    }
    expect(firstManifestAsset.scanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validatedPlan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen.assetManifest).toMatchObject({
      assets: [
        {
          assetId: reviewed.authority.assets[0]!.assetId,
          sourceHash: 'a'.repeat(64),
          parserHash: 'a'.repeat(64),
          profileHash: 'c'.repeat(64),
          classificationHash: 'd'.repeat(64),
        },
      ],
      transformedHash: 'e'.repeat(64),
    });

    const approved = setup({ securityLevel: 'L2_RESTRICTED' });
    approved.authority.state = 'APPROVED';
    approved.authority.version = 11;
    approved.authority.frozenCheckpoint = frozen;
    const approvedJob = {
      ...job,
      securityLevel: 'L2_RESTRICTED' as const,
      payload: {
        ingestionId: payload.ingestionId,
        expectedState: 'APPROVED' as const,
        expectedVersion: 11,
      },
    };
    await expect(approved.handler(approvedJob)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      result: { state: 'COMMITTED' },
    });
    expect(approved.order).toEqual(['authority:load', 'authority:COMMITTED']);
    expect(approved.authority.commits).toBe(1);
  });

  it('rejects an APPROVED job fence that does not match the checkpoint chain', async () => {
    const value = setup();
    value.authority.state = 'FINGERPRINTED';
    value.authority.version = 4;
    await expect(
      value.handler({
        ...job,
        payload: {
          ingestionId: payload.ingestionId,
          expectedState: 'APPROVED',
          expectedVersion: 3,
        },
      }),
    ).rejects.toMatchObject({
      category: 'INGESTION_AUTHORITY_CONFLICT',
      retryable: false,
    });
    expect(value.order).toEqual(['authority:load']);
  });

  it('rejects a computed fingerprint that differs from the authoritative source hash', async () => {
    const value = setup();
    value.authority.assets[0] = {
      ...value.authority.assets[0]!,
      sourceHash: 'b'.repeat(64),
    };
    await expect(value.handler(job)).rejects.toMatchObject({
      category: 'OBJECT_INTEGRITY_MISMATCH',
      retryable: false,
    });
    expect(value.authority.state).toBe('SECURITY_SCANNED');
  });

  it('returns persisted review/commit checkpoints without replaying stages', async () => {
    const review = setup();
    review.authority.state = 'REVIEW_REQUIRED';
    review.authority.version = 10;
    await expect(review.handler(job)).resolves.toMatchObject({
      status: 'WAITING_REVIEW',
      result: { state: 'REVIEW_REQUIRED' },
    });
    expect(review.order).toEqual(['authority:load']);

    const committed = setup();
    committed.authority.state = 'COMMITTED';
    committed.authority.version = 12;
    committed.authority.versionId = '77777777-7777-4777-8777-777777777777';
    await expect(committed.handler(job)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      result: { state: 'COMMITTED', versionId: committed.authority.versionId },
    });
    expect(committed.order).toEqual(['authority:load']);
  });

  it('rejects invalid AI plans before transform and never lets AI assign grade or acceptance', async () => {
    const { handler, order } = setup({
      validatorError: new Error('raw model output contained a secret'),
    });
    const failure = await handler(job).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      category: 'AI_PLAN_INVALID',
      retryable: false,
    });
    expect(String(failure)).not.toContain('secret');
    expect(order).not.toContain('transform');
  });

  it('classifies temporary dependency failures safely without leaking backend details', async () => {
    const { handler } = setup({
      parserError: new IngestionPipelinePortError(
        'TIKA_TEMPORARY',
        true,
        'http://tika:9998 password=secret',
      ),
    });
    const failure = await handler(job).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DataJobHandlerError);
    expect(failure).toMatchObject({
      category: 'TIKA_TEMPORARY',
      retryable: true,
    });
    expect(String(failure)).not.toContain('tika:9998');
    expect(String(failure)).not.toContain('secret');
  });
});

describe('historical Word claims at the real freeze producer', () => {
  it('derives from actual registered M before reviewHash and candidate dispatch', async () => {
    const fixture = setup();
    const pair = wordPairFixture(job.tenantId!, job.projectId!);
    const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
    fixture.authority.assets = pair.assets;
    fixture.authority.sourceRegistration = pair.registration;
    fixture.authority.reviewGovernance = { frozen: policy, current: policy };
    let dispatched = false;
    await createIngestionPipelineHandler({
      ...fixture.options,
      fingerprint: {
        sha256: ({ objectRef }) =>
          Promise.resolve(
            pair.assets.find((a) => a.objectRef === objectRef)!.sourceHash,
          ),
      },
      sourceRegistration: { readManifest: () => Promise.resolve(pair.body) },
      pendingCandidate: {
        async process() {
          await Promise.resolve();
          dispatched = true;
          return { status: 'PARTIAL' };
        },
      },
    })(job);
    expect(dispatched).toBe(true);
    const saved = fixture.authority.frozenCheckpoint!;
    expect(saved.assetManifest['candidateConversionDeclarations']).toEqual([
      pair.declaration,
    ]);
    const { reviewHash, ...base } = saved;
    expect(reviewHash).toBe(canonicalPipelineHash(base));
    const withoutDeclaration = Object.fromEntries(
      Object.entries(base.assetManifest).filter(
        ([key]) => key !== 'candidateConversionDeclarations',
      ),
    );
    expect(
      canonicalPipelineHash({ ...base, assetManifest: withoutDeclaration }),
    ).not.toBe(reviewHash);
  });
  it.each([
    'unknown-version',
    'verified',
    'external-member',
    'swapped-role',
    'wrong-size',
    'duplicate-prepared',
  ])('rejects %s claims before freezing', async (change) => {
    const fixture = setup();
    const seed = wordPairFixture(job.tenantId!, job.projectId!);
    const claims: Record<string, unknown> = structuredClone(seed.claims);
    const pairs = claims['pairs'] as Array<Record<string, unknown>>;
    if (change === 'unknown-version') claims['schemaVersion'] = 'future';
    if (change === 'verified') pairs[0]!['verified'] = true;
    if (change === 'external-member')
      (pairs[0]!['original'] as Record<string, unknown>)['assetId'] =
        'd1000000-0000-4000-8000-000000000099';
    if (change === 'swapped-role')
      [pairs[0]!['original'], pairs[0]!['prepared']] = [
        pairs[0]!['prepared'],
        pairs[0]!['original'],
      ];
    if (change === 'wrong-size')
      (pairs[0]!['original'] as Record<string, unknown>)['byteSize'] = 1;
    if (change === 'duplicate-prepared') pairs.push(structuredClone(pairs[0]!));
    const pair = wordPairFixture(job.tenantId!, job.projectId!, {
      candidateConversionPairs: claims,
    });
    fixture.authority.assets = pair.assets;
    fixture.authority.sourceRegistration = pair.registration;
    await expect(
      createIngestionPipelineHandler({
        ...fixture.options,
        fingerprint: {
          sha256: ({ objectRef }) =>
            Promise.resolve(
              pair.assets.find((a) => a.objectRef === objectRef)!.sourceHash,
            ),
        },
        sourceRegistration: { readManifest: () => Promise.resolve(pair.body) },
      })(job),
    ).rejects.toMatchObject({ category: 'SOURCE_REGISTRATION_INVALID' });
    expect(fixture.authority.frozenCheckpoint).toBeUndefined();
  });
});
