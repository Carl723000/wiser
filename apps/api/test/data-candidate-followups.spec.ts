import { admitsManagedCapability } from '../src/data-foundation/managed-capability-policy.js';
import { describe, expect, it } from 'vitest';
import { createCandidateFollowupExecutors } from '../src/data-foundation/ingestion-candidate-followups.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import type { CandidateFollowupAssigneeAuthority } from '../src/platform/candidate-followup-assignee-authority.js';
const id = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ref = (n = 1) => ({
  kind: 'ingestion-candidate' as const,
  ingestionId: id(n),
  processingBatchId: id(n + 100),
  reviewHash: 'a'.repeat(64),
});
const evidence = (n = 1) => ({
  reference: ref(n),
  assetId: id(n + 200),
  sourceHash: 'b'.repeat(64),
  locator: `asset:${id(n + 200)}`,
});
function ctx(n = 10, key = 80): DataCapabilityExecutionContext {
  return {
    principal: {
      actorId: id(n),
      actorType: 'human',
      authenticationMethod: 'supabase_jwt',
      authUserId: id(n),
      sessionId: id(11),
    },
    authorization: {
      tenantId: id(20),
      projectId: id(21),
      purpose: 'candidate-review',
      roles: ['data-steward'],
      scopes: ['data.operation.read', 'data.ingestion.write', 'data.publish'],
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
    traceId: 'b'.repeat(32),
    auditLevel: 'STANDARD',
    timeoutMs: 30000,
    signal: new AbortController().signal,
    idempotencyKey: id(key),
  };
}
type Row = Record<string, unknown>;
const parseJSON = (value: unknown): unknown => JSON.parse(String(value));
/** In-memory execution probe, not a PostgreSQL RLS or transaction acceptance test. */
class Store {
  rows = new Map<string, Row>();
  events = new Map<string, Row[]>();
  ledger = new Map<string, Row>();
  blocked = new Set<string>();
  historyHidden = false;
  targetLive = true;
  targetReads = 0;
  statements: string[] = [];
  // Observe pg bind values before JSON decoding erases SQL NULL / JSONB null.
  // This is not a simulation of the database's event guard or RLS.
  appendBindings: {
    action: unknown;
    target: unknown;
    evidence: unknown;
    correction: unknown;
  }[] = [];
  connect() {
    let before: unknown;
    return Promise.resolve({
      query: (sql: string, values: readonly unknown[] = []) =>
        Promise.resolve().then(() => {
          this.statements.push(sql);
          if (sql.startsWith('begin'))
            before = structuredClone([this.rows, this.events, this.ledger]);
          if (sql === 'rollback' && before)
            [this.rows, this.events, this.ledger] = before as [
              Map<string, Row>,
              Map<string, Row[]>,
              Map<string, Row>,
            ];
          const out = (rows: Row[] = [], rowCount = rows.length) => ({
            rows,
            rowCount,
          });
          if (
            sql.includes('data.command.scope') ||
            sql.includes('data.command.idempotency.lock')
          )
            return out([{}]);
          if (sql.includes('data.command.idempotency.read'))
            return out(
              this.ledger.has(String(values[0]))
                ? [{ payload: this.ledger.get(String(values[0])) }]
                : [],
            );
          if (sql.includes('data.command.audit.insert')) return out([], 1);
          if (sql.includes('data.command.outbox.insert')) {
            const payload = parseJSON(values[4]);
            if (
              typeof payload !== 'object' ||
              payload === null ||
              Array.isArray(payload)
            )
              throw new Error('Expected an outbox payload object');
            this.ledger.set(String(values[6]), payload as Row);
            return out([], 1);
          }
          if (sql.includes('candidate.followup.sources')) {
            const sources = JSON.parse(String(values[2])) as ReturnType<
              typeof evidence
            >[];
            return out([
              {
                readable: sources.every(
                  (source) =>
                    !this.blocked.has(source.reference.processingBatchId),
                ),
              },
            ]);
          }
          if (sql.includes('candidate.followup.target-live'))
            return out([{ live: this.targetLive }]);
          if (sql.includes('candidate.followup.source-policy'))
            return out([{ security_level: 'L0_PUBLIC', policy_version: 1 }]);
          if (sql.includes('candidate.followup.create')) {
            const row = {
              followup_id: values[0],
              tenant_id: values[1],
              project_id: values[2],
              type: values[3],
              source: parseJSON(values[4]),
              rule_id: values[5],
              rule_version: values[6],
              reason: values[7],
              created_by_actor_id: values[8],
              created_actor_type: values[9],
              created_delegated_by: values[10],
              purpose: values[11],
              security_level: values[12],
              policy_version: values[13],
              state: 'OPEN',
              row_version: 0,
              assignee: null,
              evidence: [],
              responsibilities: [],
              created_at: '2026-10-08T00:00:00Z',
            };
            this.rows.set(String(values[0]), row);
            return out([], 1);
          }
          if (sql.includes('candidate.followup.append')) {
            this.appendBindings.push({
              action: values[5],
              target: values[10],
              evidence: values[11],
              correction: values[12],
            });
            const row = this.rows.get(String(values[3]))!;
            const actor = {
              actorId: values[6],
              actorType: values[7],
              delegatedBy: values[8],
              purpose: values[9],
            };
            const ev = {
              event_id: values[0],
              row_version: Number(values[4]) + 1,
              expected_version: values[4],
              action: values[5],
              actor_id: values[6],
              actor_type: values[7],
              delegated_by: values[8],
              purpose: values[9],
              target: parseJSON(values[10]),
              evidence: parseJSON(values[11]),
              correction: parseJSON(values[12]),
              note: values[13],
              state_after: values[16],
              created_at: '2026-10-08T00:00:00Z',
            };
            const history = this.events.get(String(values[3])) ?? [];
            history.push(ev);
            this.events.set(String(values[3]), history);
            Object.assign(row, {
              row_version: ev.row_version,
              state: values[16],
              assignee: parseJSON(values[17]),
              evidence: parseJSON(values[18]),
              responsibilities:
                values[5] === 'CREATE' ? [actor] : parseJSON(values[19]),
            });
            return out([], 1);
          }
          if (sql.includes('candidate.followup.get'))
            return out(
              this.rows.has(String(values[0]))
                ? [this.rows.get(String(values[0]))!]
                : [],
            );
          if (sql.includes('candidate.followup.history'))
            return out(
              this.historyHidden
                ? []
                : (this.events.get(String(values[0])) ?? []),
            );
          if (sql.includes('candidate.followup.list-source'))
            return out(
              this.blocked.has(String(values[1]))
                ? []
                : [{ processing_batch_id: values[1] }],
            );
          if (sql.includes('candidate.followup.list'))
            return out(
              [...this.rows.values()]
                .filter(
                  (row) =>
                    (row['source'] as ReturnType<typeof evidence>).reference
                      .ingestionId === values[0],
                )
                .slice(0, Number(values[6]))
                .map((row) => ({
                  followup_id: row['followup_id'],
                  created_at: row['created_at'],
                })),
            );
          return out([{}]);
        }),
      release() {},
    });
  }
}
function setup() {
  const store = new Store();
  let available = true;
  const target: CandidateFollowupAssigneeAuthority = (actorId, subject) => {
    store.targetReads++;
    return Promise.resolve(
      available
        ? {
            actorId,
            actorType: 'human',
            delegatedBy: null,
            purpose: subject.purpose,
            deadline: '2099-01-01T00:00:00Z',
            maxSecurityLevel: 'L0_PUBLIC',
            policyVersion: 1,
            maintainer: true,
            reviewer: false,
            resourceScope: null,
          }
        : null,
    );
  };
  const ex = createCandidateFollowupExecutors(store, target);
  return {
    store,
    ex,
    setTargetAvailable: (v: boolean) => {
      available = v;
    },
    run: async (op: string, input: unknown, context = ctx()) =>
      (await ex
        .find((e) => e.id === `data.ingestion.candidate.followup.${op}`)!
        .execute(input, context)) as {
        followup: Row;
        items: Row[];
        nextCursor: string | null;
      },
  };
}
const createInput = () => ({
  type: 'GAP',
  source: evidence(),
  ruleId: 'coverage',
  ruleVersion: '1',
  reason: 'Missing report period',
});
describe('followup application wiring through production executors', () => {
  it('creates, gets and lists a private source-bound task with complete technical history', async () => {
    const s = setup(),
      made = await s.run('create', createInput());
    const followupId = made.followup['followupId'];
    expect(made.followup['state']).toBe('OPEN');
    expect(made.followup['technicalOnly']).toBe(true);
    expect(made.followup['events']).toHaveLength(1);
    expect((await s.run('get', { followupId })).followup).toEqual(
      made.followup,
    );
    expect((await s.run('list', { ...ref(), first: 2 })).items).toHaveLength(1);
    expect(s.store.statements.join('\n')).not.toMatch(
      /update catalog|ingestion\.approve/,
    );
  });
  it('acts through claim, handoff, supplement, review submission and independent review', async () => {
    const s = setup();
    const made = await s.run('create', createInput());
    const followupId = made.followup['followupId'];
    await s.run(
      'act',
      { followupId, expectedVersion: 1, action: 'CLAIM', note: 'Claim' },
      ctx(10, 81),
    );
    await s.run(
      'act',
      {
        followupId,
        expectedVersion: 2,
        action: 'HANDOFF',
        targetActorId: id(12),
        note: 'Handoff',
      },
      ctx(10, 82),
    );
    expect(s.store.targetReads).toBe(2);
    await s.run(
      'act',
      {
        followupId,
        expectedVersion: 3,
        action: 'SUPPLEMENT',
        evidence: [evidence(2)],
        note: 'New standard candidate',
      },
      ctx(12, 83),
    );
    await s.run(
      'act',
      {
        followupId,
        expectedVersion: 4,
        action: 'SUBMIT_REVIEW',
        note: 'Ready',
      },
      ctx(12, 84),
    );
    await expect(
      s.run(
        'review',
        { followupId, expectedVersion: 5, decision: 'CLOSE', note: 'Self' },
        ctx(10, 85),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const closed = await s.run(
      'review',
      {
        followupId,
        expectedVersion: 5,
        decision: 'CLOSE',
        note: 'Independent',
      },
      ctx(13, 86),
    );
    expect(closed.followup['state']).toBe('CLOSED');
    expect(closed.followup['events']).toHaveLength(6);
  });
  it.each(['create', 'get', 'list', 'act', 'review'])(
    'denies %s without current operation rights before any database work',
    async (op) => {
      const s = setup(),
        context = ctx();
      const noRights = {
        ...context,
        authorization: { ...context.authorization, scopes: [] },
      };
      const inputs: Record<string, unknown> = {
        create: createInput(),
        get: { followupId: id(30) },
        list: { ...ref() },
        act: {
          followupId: id(30),
          expectedVersion: 1,
          action: 'CLAIM',
          note: 'Claim',
        },
        review: {
          followupId: id(30),
          expectedVersion: 1,
          decision: 'CLOSE',
          note: 'Review',
        },
      };
      await expect(s.run(op, inputs[op], noRights)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(s.store.statements).toHaveLength(0);
    },
  );
  it('closes reads and same-key replay when any current source permission is gone', async () => {
    const s = setup(),
      made = await s.run('create', createInput());
    s.store.blocked.add(ref().processingBatchId);
    await expect(s.run('create', createInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      s.run('get', { followupId: made.followup['followupId'] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.run('list', { ...ref() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('rechecks target authorization and denies unknown or source-ineligible assignments', async () => {
    const s = setup(),
      made = await s.run('create', createInput()),
      followupId = made.followup['followupId'];
    await s.run(
      'act',
      { followupId, expectedVersion: 1, action: 'CLAIM', note: 'Claim' },
      ctx(10, 81),
    );
    s.setTargetAvailable(false);
    await expect(
      s.run(
        'act',
        {
          followupId,
          expectedVersion: 2,
          action: 'HANDOFF',
          targetActorId: id(12),
          note: 'Handoff',
        },
        ctx(10, 82),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    s.setTargetAvailable(true);
    s.store.targetLive = false;
    await expect(
      s.run(
        'act',
        {
          followupId,
          expectedVersion: 2,
          action: 'HANDOFF',
          targetActorId: id(12),
          note: 'Handoff',
        },
        ctx(10, 82),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects stale version, incomplete history and a same-key changed purpose', async () => {
    const s = setup(),
      made = await s.run('create', createInput()),
      followupId = made.followup['followupId'];
    await expect(
      s.run(
        'act',
        { followupId, expectedVersion: 2, action: 'CLAIM', note: 'Claim' },
        ctx(10, 81),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    s.store.historyHidden = true;
    await expect(s.run('get', { followupId })).rejects.toMatchObject({
      code: 'EXECUTION_FAILED',
    });
    s.store.historyHidden = false;
    const context = ctx();
    await expect(
      s.run('create', createInput(), {
        ...context,
        authorization: { ...context.authorization, purpose: 'other' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

it('admits the five guarded capabilities without opening unguarded maintenance families', () => {
  for (const op of ['create', 'get', 'list', 'act', 'review'] as const)
    expect(
      admitsManagedCapability(`data.ingestion.candidate.followup.${op}`),
    ).toBe(true);
  expect(admitsManagedCapability('data.ingestion.approve')).toBe(false);
  expect(admitsManagedCapability('data.ingestion.resume')).toBe(false);
});

it('normalizes source UUID spelling before persistence and same-key replay, preserving literal locator', async () => {
  const s = setup();
  const lower = {
    ...createInput(),
    source: {
      ...evidence(),
      reference: {
        ...ref(),
        ingestionId: 'abcdefab-cdef-4abc-8abc-abcdefabcdef',
        processingBatchId: 'bcdefabc-defa-4bcd-8bcd-bcdefabcdefa',
      },
      assetId: 'cdefabcd-efab-4cde-8cde-cdefabcdefab',
      locator: 'asset:cdefabcd-efab-4cde-8cde-cdefabcdefab',
    },
  };
  const upper = {
    ...lower,
    source: {
      ...lower.source,
      reference: {
        ...lower.source.reference,
        ingestionId: lower.source.reference.ingestionId.toUpperCase(),
        processingBatchId:
          lower.source.reference.processingBatchId.toUpperCase(),
      },
      assetId: lower.source.assetId.toUpperCase(),
    },
  };
  const first = await s.run('create', upper);
  expect(first.followup['source']).toEqual(lower.source);
  expect((await s.run('create', lower)).followup['followupId']).toBe(
    first.followup['followupId'],
  );
  expect(s.store.rows.size).toBe(1);
});

describe('followup event SQL parameter boundary', () => {
  const actions = [
    'CREATE',
    'CLAIM',
    'HANDOFF',
    'SUPPLEMENT',
    'SUBMIT_REVIEW',
    'CLOSE',
    'RETURN',
    'REOPEN',
  ] as const;
  type Action = (typeof actions)[number];
  async function bindingsFor(action: Action, withCorrection = false) {
    const s = setup();
    const recordEvidence = (n: number) => ({
      ...evidence(n),
      recordId: id(n + 300),
      locator: `synthetic-record:${n}`,
      geometry: { type: 'Point' as const, coordinates: [116 + n, 40] },
      sourceCrs: 'EPSG:4326',
    });
    const source = withCorrection ? recordEvidence(1) : evidence();
    const supplemental = withCorrection ? recordEvidence(2) : evidence(2);
    const correction = {
      scope: 'WHOLE_RECORD',
      old: source,
      new: supplemental,
      mappingReason: 'Synthetic whole-record correspondence',
    };
    const made = await s.run('create', {
      ...createInput(),
      type: withCorrection ? 'CORRECTION' : 'GAP',
      source,
    });
    const followupId = made.followup['followupId'];
    const result = () => ({
      binding: s.store.appendBindings.at(-1)!,
      supplemental,
      correction,
    });
    if (action === 'CREATE') return result();
    await s.run(
      'act',
      { followupId, expectedVersion: 1, action: 'CLAIM', note: 'Claim' },
      ctx(10, 81),
    );
    if (action === 'CLAIM') return result();
    if (action === 'HANDOFF') {
      await s.run(
        'act',
        {
          followupId,
          expectedVersion: 2,
          action,
          targetActorId: id(12),
          note: 'Handoff',
        },
        ctx(10, 82),
      );
      return result();
    }
    await s.run(
      'act',
      {
        followupId,
        expectedVersion: 2,
        action: 'SUPPLEMENT',
        evidence: [supplemental],
        ...(withCorrection ? { correction } : {}),
        note: 'Synthetic supplemental candidate',
      },
      ctx(10, 83),
    );
    if (action === 'SUPPLEMENT') return result();
    await s.run(
      'act',
      {
        followupId,
        expectedVersion: 3,
        action: 'SUBMIT_REVIEW',
        note: 'Ready',
      },
      ctx(10, 84),
    );
    if (action === 'SUBMIT_REVIEW') return result();
    await s.run(
      'review',
      {
        followupId,
        expectedVersion: 4,
        decision: action === 'RETURN' ? 'RETURN' : 'CLOSE',
        note: 'Independent technical review',
      },
      ctx(13, 85),
    );
    if (action !== 'REOPEN') return result();
    await s.run(
      'act',
      { followupId, expectedVersion: 5, action, note: 'Reopen' },
      ctx(10, 86),
    );
    return result();
  }

  it.each(actions)(
    'binds absent %s action fields as SQL NULL',
    async (action) => {
      const { binding, supplemental } = await bindingsFor(action);
      expect(binding.action).toBe(action);
      // SQL IS NOT NULL rejects JSONB null for these inapplicable fields (0047).
      if (action !== 'HANDOFF') expect.soft(binding.target).toBeNull();
      expect.soft(binding.correction).toBeNull();
      expect(parseJSON(binding.evidence)).toEqual(
        action === 'SUPPLEMENT' ? [supplemental] : [],
      );
    },
  );

  it('binds a correction supplement without an inapplicable target', async () => {
    const { binding } = await bindingsFor('SUPPLEMENT', true);
    expect(binding.action).toBe('SUPPLEMENT');
    expect(binding.target).toBeNull();
  });

  it('preserves the server-resolved HANDOFF responsibility object', async () => {
    const { binding } = await bindingsFor('HANDOFF');
    expect(typeof binding.target).toBe('string');
    expect(parseJSON(binding.target)).toEqual({
      actorId: id(12),
      actorType: 'human',
      delegatedBy: null,
      purpose: 'candidate-review',
    });
  });

  it('preserves SUPPLEMENT evidence and whole-record correction objects', async () => {
    const { binding, supplemental, correction } = await bindingsFor(
      'SUPPLEMENT',
      true,
    );
    expect(typeof binding.correction).toBe('string');
    expect(parseJSON(binding.evidence)).toEqual([supplemental]);
    expect(parseJSON(binding.correction)).toEqual(correction);
  });
});
