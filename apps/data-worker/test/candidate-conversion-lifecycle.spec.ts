import { describe, expect, it } from 'vitest';
import {
  AnalysisContentError,
  createIngestionCandidateRecordBinder,
  type ClaimedDataJob,
  type DataPostgresPool,
} from '@wiser/data-infra';
import { canonicalPipelineHash } from '../src/handlers/ingestion-pipeline.js';
import { createIngestionCandidateProcessor } from '../src/handlers/ingestion-candidate.js';
import {
  wordHash,
  wordPairFixture,
  wordStructure,
} from './candidate-conversion-fixture.js';

const tenant = 'c1000000-0000-4000-8000-000000000001';
const project = 'c2000000-0000-4000-8000-000000000001';
const ingestion = 'c3000000-0000-4000-8000-000000000001';
const actor = 'c6000000-0000-4000-8000-000000000001';
const plan = 'c7000000-0000-4000-8000-000000000001';
const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
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
  leaseOwner: 'conversion-unit',
  leaseExpiresAt: '2099-01-01T00:00:00Z',
  rowVersion: 2,
  cancelRequested: false,
  securityLevel: 'L0_PUBLIC',
  policyVersion: 1,
};

function fixture(
  options: {
    drift?: boolean;
    tool?: boolean;
    difference?: boolean;
    leaseLost?: boolean;
    sqlFailure?: string;
  } = {},
) {
  const pair = wordPairFixture(tenant, project);
  const declarations = [structuredClone(pair.declaration)];
  if (options.drift) declarations[0]!.sourceLocalWorkId = 'producer-drift';
  const base = {
    assetIds: pair.assets.map((a) => a.assetId),
    assetManifest: {
      reviewGovernance: policy,
      sourceRegistration: pair.registration,
      candidateConversionDeclarations: declarations,
      assets: pair.assets.map((a) => ({
        ...a,
        quarantineObjectRef: a.objectRef,
      })),
    },
    quality: { grade: 'B', accepted: true },
    alignment: { alignmentHash: 'f'.repeat(64) },
  };
  const frozen = { ...base, reviewHash: canonicalPipelineHash(base) };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const conversions: Uint8Array[] = [];
  const extracted: Uint8Array[] = [];
  let toolFinished = false;
  const pool: DataPostgresPool = {
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (options.sqlFailure && sql.includes(options.sqlFailure))
            throw new Error('synthetic SQL failure');
          if (sql.includes('candidate.load-checkpoint'))
            return {
              rows: [
                {
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
                },
              ],
            };
          if (sql.includes('candidate.load-assets'))
            return {
              rows: pair.assets.map((a) => ({
                asset_id: a.assetId,
                ordinal: a.ordinal,
                storage_key: a.objectRef,
                source_hash: a.sourceHash,
                media_type: a.mediaType,
                byte_size: a.size,
              })),
            };
          if (sql.includes('candidate.load-batch')) return { rows: [] };
          if (
            sql.includes('candidate.lease-fence') ||
            sql.includes('candidate.conversion-authority')
          )
            return {
              rows:
                options.leaseLost && toolFinished
                  ? []
                  : [{ job_id: job.jobId }],
            };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
    async end() {},
  };
  const conversionRunner = {
    async reconvert(input: {
      originalBytes: Uint8Array;
      maximumBytes: number;
      checkAuthority: () => Promise<void>;
    }) {
      conversions.push(input.originalBytes.slice());
      await input.checkAuthority();
      toolFinished = true;
      return {
        kind: 'CONVERTED',
        bytes: new TextEncoder().encode('synthetic reconverted DOCX'),
        tool: {
          name: 'synthetic-converter',
          version: 'test-only',
          digest: 'a'.repeat(64),
        },
      };
    },
    async extractStructure(input: { bytes: Uint8Array }) {
      extracted.push(input.bytes.slice());
      const structure = structuredClone(wordStructure);
      if (options.difference && extracted.length === 2)
        structure.tables[0]!.rows[0]!.cells[1]!.text = ' ';
      return structure;
    },
  };
  const process = createIngestionCandidateProcessor({
    pool,
    ...(options.tool === false ? {} : { conversionRunner }),
    async read(input) {
      const index = pair.assets.findIndex((a) => a.uploadId === input.uploadId);
      if (index < 0) throw Error('unknown byte stream');
      return pair.contents[index]!.slice();
    },
    async *parseExternal(input) {
      if (input.assetId === pair.pair.original.assetId)
        throw new AnalysisContentError('PARSING_FAILED');
      const bind = createIngestionCandidateRecordBinder(input);
      yield { type: 'schema', columns: [{ key: 'c1', label: '正文' }] };
      yield bind({
        index: 1,
        sourceId: 'word/document.xml#table:1/row:1/cell:1',
        values: { c1: '潮白河' },
        geometry: null,
        sourceCrs: null,
      });
      yield {
        type: 'summary',
        status: 'READY',
        recordCount: 1,
        featureCount: 0,
      };
    },
  });
  return { pair, calls, conversions, extracted, process };
}

describe('historical conversion in the actual pending candidate handler', () => {
  it('uses actual O/P bytes and writes the immutable result after asset outcomes before same-client completion', async () => {
    const f = fixture();
    expect(await f.process(job)).toMatchObject({
      status: 'PARTIAL',
      parsedRecordCount: 1,
    });
    expect(f.conversions).toEqual([f.pair.contents[0]]);
    expect(f.extracted[0]).toEqual(f.pair.contents[1]);
    expect(wordHash(f.extracted[1]!)).not.toBe(f.pair.pair.prepared.sha256);
    const insert = f.calls.findIndex((c) =>
      c.sql.includes('candidate.insert-conversion-check'),
    );
    const lastAsset = f.calls.findLastIndex((c) =>
      c.sql.includes('candidate.finish-asset'),
    );
    const finish = f.calls.findIndex((c) =>
      c.sql.includes('candidate.finish-batch'),
    );
    expect(insert).toBeGreaterThan(lastAsset);
    expect(insert).toBeLessThan(finish);
    expect(f.calls[insert]!.values).toContain('VERIFIED_EQUIVALENT');
    expect(f.calls.filter((c) => c.sql === 'begin')).toHaveLength(1);
    expect(f.calls.filter((c) => c.sql === 'commit')).toHaveLength(1);
    const original = f.calls.find(
      (c) =>
        c.sql.includes('candidate.finish-asset') &&
        c.values[1] === f.pair.pair.original.assetId,
    )!;
    expect(original.values.slice(2, 6)).toEqual([
      'UNSUPPORTED',
      'PARSING_FAILED',
      null,
      null,
    ]);
  });
  it('rejects independently derived declaration drift before calling the trusted tool', async () => {
    const f = fixture({ drift: true });
    await expect(f.process(job)).rejects.toMatchObject({
      category: 'CANDIDATE_CHECKPOINT_CONFLICT',
    });
    expect(f.conversions).toEqual([]);
    expect(f.calls.at(-1)!.sql).toBe('rollback');
  });
  it.each([
    { tool: false, state: 'UNVERIFIABLE', reason: 'TOOL_UNAVAILABLE' },
    {
      difference: true,
      state: 'NOT_EQUIVALENT',
      reason: 'STRUCTURE_DIFFERENT',
    },
  ])('commits an honest $state result', async (options) => {
    const f = fixture(options);
    await f.process(job);
    const insert = f.calls.find((c) =>
      c.sql.includes('candidate.insert-conversion-check'),
    )!;
    expect(insert).toBeDefined();
    expect(insert.values).toContain(options.state);
    expect(insert.values).toContain(options.reason);
    expect(f.calls.at(-1)!.sql).toBe('commit');
  });
  it.each(['lease', 'insert', 'commit'])(
    'rolls back $0 failures instead of turning authority/SQL failures into tool outcomes',
    async (failure) => {
      const f = fixture({
        leaseLost: failure === 'lease',
        sqlFailure:
          failure === 'insert'
            ? 'candidate.insert-conversion-check'
            : failure === 'commit'
              ? 'commit'
              : undefined,
      });
      await expect(f.process(job)).rejects.toMatchObject({
        category:
          failure === 'lease'
            ? 'JOB_LEASE_LOST'
            : 'CANDIDATE_PROCESSING_TEMPORARY',
      });
      expect(f.calls.at(-1)!.sql).toBe('rollback');
    },
  );
});
