import { describe, expect, it } from 'vitest';
import { readCandidateRelationPinAuthorities } from '../src/data-foundation/ingestion-candidate-relations.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
const id = (n: number) =>
  `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pin = { relationId: id(1), revision: 2, decisionVersion: 0 };
const dependency = {
  reference: {
    kind: 'ingestion-candidate',
    ingestionId: id(2),
    processingBatchId: id(3),
    reviewHash: 'a'.repeat(64),
  },
  assetId: id(4),
  recordId: id(5),
  sourceHash: 'b'.repeat(64),
};
const context = (): DataCapabilityExecutionContext => ({
  principal: {
    actorId: id(6),
    actorType: 'human',
    authenticationMethod: 'supabase_jwt',
    authUserId: id(6),
    sessionId: id(7),
  },
  authorization: {
    tenantId: id(8),
    projectId: id(9),
    purpose: 'candidate-review',
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write'],
    maxSecurityLevel: 'L0_PUBLIC',
    authzVersion: 1,
  },
  effectiveMaxSecurityLevel: 'L0_PUBLIC',
  traceId: 'c'.repeat(32),
  auditLevel: 'STANDARD',
  timeoutMs: 10000,
  signal: new AbortController().signal,
});
function scopedClient(
  rows: readonly Record<string, unknown>[],
  onRead = () => {},
) {
  const statements: { sql: string; values?: readonly unknown[] }[] = [];
  return {
    statements,
    query(sql: string, values?: readonly unknown[]) {
      statements.push({ sql, ...(values ? { values } : {}) });
      if (sql.includes('candidate.relations.fixed-pins')) onRead();
      return Promise.resolve({
        rows: sql.includes('candidate.relations.fixed-pins') ? rows : [],
      });
    },
    release() {
      throw Error(
        'Caller transaction must not be released by an internal provider',
      );
    },
  };
}
// Pure transport seam only: no claim of live Auth, PostgreSQL or source RLS.
describe('host-only fixed candidate relationship pin authority', () => {
  it('keeps the explicit host fixed selection rather than widening it to all relation dependencies', async () => {
    const c = scopedClient([{ ...pin, dependencies: [dependency] }]);
    await readCandidateRelationPinAuthorities(
      c,
      context(),
      [pin],
      [dependency.reference],
    );
    const selections = c.statements
      .filter((row) => row.sql.includes('data.ingestion.candidate.scope'))
      .map((row): unknown => JSON.parse(String(row.values?.[6])) as unknown);
    expect(selections).toEqual([[dependency.reference]]);
  });
  it('rejects a dependency outside the explicit host selection without installing that extra source', async () => {
    const foreign = {
      ...dependency,
      reference: { ...dependency.reference, processingBatchId: id(99) },
    };
    const c = scopedClient([{ ...pin, dependencies: [foreign] }]);
    await expect(
      readCandidateRelationPinAuthorities(
        c,
        context(),
        [pin],
        [dependency.reference],
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const selections = c.statements
      .filter((row) => row.sql.includes('data.ingestion.candidate.scope'))
      .map((row): unknown => JSON.parse(String(row.values?.[6])) as unknown);
    expect(selections).toEqual([[dependency.reference]]);
  });

  it('preserves empty relation selection without a query or invented pins', async () => {
    const c = scopedClient([]);
    expect(await readCandidateRelationPinAuthorities(c, context(), [])).toEqual(
      [],
    );
    expect(c.statements).toHaveLength(0);
  });
  it('reads exact content revision and independent latest decision version on the caller transaction', async () => {
    const c = scopedClient([{ ...pin, dependencies: [dependency] }]);
    expect(
      await readCandidateRelationPinAuthorities(c, context(), [pin]),
    ).toEqual([{ ...pin, dependencies: [dependency] }]);
    expect(
      c.statements.some((row) =>
        row.sql.includes('wiser.candidate_maintainer'),
      ),
    ).toBe(true);
    const fixed = c.statements.find((row) =>
      row.sql.includes('candidate.relations.fixed-pins'),
    )!;
    expect(fixed.values).toEqual([JSON.stringify([pin]), id(8), id(9)]);
    expect(fixed.sql).toContain('candidate_relation_sources_readable');
    expect(fixed.sql).toContain('decision_version desc');
    expect(fixed.sql).not.toContain('row_version');
    expect(fixed.sql).not.toContain('storage_key');
    expect(
      c.statements.every(
        (row) => !['begin', 'commit', 'rollback'].includes(row.sql),
      ),
    ).toBe(true);
  });
  it('rejects hidden or missing relation revisions without partial returns', async () => {
    await expect(
      readCandidateRelationPinAuthorities(scopedClient([]), context(), [pin]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('never echoes a caller decision pin when the actual decision version changed', async () => {
    await expect(
      readCandidateRelationPinAuthorities(
        scopedClient([
          { ...pin, decisionVersion: 1, dependencies: [dependency] },
        ]),
        context(),
        [pin],
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects foreign revisions and duplicate backend rows', async () => {
    for (const rows of [
      [{ ...pin, revision: 1, dependencies: [dependency] }],
      [
        { ...pin, dependencies: [dependency] },
        { ...pin, dependencies: [dependency] },
      ],
    ])
      await expect(
        readCandidateRelationPinAuthorities(scopedClient(rows), context(), [
          pin,
        ]),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects empty, oversized, malformed or published dependencies', async () => {
    for (const dependencies of [
      [],
      Array.from({ length: 65 }, () => dependency),
      [{ ...dependency, sourceHash: 'wrong' }],
      [{ ...dependency, reference: { dataItemId: id(2), versionId: id(3) } }],
    ])
      await expect(
        readCandidateRelationPinAuthorities(
          scopedClient([{ ...pin, dependencies }]),
          context(),
          [pin],
        ),
      ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
  });
  it('rejects duplicate and excessive pins before querying', async () => {
    for (const pins of [
      [pin, pin],
      Array.from({ length: 101 }, (_, n) => ({
        ...pin,
        relationId: id(n + 1),
      })),
    ]) {
      const c = scopedClient([]);
      await expect(
        readCandidateRelationPinAuthorities(c, context(), pins),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(c.statements).toHaveLength(0);
    }
  });
  it('honors cancellation and current permission withdrawal before returning dependencies', async () => {
    const controller = new AbortController(),
      ctx = { ...context(), signal: controller.signal };
    await expect(
      readCandidateRelationPinAuthorities(
        scopedClient([{ ...pin, dependencies: [dependency] }], () =>
          controller.abort(),
        ),
        ctx,
        [pin],
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_TIMEOUT' });
    const changed = context();
    await expect(
      readCandidateRelationPinAuthorities(
        scopedClient([{ ...pin, dependencies: [dependency] }], () => {
          changed.authorization.scopes.splice(0);
        }),
        changed,
        [pin],
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('checks authority on empty pins and does not extend expired material scopes', async () => {
    const ctx = context();
    ctx.authorization.scopes.splice(0);
    await expect(
      readCandidateRelationPinAuthorities(scopedClient([]), ctx, []),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      readCandidateRelationPinAuthorities(
        scopedClient([]),
        {
          ...context(),
          principal: {
            ...context().principal,
            expiresAt: '2000-01-01T00:00:00Z',
          },
        },
        [],
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
