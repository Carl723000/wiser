import { describe, expect, it } from 'vitest';
import { createCandidateConversionProvenanceReader } from '../src/data-foundation/ingestion-candidate-provenance.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';

const id = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
const input = { ...reference, preparedAssetId: id(3) };
const response = { reference, preparedAssetId: id(3) };
const context: DataCapabilityExecutionContext = {
  principal: {
    actorId: id(4),
    actorType: 'human',
    authenticationMethod: 'supabase_jwt',
    authUserId: id(4),
    sessionId: id(5),
  },
  authorization: {
    tenantId: id(6),
    projectId: id(7),
    purpose: 'candidate-review',
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write'],
    maxSecurityLevel: 'L0_PUBLIC',
    authzVersion: 1,
  },
  effectiveMaxSecurityLevel: 'L0_PUBLIC',
  traceId: 'b'.repeat(32),
  auditLevel: 'STANDARD',
  timeoutMs: 10000,
  signal: new AbortController().signal,
};
// Query control seam only; actual FORCE RLS and Worker lease require PostgreSQL acceptance.
function storage(rows: readonly Record<string, unknown>[]) {
  const statements: { sql: string; values?: readonly unknown[] }[] = [];
  let released = false;
  const pool = {
    connect() {
      return Promise.resolve({
        query(sql: string, values?: readonly unknown[]) {
          statements.push({ sql, ...(values ? { values } : {}) });
          return Promise.resolve({
            rows: sql.includes('candidate.provenance.fixed') ? rows : [],
          });
        },
        release() {
          released = true;
        },
      });
    },
  };
  return { pool, statements, released: () => released };
}
describe('fixed private candidate provenance reader', () => {
  it('scopes one read transaction and returns honest missing conversion for a readable member', async () => {
    const s = storage([
      {
        ingestion_id: id(1),
        processing_batch_id: id(2),
        review_hash: reference.reviewHash,
        asset_id: id(3),
        submitted_by_actor_id: id(4),
        submitted_actor_type: 'human',
        submitted_delegator_actor_id: null,
        provenance: null,
      },
    ]);
    const result = await createCandidateConversionProvenanceReader(
      s.pool,
    ).execute(input, context);
    expect(result).toEqual({ ...response, check: null });
    expect(s.statements[0]!.sql).toBe(
      'begin isolation level repeatable read read only',
    );
    expect(
      s.statements.some((statement) =>
        statement.sql.includes('wiser.candidate_maintainer'),
      ),
    ).toBe(true);
    expect(s.statements.at(-1)!.sql).toBe('commit');
    expect(s.released()).toBe(true);
    const fixed = s.statements.find((statement) =>
      statement.sql.includes('candidate.provenance.fixed'),
    )!;
    expect(fixed.values).toEqual([id(1), id(2), reference.reviewHash, id(3)]);
    expect(fixed.sql).not.toContain('storage_key');
  });
  it('returns only the exact server check and refuses malformed or foreign evidence', async () => {
    const check = {
      schemaVersion: 1,
      resultId: id(8),
      reference,
      original: { assetId: id(9), sha256: 'c'.repeat(64), byteSize: 12 },
      prepared: { assetId: id(3), sha256: 'd'.repeat(64), byteSize: 18 },
      manifest: { assetId: id(10), sha256: 'e'.repeat(64) },
      sourceLocalWorkId: 'synthetic-monthly-work',
      historicalToolVersion: null,
      kind: 'HISTORICAL_EQUIVALENCE',
      state: 'VERIFIED_EQUIVALENT',
      rule: { id: 'candidate-word-equivalence', version: '1.0.0' },
      tool: {
        name: 'synthetic-converter',
        version: 'test-only',
        digest: 'f'.repeat(64),
      },
      reconvertedSha256: '1'.repeat(64),
      comparisonDigest: '2'.repeat(64),
      comparison: {
        tableCount: 1,
        physicalCellCount: 1,
        emptyCellCount: 0,
        paragraphCount: 1,
        monthTitleCount: 1,
        differenceCount: 0,
        differences: [],
      },
      failureReason: null,
    };
    const row = {
      ingestion_id: id(1),
      processing_batch_id: id(2),
      review_hash: reference.reviewHash,
      asset_id: id(3),
      submitted_by_actor_id: id(4),
      submitted_actor_type: 'human',
      submitted_delegator_actor_id: null,
      provenance: check,
    };
    const s = storage([row]);
    await expect(
      createCandidateConversionProvenanceReader(s.pool).execute(input, context),
    ).resolves.toEqual({ ...response, check });
    for (const provenance of [
      { ...check, storageKey: 'forbidden-internal-address' },
      { ...check, prepared: { ...check.prepared, assetId: id(90) } },
      { ...check, state: 'VERIFIED_EQUIVALENT', tool: null },
    ]) {
      const bad = storage([{ ...row, provenance }]);
      await expect(
        createCandidateConversionProvenanceReader(bad.pool).execute(
          input,
          context,
        ),
      ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
      expect(bad.statements.at(-1)!.sql).toBe('rollback');
    }
  });
  it('does not connect for insufficient fresh authority or a forged verification input', async () => {
    const s = storage([]);
    await expect(
      createCandidateConversionProvenanceReader(s.pool).execute(input, {
        ...context,
        authorization: {
          ...context.authorization,
          scopes: ['data.operation.read'],
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createCandidateConversionProvenanceReader(s.pool).execute(
        { ...input, verified: true },
        context,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(s.statements).toHaveLength(0);
  });
  it('rolls back for unreadable, foreign or delegated self-reviewer rows without returning content', async () => {
    for (const rows of [
      [],
      [
        {
          ingestion_id: id(91),
          processing_batch_id: id(2),
          review_hash: reference.reviewHash,
          asset_id: id(3),
          submitted_by_actor_id: id(4),
          submitted_actor_type: 'human',
          submitted_delegator_actor_id: null,
          provenance: null,
        },
      ],
      [
        {
          ingestion_id: id(1),
          processing_batch_id: id(2),
          review_hash: reference.reviewHash,
          asset_id: id(3),
          submitted_by_actor_id: id(90),
          submitted_actor_type: 'human',
          submitted_delegator_actor_id: null,
          provenance: null,
        },
      ],
    ]) {
      const s = storage(rows);
      await expect(
        createCandidateConversionProvenanceReader(s.pool).execute(
          input,
          context,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(s.statements.at(-1)!.sql).toBe('rollback');
      expect(s.released()).toBe(true);
    }
  });
});
