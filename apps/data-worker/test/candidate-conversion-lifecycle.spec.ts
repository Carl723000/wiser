import { describe, expect, it } from 'vitest';
import {
  AnalysisContentError,
  ANALYSIS_PARSER_VERSION,
  createIngestionCandidateRecordBinder,
  type ClaimedDataJob,
  type DataPostgresPool,
} from '@wiser/data-infra';
import { canonicalPipelineHash } from '../src/handlers/ingestion-pipeline.js';
import { createIngestionCandidateProcessor } from '../src/handlers/ingestion-candidate.js';
import type { CandidateConversionRunner } from '../src/handlers/candidate-conversion.js';
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
    noClaims?: boolean;
    toolFailure?: 'CONVERSION_FAILED' | 'BUDGET_EXCEEDED';
    toolError?: Error;
    invalidStructure?: boolean;
    alternateWidth?: boolean;
    corruptPrepared?: boolean;
  } = {},
) {
  const pair = wordPairFixture(
    tenant,
    project,
    options.noClaims ? { candidateConversionPairs: undefined } : {},
  );
  const declarations = [structuredClone(pair.declaration)];
  if (options.drift) declarations[0]!.sourceLocalWorkId = 'producer-drift';
  const base = {
    assetIds: pair.assets.map((a) => a.assetId),
    assetManifest: {
      reviewGovernance: policy,
      sourceRegistration: pair.registration,
      ...(options.noClaims
        ? {}
        : { candidateConversionDeclarations: declarations }),
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
  const reads: string[] = [];
  let completedBatch: unknown;
  let toolFinished = false;
  const pool: DataPostgresPool = {
    async connect() {
      await Promise.resolve();
      return {
        async query(sql, values = []) {
          await Promise.resolve();
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
          if (sql.includes('candidate.load-batch'))
            return {
              rows:
                completedBatch === undefined ? [] : [{ batch: completedBatch }],
            };
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
    end() {
      return Promise.resolve();
    },
  };
  const conversionRunner: CandidateConversionRunner = {
    async reconvert(input: {
      originalBytes: Uint8Array;
      maximumBytes: number;
      checkAuthority: () => Promise<void>;
    }) {
      conversions.push(input.originalBytes.slice());
      await input.checkAuthority();
      if (options.toolError) throw options.toolError;
      toolFinished = true;
      if (options.toolFailure)
        return { kind: 'UNVERIFIABLE', reason: options.toolFailure };
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
      await Promise.resolve();
      extracted.push(input.bytes.slice());
      const structure = structuredClone(wordStructure);
      if (options.invalidStructure) return { tables: [] };
      if (options.alternateWidth) structure.tables[0]!.width.value = '10000';
      if (options.difference && extracted.length === 2)
        structure.tables[0]!.rows[0]!.cells[1]!.text = ' ';
      return structure;
    },
  };
  const process = createIngestionCandidateProcessor({
    pool,
    ...(options.tool === false ? {} : { conversionRunner }),
    async read(input) {
      await Promise.resolve();
      reads.push(input.uploadId);
      const index = pair.assets.findIndex((a) => a.uploadId === input.uploadId);
      if (index < 0) throw Error('unknown byte stream');
      if (options.corruptPrepared && index === 1)
        return new TextEncoder().encode('corrupted bytes');
      return pair.contents[index]!.slice();
    },
    async *parseExternal(input) {
      await Promise.resolve();
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
  return {
    pair,
    calls,
    conversions,
    extracted,
    reads,
    process,
    setCompleted: (batch: unknown) => {
      completedBatch = batch;
    },
  };
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
        ...(failure === 'lease'
          ? {}
          : {
              sqlFailure:
                failure === 'insert'
                  ? 'candidate.insert-conversion-check'
                  : 'commit',
            }),
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
  it('preserves the no-key path without invoking conversion or adding a result', async () => {
    const f = fixture({ noClaims: true });
    expect(await f.process(job)).toMatchObject({
      status: 'PARTIAL',
      parsedRecordCount: 1,
    });
    expect(f.conversions).toEqual([]);
    expect(
      f.calls.some((c) => c.sql.includes('candidate.insert-conversion-check')),
    ).toBe(false);
    expect(
      f.calls.some((c) => c.sql.includes('candidate.conversion-authority')),
    ).toBe(false);
  });
  it('replays a completed claimed batch without rereading bytes or backfilling checks', async () => {
    const f = fixture();
    const result = await f.process(job);
    f.setCompleted({
      reference: result['reference'],
      parserVersion: ANALYSIS_PARSER_VERSION,
      status: 'PARTIAL',
      createdAt: '2026-10-08T00:00:00.000Z',
      assets: f.pair.assets.map((asset, index) => ({
        assetId: asset.assetId,
        sourceHash: asset.sourceHash,
        status: index === 1 ? 'READY' : 'UNSUPPORTED',
        reason:
          index === 1
            ? null
            : index === 0
              ? 'PARSING_FAILED'
              : 'SOURCE_MANIFEST',
        recordCount: index === 1 ? 1 : null,
        featureCount: index === 1 ? 0 : null,
      })),
    });
    const before = {
      reads: f.reads.length,
      conversions: f.conversions.length,
      queries: f.calls.length,
    };
    expect(await f.process(job)).toMatchObject({
      status: 'PARTIAL',
      parsedRecordCount: 1,
    });
    expect(f.reads).toHaveLength(before.reads);
    expect(f.conversions).toHaveLength(before.conversions);
    expect(
      f.calls
        .slice(before.queries)
        .some((c) => c.sql.includes('candidate.insert-conversion-check')),
    ).toBe(false);
  });
  it.each(['CONVERSION_FAILED', 'BUDGET_EXCEEDED'] as const)(
    'retains explicit ordinary tool failure %s',
    async (reason) => {
      const f = fixture({ toolFailure: reason });
      await f.process(job);
      const values = f.calls.find((c) =>
        c.sql.includes('candidate.insert-conversion-check'),
      )!.values;
      expect(values[17]).toBe('UNVERIFIABLE');
      expect(values[25]).toBeNull();
      expect(values[26]).toBe(reason);
      expect(f.calls.at(-1)!.sql).toBe('commit');
    },
  );
  it('rejects invalid full structures without claiming equivalence', async () => {
    const f = fixture({ invalidStructure: true });
    await f.process(job);
    const values = f.calls.find((c) =>
      c.sql.includes('candidate.insert-conversion-check'),
    )!.values;
    expect(values[17]).toBe('UNVERIFIABLE');
    expect(values[26]).toBe('INVALID_STRUCTURE');
    expect(values[25]).toBeNull();
  });
  it('hashes the full compared structure even when summary counts are unchanged', async () => {
    const a = fixture(),
      b = fixture({ alternateWidth: true });
    await a.process(job);
    await b.process(job);
    const av = a.calls.find((c) =>
      c.sql.includes('candidate.insert-conversion-check'),
    )!.values;
    const bv = b.calls.find((c) =>
      c.sql.includes('candidate.insert-conversion-check'),
    )!.values;
    expect(av[17]).toBe('VERIFIED_EQUIVALENT');
    expect(bv[17]).toBe('VERIFIED_EQUIVALENT');
    expect(av[25]).toBe(bv[25]);
    expect(av[24]).not.toBe(bv[24]);
  });
  it.each([
    {
      toolError: new Error('synthetic unexpected adapter failure'),
      category: 'CANDIDATE_PROCESSING_TEMPORARY',
    },
    { corruptPrepared: true, category: 'CANDIDATE_OBJECT_INTEGRITY' },
  ])(
    'rolls back unexpected runner or actual-byte integrity failure',
    async (options) => {
      const f = fixture(options);
      await expect(f.process(job)).rejects.toMatchObject({
        category: options.category,
      });
      expect(f.calls.at(-1)!.sql).toBe('rollback');
      expect(
        f.calls.some((c) =>
          c.sql.includes('candidate.insert-conversion-check'),
        ),
      ).toBe(false);
    },
  );
  it('keeps the first job FOR UPDATE after the long runner and all asset outcomes', async () => {
    const f = fixture();
    await f.process(job);
    const firstLock = f.calls.findIndex(
      (c) => c.sql.includes('ingestion.job') && c.sql.includes('for update'),
    );
    const lastRead = f.calls.findLastIndex((c) =>
      c.sql.includes('candidate.conversion-authority'),
    );
    expect(firstLock).toBeGreaterThan(lastRead);
    expect(
      f.calls
        .filter((c) => c.sql.includes('candidate.conversion-authority'))
        .every((c) => !c.sql.includes('for update')),
    ).toBe(true);
  });
});
