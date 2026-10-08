import { describe, expect, it } from 'vitest';
import { createIngestionCandidateRelationExecutors } from '../src/data-foundation/ingestion-candidate-relations-runtime.js';
import { candidateRelationPublicInputs } from './support/candidate-relations-public-fixture.ts';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import {
  CreateCandidateRelationsInputSchema,
  type CandidateRelationSnapshot,
} from '@wiser/data-contracts';
const id = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
const fixture = candidateRelationPublicInputs(reference, id(3), id(4));
type MutableContext = {
  -readonly [
    K in keyof DataCapabilityExecutionContext
  ]: DataCapabilityExecutionContext[K];
};
const context = (): MutableContext => ({
  principal: {
    actorId: id(5),
    actorType: 'human',
    authenticationMethod: 'supabase_jwt',
    authUserId: id(5),
    sessionId: id(6),
  },
  authorization: {
    tenantId: id(7),
    projectId: id(8),
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write', 'data.publish'],
    purpose: 'candidate-review',
    maxSecurityLevel: 'L0_PUBLIC',
    authzVersion: 1,
    resourceAccess: {
      revision: 1,
      fingerprint: 'f'.repeat(64),
      scope: {
        mode: 'managed',
        validUntil: '2099-01-01T00:00:00Z',
        permissions: {
          'source.discover': [],
          'content.read': [],
          'original.read': [],
          'result.export': [],
          'external.directory': [],
        },
      },
    },
  },
  effectiveMaxSecurityLevel: 'L0_PUBLIC',
  traceId: 'c'.repeat(32),
  idempotencyKey: id(90),
  auditLevel: 'DETAILED',
  timeoutMs: 30000,
  signal: new AbortController().signal,
});
type Stored = {
  snapshot: CandidateRelationSnapshot;
  submitted_by_actor_id: string;
  submitted_actor_type: string;
  submitted_delegator_actor_id: string | null;
  purpose: string;
  responsibilities: {
    actorId: string;
    actorType: string;
    delegatedBy: string | null;
  }[];
};
/** Synthetic transaction seam executes production executors, not native SQL/RLS or Auth. */
class Store {
  end() {
    return Promise.resolve();
  }
  rows = new Map<string, Stored>();
  ledger = new Map<string, unknown>();
  mappings = new Map<string, unknown>();
  blocked = false;
  failMapping = false;
  afterSources = () => {};
  next = 100;
  commits = 0;
  releases = 0;
  connect() {
    let backup:
      | {
          rows: Map<string, Stored>;
          ledger: Map<string, unknown>;
          mappings: Map<string, unknown>;
        }
      | undefined;
    return Promise.resolve({
      query: (sql: string, v: readonly unknown[] = []) => {
        if (sql.startsWith('begin'))
          backup = {
            rows: structuredClone(this.rows),
            ledger: structuredClone(this.ledger),
            mappings: structuredClone(this.mappings),
          };
        if (sql === 'rollback' && backup) {
          this.rows = backup.rows;
          this.ledger = backup.ledger;
          this.mappings = backup.mappings;
        }
        if (sql === 'commit') this.commits++;
        const result = (
          rows: Record<string, unknown>[] = [],
          rowCount = rows.length,
        ) => Promise.resolve({ rows, rowCount });
        if (
          sql.includes('data.command.scope') ||
          sql.includes('data.command.idempotency.lock')
        )
          return result([{}], 1);
        if (sql.includes('data.command.idempotency.read'))
          return result(
            this.ledger.has(String(v[0]))
              ? [{ payload: this.ledger.get(String(v[0])) }]
              : [],
          );
        if (sql.includes('data.command.audit.insert')) return result([], 1);
        if (sql.includes('data.command.outbox.insert')) {
          this.ledger.set(String(v[6]), JSON.parse(String(v[4])) as unknown);
          return result([], 1);
        }
        if (sql.includes('candidate.relations.public.sources')) {
          this.afterSources();
          const refs = JSON.parse(String(v[0])) as (typeof reference)[];
          return result(
            this.blocked
              ? []
              : refs.map((r) => ({
                  ingestion_id: r.ingestionId,
                  processing_batch_id: r.processingBatchId,
                  review_hash: r.reviewHash,
                  submitted_by_actor_id: id(5),
                  submitted_actor_type: 'human',
                  submitted_delegator_actor_id: null,
                })),
          );
        }
        if (sql.includes('candidate.relations.public.primary'))
          return result([{ security_level: 'L0_PUBLIC', policy_version: 1 }]);
        if (sql.includes('candidate.relations.public.insert')) {
          const revision = {
            revisionId: String(v[0]),
            relationId: String(v[3]),
            lineageId: String(v[4]),
            revision: Number(v[5]),
            supersedesId: v[6] as string | null,
            reference: {
              kind: 'ingestion-candidate' as const,
              ingestionId: String(v[7]),
              processingBatchId: String(v[8]),
              reviewHash: String(v[9]),
            },
            mappingVersion: String(v[10]),
            ruleVersion: String(v[11]),
            content: JSON.parse(
              String(v[12]),
            ) as CandidateRelationSnapshot['revision']['content'],
          };
          const actor = {
            actorId: String(v[13]),
            actorType: String(v[14]),
            delegatedBy: v[15] as string | null,
          };
          this.rows.set(revision.revisionId, {
            snapshot: {
              revision,
              decisionVersion: 0,
              state: 'PENDING_REVIEW',
              createdAt: `2026-10-08T00:00:${String(this.rows.size).padStart(2, '0')}.123456Z`,
            },
            submitted_by_actor_id: actor.actorId,
            submitted_actor_type: actor.actorType,
            submitted_delegator_actor_id: actor.delegatedBy,
            purpose: String(v[16]),
            responsibilities: [
              actor,
              { actorId: id(5), actorType: 'human', delegatedBy: null },
            ],
          });
          return result([], 1);
        }
        if (sql.includes('candidate.relations.public.get'))
          return result(
            this.blocked
              ? []
              : [...this.rows.values()]
                  .filter(
                    (r) =>
                      r.snapshot.revision.relationId === v[2] &&
                      r.snapshot.revision.revision === v[3],
                  )
                  .map((r) => r as unknown as Record<string, unknown>),
          );
        if (sql.includes('candidate.relations.public.latest'))
          return result([
            {
              revision: Math.max(
                0,
                ...[...this.rows.values()]
                  .filter((r) => r.snapshot.revision.relationId === v[2])
                  .map((r) => r.snapshot.revision.revision),
              ),
            },
          ]);
        if (sql.includes('candidate.relations.public.decision')) {
          const r = this.rows.get(String(v[2]))!;
          r.snapshot = {
            ...r.snapshot,
            decisionVersion: Number(v[3]),
            state: v[4] as CandidateRelationSnapshot['state'],
          };
          return result([], 1);
        }
        if (sql.includes('candidate.relations.public.rebind')) {
          if (this.failMapping)
            throw Object.assign(new Error('Synthetic mapping denied'), {
              code: '42501',
            });
          this.mappings.set(String(v[2]), JSON.parse(String(v[4])) as unknown);
          return result([], 1);
        }
        if (sql.includes('candidate.relations.public.list')) {
          const all = [...this.rows.values()].filter(
            (r) =>
              ![...this.rows.values()].some(
                (n) =>
                  n.snapshot.revision.relationId ===
                    r.snapshot.revision.relationId &&
                  n.snapshot.revision.revision > r.snapshot.revision.revision,
              ),
          );
          const afterTime = typeof v[3] === 'string' ? v[3] : null,
            afterId = typeof v[4] === 'string' ? v[4] : '';
          const selected = all
            .sort(
              (a, b) =>
                b.snapshot.createdAt.localeCompare(a.snapshot.createdAt) ||
                b.snapshot.revision.relationId.localeCompare(
                  a.snapshot.revision.relationId,
                ),
            )
            .filter(
              (r) =>
                !afterTime ||
                r.snapshot.createdAt < afterTime ||
                (r.snapshot.createdAt === afterTime &&
                  r.snapshot.revision.relationId < afterId),
            );
          return result(
            selected
              .slice(0, Number(v[5]))
              .map((r) => r as unknown as Record<string, unknown>),
          );
        }
        return result();
      },
      release: () => {
        this.releases++;
      },
    });
  }
}
function harness() {
  const store = new Store(),
    executors = createIngestionCandidateRelationExecutors(store, {
      idFactory: () => id(store.next++),
      clock: () => new Date('2026-10-08T00:00:00Z'),
    });
  const execute = (op: string, input: unknown, c = context()) =>
    executors
      .find((e) => e.id === `data.ingestion.candidate.relations.${op}`)!
      .execute(input, c);
  return { store, execute };
}
const pin = (r: CandidateRelationSnapshot) => ({
  relationId: r.revision.relationId,
  revision: r.revision.revision,
  decisionVersion: r.decisionVersion,
  references: [reference],
});
async function create(h: ReturnType<typeof harness>, c = context()) {
  return (
    (await h.execute(
      'create',
      fixture['data.ingestion.candidate.relations.create'],
      c,
    )) as { relations: CandidateRelationSnapshot[] }
  ).relations[0]!;
}
const other = () => {
  const c = context();
  c.principal = { ...c.principal, actorId: id(9), authUserId: id(9) };
  c.idempotencyKey = id(91);
  return c;
};
describe('production candidate relation executors with isolated synthetic transactions', () => {
  it('creates server identities, preserves source-local content and reads its exact pin', async () => {
    const h = harness(),
      r = await create(h);
    expect(r.state).toBe('PENDING_REVIEW');
    expect(r.decisionVersion).toBe(0);
    expect(r.revision.relationId).not.toBe(id(4));
    expect(r.revision.reference).toEqual(reference);
    expect(await h.execute('get', pin(r))).toEqual({ relation: r });
    expect(h.store.ledger.size).toBe(1);
  });
  it('treats equivalent UUID spelling as the same candidate command without changing literal evidence', async () => {
    const h = harness();
    const input = CreateCandidateRelationsInputSchema.parse(
      structuredClone(fixture['data.ingestion.candidate.relations.create']),
    );
    input.proposals[0]!.content.evidence[0]!.assetId =
      '4aaa0000-0000-4000-8000-000000000003';
    input.proposals[0]!.content.evidence[0]!.excerpt =
      '4AAA0000-0000-4000-8000-000000000003';
    const first = await h.execute('create', input);
    input.proposals[0]!.content.evidence[0]!.assetId =
      input.proposals[0]!.content.evidence[0]!.assetId.toUpperCase();
    expect(await h.execute('create', input)).toEqual(first);
    expect(h.store.rows.size).toBe(1);
    expect(
      [...h.store.rows.values()][0]!.snapshot.revision.content.evidence[0]!
        .excerpt,
    ).toBe('4AAA0000-0000-4000-8000-000000000003');
  });
  it('normalizes trusted actor UUID spelling on a review replay but keeps actor and purpose binding', async () => {
    const h = harness(),
      r = await create(h),
      c = other();
    c.principal = {
      ...c.principal,
      actorId: '4bbb0000-0000-4000-8000-000000000009',
    };
    const input = {
      ...pin(r),
      status: 'CONFIRMED',
      rationale: 'Independent UUID check',
    };
    const first = await h.execute('review', input, c);
    c.principal = {
      ...c.principal,
      actorId: c.principal.actorId.toUpperCase(),
    };
    expect(await h.execute('review', input, c)).toEqual(first);
    expect(
      h.store.rows.get(r.revision.revisionId)!.snapshot.decisionVersion,
    ).toBe(1);
  });
  it('rechecks denied sources before creation and before an idempotent replay', async () => {
    const h = harness();
    h.store.blocked = true;
    await expect(create(h)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.store.rows.size).toBe(0);
    h.store.blocked = false;
    await create(h);
    h.store.blocked = true;
    await expect(create(h)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.store.ledger.size).toBe(1);
  });
  it('rejects a changed trusted purpose on the same idempotency key without making a new relation', async () => {
    const h = harness();
    await create(h);
    const c = context();
    c.authorization = { ...c.authorization, purpose: 'another-purpose' };
    await expect(create(h, c)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(h.store.rows.size).toBe(1);
  });
  it('rejects self-review and source submitters; permits only an independent human decision', async () => {
    const h = harness(),
      r = await create(h);
    const self = context();
    self.idempotencyKey = id(92);
    await expect(
      h.execute(
        'review',
        {
          ...pin(r),
          status: 'CONFIRMED',
          rationale: 'Self check',
        },
        self,
      ),
    ).rejects.toMatchObject({ code: 'INTAKE_FORBIDDEN' });
    expect(
      h.store.rows.get(r.revision.revisionId)!.snapshot.decisionVersion,
    ).toBe(0);
    const result = (await h.execute(
      'review',
      {
        ...pin(r),
        status: 'CONFIRMED',
        rationale: 'Independent synthetic check',
      },
      other(),
    )) as { relation: CandidateRelationSnapshot };
    expect(result.relation.state).toBe('CONFIRMED');
    expect(result.relation.decisionVersion).toBe(1);
  });
  it('excludes every immutable delegator and forbids delegated reviews before connecting', async () => {
    const h = harness(),
      r = await create(h);
    h.store.rows.get(r.revision.revisionId)!.responsibilities.push({
      actorId: id(20),
      actorType: 'agent',
      delegatedBy: id(9),
    });
    await expect(
      h.execute(
        'review',
        { ...pin(r), status: 'CONFIRMED', rationale: 'Delegator check' },
        other(),
      ),
    ).rejects.toMatchObject({ code: 'INTAKE_FORBIDDEN' });
    const c = other();
    c.principal = {
      actorId: id(20),
      actorType: 'agent',
      delegatedBy: id(9),
      authenticationMethod: 'delegated_credential',
      credentialId: id(30),
    };
    await expect(
      h.execute(
        'review',
        { ...pin(r), status: 'CONFIRMED', rationale: 'Agent check' },
        c,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('withdraws only owned pending proposals and never reviews a stale decision pin', async () => {
    const h = harness(),
      r = await create(h);
    await expect(
      h.execute(
        'withdraw',
        { ...pin(r), rationale: 'Other proposer' },
        other(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const c = context();
    c.idempotencyKey = id(92);
    const result = (await h.execute(
      'withdraw',
      { ...pin(r), rationale: 'Owner withdrawal' },
      c,
    )) as { relation: CandidateRelationSnapshot };
    expect(result.relation.state).toBe('WITHDRAWN');
    await expect(h.execute('get', pin(r))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const d = other();
    d.idempotencyKey = id(93);
    await expect(
      h.execute(
        'review',
        { ...pin(r), status: 'CONFIRMED', rationale: 'Stale read' },
        d,
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
  it('rebinds explicit complete evidence, resets to pending and preserves the old confirmed revision', async () => {
    const h = harness(),
      r = await create(h);
    const approved = (await h.execute(
      'review',
      {
        ...pin(r),
        status: 'CONFIRMED',
        rationale: 'Independent synthetic check',
      },
      other(),
    )) as { relation: CandidateRelationSnapshot };
    const c = context();
    c.idempotencyKey = id(92);
    const input = {
      ...fixture['data.ingestion.candidate.relations.rebind'],
      ...pin(approved.relation),
    };
    const next = (await h.execute('rebind', input, c)) as {
      relation: CandidateRelationSnapshot;
    };
    expect(next.relation.state).toBe('PENDING_REVIEW');
    expect(next.relation.decisionVersion).toBe(0);
    expect(next.relation.revision.revision).toBe(2);
    expect(next.relation.revision.supersedesId).toBe(r.revision.revisionId);
    expect(h.store.mappings.get(next.relation.revision.revisionId)).toEqual(
      input.mapping,
    );
    expect(await h.execute('get', pin(approved.relation))).toEqual(approved);
  });
  it('rejects incomplete mappings and rolls back a new revision if its mapping cannot commit', async () => {
    const h = harness(),
      r = await create(h),
      c = context();
    c.idempotencyKey = id(92);
    const valid = {
      ...fixture['data.ingestion.candidate.relations.rebind'],
      ...pin(r),
    };
    await expect(
      h.execute(
        'rebind',
        {
          ...valid,
          mapping: [
            {
              ...valid.mapping[0],
              from: { ...valid.mapping[0]!.from, sourceHash: 'c'.repeat(64) },
            },
          ],
        },
        c,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.store.rows.size).toBe(1);
    h.store.failMapping = true;
    await expect(h.execute('rebind', valid, c)).rejects.toMatchObject({
      code: 'INTAKE_FORBIDDEN',
    });
    expect(h.store.rows.size).toBe(1);
    expect(h.store.mappings.size).toBe(0);
  });
  it('paginates latest revisions with exact microsecond positions and rejects another actor cursor', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      const c = context();
      c.idempotencyKey = id(90 + i);
      await create(h, c);
    }
    const first = (await h.execute('list', {
      references: [reference],
      first: 1,
    })) as { relations: CandidateRelationSnapshot[]; nextCursor: string };
    expect(first.relations).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (await h.execute('list', {
      references: [reference],
      first: 1,
      after: first.nextCursor,
    })) as { relations: CandidateRelationSnapshot[] };
    expect(second.relations[0]!.revision.relationId).not.toBe(
      first.relations[0]!.revision.relationId,
    );
    await expect(
      h.execute(
        'list',
        { references: [reference], first: 1, after: first.nextCursor },
        other(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('stops expired authority before commit and rejects empty responsibility exclusion sets', async () => {
    const h = harness();
    const c = context();
    h.store.afterSources = () => {
      c.principal = { ...c.principal, expiresAt: '2020-01-01T00:00:00Z' };
    };
    await expect(create(h, c)).rejects.toMatchObject({
      code: 'INTAKE_FORBIDDEN',
    });
    expect(h.store.rows.size).toBe(0);
    h.store.afterSources = () => {};
    const r = await create(h);
    h.store.rows.get(r.revision.revisionId)!.responsibilities = [];
    await expect(
      h.execute(
        'review',
        {
          ...pin(r),
          status: 'CONFIRMED',
          rationale: 'Missing responsibilities',
        },
        other(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
