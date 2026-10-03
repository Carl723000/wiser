import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IngestionCandidateBatchSchema } from '@wiser/data-contracts';
import {
  AnalysisContentError,
  createIngestionCandidateRecordBinder,
  parseAnalysisContent,
  type ClaimedDataJob,
  type DataPostgresPool,
} from '@wiser/data-infra';
import { canonicalPipelineHash } from '../src/handlers/ingestion-pipeline.js';
import { createIngestionCandidateProcessor } from '../src/handlers/ingestion-candidate.js';
import { DataJobHandlerError } from '../src/handlers/registry.js';
import type { ExternalIngestionCandidateInput } from '../src/adapters/analysis-parser.js';

const tenant = 'c1000000-0000-4000-8000-000000000001';
const project = 'c2000000-0000-4000-8000-000000000001';
const ingestion = 'c3000000-0000-4000-8000-000000000001';
const asset = 'c4000000-0000-4000-8000-000000000001';
const upload = 'c5000000-0000-4000-8000-000000000001';
const actor = 'c6000000-0000-4000-8000-000000000001';
const plan = 'c7000000-0000-4000-8000-000000000001';
const job: ClaimedDataJob = {
  jobId: 'c8000000-0000-4000-8000-000000000001',
  tenantId: tenant,
  projectId: project,
  operationId: ingestion,
  jobType: 'data.ingestion.process',
  payload: {
    ingestionId: ingestion,
    expectedState: 'RECEIVED',
    expectedVersion: 1,
  },
  attemptCount: 1,
  maxAttempts: 3,
  leaseOwner: 'candidate-test',
  leaseExpiresAt: '2099-01-01T00:00:00Z',
  rowVersion: 2,
  cancelRequested: false,
  securityLevel: 'L0_PUBLIC',
  policyVersion: 1,
};
const bytes = new TextEncoder().encode('河段,类别,空值\n潮白河,Ⅲ,\n白河,0,\n');
const sourceHash = createHash('sha256').update(bytes).digest('hex');
const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
const base = {
  assetIds: [asset],
  assetManifest: {
    reviewGovernance: policy,
    assets: [
      {
        assetId: asset,
        ordinal: 0,
        uploadId: upload,
        quarantineObjectRef: `tenants/${tenant}/projects/${project}/quarantine/${upload}/object`,
        sourceHash,
        size: bytes.length,
        mediaType: 'text/csv',
      },
    ],
  },
  quality: { grade: 'B', accepted: true },
  alignment: { alignmentHash: 'f'.repeat(64) },
};
const frozen = { ...base, reviewHash: canonicalPipelineHash(base) };

function fixture(
  options: {
    checkpoint?: Record<string, unknown>;
    assets?: readonly Record<string, unknown>[];
    leaseValid?: boolean;
    completedBatch?: unknown;
    readError?: Error;
    readBytes?: Uint8Array;
    parseExternal?: (
      input: ExternalIngestionCandidateInput,
    ) => AsyncIterable<unknown>;
  } = {},
) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const reads: string[] = [];
  const checkpoint: Record<string, unknown> = {
    state: 'REVIEW_REQUIRED',
    security_level: 'L0_PUBLIC',
    policy_version: 1,
    operation_id: ingestion,
    transform_plan_id: plan,
    frozen_checkpoint: frozen,
    review_hash: frozen.reviewHash,
    review_policy_snapshot: policy,
    current_review_policy: policy,
    submitted_by_actor_id: actor,
    submitted_actor_type: 'human',
    submitted_delegator_actor_id: null,
    ...options.checkpoint,
  };
  const pool: DataPostgresPool = {
    async connect() {
      await Promise.resolve();
      return {
        async query(sql, values = []) {
          await Promise.resolve();
          calls.push({ sql, values });
          if (sql.includes('candidate.load-checkpoint'))
            return { rows: [checkpoint] };
          if (sql.includes('candidate.load-assets'))
            return {
              rows: options.assets ?? [
                {
                  asset_id: asset,
                  ordinal: 0,
                  upload_id: upload,
                  storage_key:
                    base.assetManifest.assets[0]!.quarantineObjectRef,
                  source_hash: sourceHash,
                  media_type: 'text/csv',
                  byte_size: bytes.length,
                },
              ],
            };
          if (sql.includes('candidate.load-batch'))
            return {
              rows: options.completedBatch
                ? [{ batch: options.completedBatch }]
                : [],
            };
          if (sql.includes('candidate.lease-fence'))
            return {
              rows: options.leaseValid === false ? [] : [{ job_id: job.jobId }],
            };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
    async end() {},
  };
  const process = createIngestionCandidateProcessor({
    pool,
    ...(options.parseExternal
      ? { parseExternal: options.parseExternal as never }
      : {}),
    read(input) {
      reads.push(input.uploadId);
      return options.readError
        ? Promise.reject(options.readError)
        : Promise.resolve(options.readBytes ?? bytes);
    },
  });
  return { calls, reads, process };
}

describe('durable frozen ingestion candidates', () => {
  it('stores original rows and a fixed candidate identity while the ingestion remains pending review', async () => {
    const value = fixture();
    const result = await value.process(job);
    expect(result).toMatchObject({
      status: 'READY',
      parsedRecordCount: 2,
      parsedFeatureCount: 0,
      unknownAssetCount: 0,
      reference: {
        kind: 'ingestion-candidate',
        ingestionId: ingestion,
        reviewHash: frozen.reviewHash,
      },
    });
    expect(value.reads).toEqual([upload]);
    const insert = value.calls.find((call) =>
      call.sql.includes('candidate.insert-records'),
    );
    expect(insert).toBeDefined();
    const rows: unknown = JSON.parse(insert!.values.at(-1) as string);
    const publishedValues: unknown[] = [];
    for await (const event of parseAnalysisContent({
      bytes,
      sourceHash,
      format: 'csv',
      assetId: asset,
      dataItemId: ingestion,
      versionId: plan,
    }))
      if (event.type === 'record') publishedValues.push(event.values);
    expect(rows).toMatchObject([
      { values: publishedValues[0] },
      { values: publishedValues[1] },
    ]);
    expect(value.calls.at(-1)?.sql).toBe('commit');
    expect(
      value.calls.some((call) =>
        /insert into (catalog\.analysis|event\.outbox)|update ingestion\.session/i.test(
          call.sql,
        ),
      ),
    ).toBe(false);
  });

  it('preserves explicit JSON null, numeric zero and empty string as distinct original values', async () => {
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify([{ missing: null, zero: 0, blank: '' }]),
    );
    const jsonHash = createHash('sha256').update(jsonBytes).digest('hex');
    const changed = structuredClone(base);
    changed.assetManifest.assets[0]!.mediaType = 'application/json';
    changed.assetManifest.assets[0]!.size = jsonBytes.length;
    changed.assetManifest.assets[0]!.sourceHash = jsonHash;
    const reviewHash = canonicalPipelineHash(changed);
    const value = fixture({
      checkpoint: {
        frozen_checkpoint: { ...changed, reviewHash },
        review_hash: reviewHash,
      },
      readBytes: jsonBytes,
      assets: [
        {
          asset_id: asset,
          ordinal: 0,
          upload_id: upload,
          storage_key: base.assetManifest.assets[0]!.quarantineObjectRef,
          source_hash: jsonHash,
          media_type: 'application/json',
          byte_size: jsonBytes.length,
        },
      ],
    });
    expect(await value.process(job)).toMatchObject({
      status: 'READY',
      parsedRecordCount: 1,
    });
    const rows: unknown = JSON.parse(
      value.calls
        .find((call) => call.sql.includes('candidate.insert-records'))!
        .values.at(-1) as string,
    );
    expect(rows).toMatchObject([{ values: { c1: null, c2: 0, c3: '' } }]);
  });

  it.each([
    { state: 'PUBLISHED' },
    { operation_id: actor },
    { submitted_by_actor_id: null },
    { current_review_policy: { ...policy, revision: 2 } },
    { review_hash: 'b'.repeat(64) },
    { frozen_checkpoint: { ...frozen, assetIds: [] } },
  ])(
    'rejects an altered, unpublished or unowned authority before reading an original %j',
    async (checkpoint) => {
      const value = fixture({ checkpoint });
      await expect(value.process(job)).rejects.toMatchObject({
        retryable: false,
      });
      expect(value.reads).toEqual([]);
      expect(value.calls.at(-1)?.sql).toBe('rollback');
    },
  );

  it('rejects a missing or differently hashed frozen original before reading bytes', async () => {
    for (const assets of [
      [],
      [
        {
          asset_id: asset,
          source_hash: 'd'.repeat(64),
          media_type: 'text/csv',
          byte_size: bytes.length,
          ordinal: 0,
          upload_id: upload,
          storage_key: base.assetManifest.assets[0]!.quarantineObjectRef,
        },
      ],
    ]) {
      const value = fixture({ assets });
      await expect(value.process(job)).rejects.toMatchObject({
        retryable: false,
      });
      expect(value.reads).toEqual([]);
    }
  });

  it('rolls back when the original store is unavailable and never completes the candidate', async () => {
    const value = fixture({ readError: new Error('unavailable') });
    await expect(value.process(job)).rejects.toMatchObject({ retryable: true });
    expect(value.calls.at(-1)?.sql).toBe('rollback');
    expect(
      value.calls.some((call) => call.sql.includes('candidate.finish-batch')),
    ).toBe(false);
  });

  it('fails the final lease fence and rolls back parsed records without allowing publication', async () => {
    const value = fixture({ leaseValid: false });
    await expect(value.process(job)).rejects.toMatchObject({
      category: 'JOB_LEASE_LOST',
      retryable: false,
    });
    expect(value.calls.at(-1)?.sql).toBe('rollback');
    expect(
      value.calls.some((call) => call.sql.includes('candidate.insert-records')),
    ).toBe(true);
  });

  it('binds a document partial result to its actual source locator', async () => {
    const changed = structuredClone(frozen);
    changed.assetManifest.assets[0]!.mediaType = 'application/pdf';
    const { reviewHash: _hash, ...changedBase } = changed;
    changed.reviewHash = canonicalPipelineHash(changedBase);
    const value = fixture({
      checkpoint: {
        frozen_checkpoint: changed,
        review_hash: changed.reviewHash,
      },
      assets: [
        {
          asset_id: asset,
          ordinal: 0,
          upload_id: upload,
          storage_key: base.assetManifest.assets[0]!.quarantineObjectRef,
          source_hash: sourceHash,
          media_type: 'application/pdf',
          byte_size: bytes.length,
        },
      ],
      async *parseExternal(input) {
        await Promise.resolve();
        expect(input).not.toHaveProperty('versionId');
        const bind = createIngestionCandidateRecordBinder(input);
        yield { type: 'schema', columns: [{ key: 'c1', label: '原文' }] };
        yield bind({
          index: 1,
          sourceId: 'document/page:2',
          values: { c1: '潮白河' },
          geometry: null,
          sourceCrs: null,
        });
        yield {
          type: 'summary',
          status: 'PARTIAL',
          recordCount: 1,
          featureCount: 0,
          reason: 'TEXT_LIMIT',
        };
      },
    });
    expect(await value.process(job)).toMatchObject({
      status: 'PARTIAL',
      parsedRecordCount: 1,
      unknownAssetCount: 0,
    });
    const records: unknown = JSON.parse(
      value.calls
        .find((call) => call.sql.includes('candidate.insert-records'))!
        .values.at(-1) as string,
    );
    expect(records).toMatchObject([
      { sourceId: 'document/page:2', values: { c1: '潮白河' } },
    ]);
  });

  it('returns unknown counts after a parser content failure and discards partial asset rows', async () => {
    const changed = structuredClone(frozen);
    changed.assetManifest.assets[0]!.mediaType = 'application/pdf';
    const { reviewHash: _hash, ...changedBase } = changed;
    changed.reviewHash = canonicalPipelineHash(changedBase);
    const value = fixture({
      checkpoint: {
        frozen_checkpoint: changed,
        review_hash: changed.reviewHash,
      },
      assets: [
        {
          asset_id: asset,
          ordinal: 0,
          upload_id: upload,
          storage_key: base.assetManifest.assets[0]!.quarantineObjectRef,
          source_hash: sourceHash,
          media_type: 'application/pdf',
          byte_size: bytes.length,
        },
      ],
      async *parseExternal() {
        await Promise.resolve();
        yield { type: 'schema', columns: [] };
        throw new AnalysisContentError('CAPACITY_LIMIT');
      },
    });
    expect(await value.process(job)).toMatchObject({
      status: 'UNAVAILABLE',
      unknownAssetCount: 1,
    });
    const finish = value.calls.find((call) =>
      call.sql.includes('candidate.finish-asset'),
    );
    expect(finish?.values.slice(2, 6)).toEqual([
      'UNSUPPORTED',
      'CAPACITY_LIMIT',
      null,
      null,
    ]);
    expect(
      value.calls.some(
        (call) => call.sql === 'rollback to savepoint candidate_asset_records',
      ),
    ).toBe(true);
  });

  it('replays an already committed candidate without reading or reparsing the original', async () => {
    const first = fixture();
    const result = await first.process(job);
    const completedBatch = IngestionCandidateBatchSchema.parse({
      reference: result.reference,
      parserVersion: '1.0.0',
      status: 'READY',
      createdAt: '2026-10-03T10:00:00Z',
      assets: [
        {
          assetId: asset,
          sourceHash,
          status: 'READY',
          recordCount: 2,
          featureCount: 0,
          reason: null,
        },
      ],
    });
    const replay = fixture({ completedBatch });
    expect(await replay.process({ ...job, attemptCount: 2 })).toMatchObject(
      result,
    );
    expect(replay.reads).toEqual([]);
    expect(
      replay.calls.some((call) =>
        call.sql.includes('candidate.insert-records'),
      ),
    ).toBe(false);
    expect(replay.calls.at(-1)?.sql).toBe('commit');
  });

  it('keeps transient external-parser failure retryable rather than marking the original invalid', async () => {
    const value = fixture({
      readError: new DataJobHandlerError('SOURCE_TEMPORARY', true, 'safe'),
    });
    await expect(value.process(job)).rejects.toMatchObject({
      category: 'SOURCE_TEMPORARY',
      retryable: true,
    });
    expect(value.calls.at(-1)?.sql).toBe('rollback');
  });
});
