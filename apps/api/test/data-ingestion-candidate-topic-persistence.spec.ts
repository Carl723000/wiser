import { describe, expect, it } from 'vitest';
import * as savedExecutors from '../src/data-foundation/ingestion-candidate-saved.js';
import type { CandidateTopicPinAuthorities } from '../src/data-foundation/ingestion-candidate-topic-pins.js';
import type {
  DataCapabilityExecutor,
  DataCapabilityExecutionContext,
} from '../src/data-foundation/capability-handler.js';
import {
  ownsPendingSubmission,
  canReadPendingSubmission,
} from '../src/data-foundation/managed-ingestion-access.js';
import { candidateReadAuthority } from '../src/data-foundation/candidate-read-authority.js';

const uuid = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = (n = 1) => ({
  kind: 'ingestion-candidate' as const,
  ingestionId: uuid(n),
  processingBatchId: uuid(n + 100),
  reviewHash: 'a'.repeat(64),
});
const context: DataCapabilityExecutionContext = {
  principal: {
    actorId: uuid(10),
    actorType: 'human',
    authenticationMethod: 'supabase_jwt',
    authUserId: uuid(10),
    sessionId: uuid(11),
  },
  authorization: {
    tenantId: uuid(20),
    projectId: uuid(21),
    purpose: 'candidate-review',
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write'],
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
  idempotencyKey: uuid(80),
};
const legacy = () => ({
  title: '固定待审资料',
  visibility: 'private',
  references: [reference()],
  viewSpec: {
    period: {
      from: '2023-04',
      to: '2023-05',
      unit: 'month',
      includeUndated: false,
    },
    page: {
      kind: 'records',
      reference: reference(),
      assetId: uuid(30),
      first: 2,
      afterRecordId: uuid(32),
    },
    focus: { reference: reference(), assetId: uuid(30), recordId: uuid(33) },
    map: {
      camera: { longitude: 116, latitude: 40, zoom: 8, bearing: 0, pitch: 0 },
      layers: { points: true, lines: true, polygons: true },
    },
  },
});
type Row = Record<string, unknown>;

/** Synthetic scoped storage only. The separate migrated PostgreSQL test is the RLS proof. */
class Store {
  views = new Map<string, Row>();
  ledger = new Map<string, Row>();
  blocked = new Set<string>();
  current = context;
  submission: Row = { actorId: uuid(10), actorType: 'human' };
  anchor = true;
  denyRevoke = false;
  statements: string[] = [];
  fixedSelection: unknown = [];
  checkedSelections: { requested: unknown; installed: unknown }[] = [];
  events = 0;
  metadataRole = false;
  receiptSelection = '';
  changedRules = false;
  providerCalls = 0;
  closedConnections = 0;
  connect() {
    let snapshot:
      | { views: Map<string, Row>; ledger: Map<string, Row>; events: number }
      | undefined;
    return Promise.resolve({
      query: (sql: string, values: readonly unknown[] = []) =>
        Promise.resolve().then(() => {
          this.statements.push(sql);
          if (sql === 'set local role wiser_data_metadata')
            this.metadataRole = true;
          if (sql === 'set local role wiser_data_api')
            this.metadataRole = false;
          if (sql.includes('candidate.topic.receipt.scope'))
            this.receiptSelection = String(values[0]);
          if (sql.includes('candidate.topic.material'))
            return {
              rows: [
                {
                  ingestion_id: reference().ingestionId,
                  processing_batch_id: reference().processingBatchId,
                  review_hash: reference().reviewHash,
                  tenant_id: context.authorization.tenantId,
                  project_id: context.authorization.projectId,
                  asset_id: uuid(30),
                  source_hash: 'b'.repeat(64),
                  parser_version: 'synthetic/1',
                  record_id: null,
                  record_index: 1,
                  source_id: null,
                  record_values_json: '{}',
                  source_crs: null,
                  geometry: null,
                  geometry_bytes: null,
                },
              ],
            };
          if (sql.includes('/* candidate.topic.receipt */')) {
            if (!this.metadataRole)
              throw Error('Receipt must use the limited role');
            const row = this.views.get(String(values[0]));
            return {
              rows:
                row &&
                row.view_id === this.receiptSelection &&
                row.view_spec &&
                typeof row.view_spec === 'object' &&
                (row.view_spec as Row).schemaVersion === 2 &&
                row.revoked_at === null &&
                row.tenant_id === this.current.authorization.tenantId &&
                row.project_id === this.current.authorization.projectId &&
                row.purpose === this.current.authorization.purpose &&
                ownsPendingSubmission(this.current, {
                  actorId: row.actor_id,
                  actorType: row.actor_type,
                  ...(row.delegated_by
                    ? { delegatedBy: row.delegated_by }
                    : {}),
                })
                  ? [{ view_id: row.view_id }]
                  : [],
            };
          }
          if (sql.includes('data.ingestion.candidate.scope'))
            this.fixedSelection = JSON.parse(String(values[6]));
          if (sql === 'commit' || sql === 'rollback') this.metadataRole = false;
          if (sql.startsWith('begin'))
            snapshot = {
              views: structuredClone(this.views),
              ledger: structuredClone(this.ledger),
              events: this.events,
            };
          if (sql === 'rollback' && snapshot) {
            this.views = snapshot.views;
            this.ledger = snapshot.ledger;
            this.events = snapshot.events;
          }
          if (
            sql.includes('data.command.scope') ||
            sql.includes('data.command.idempotency.lock')
          )
            return { rows: [{ set_config: 'ok' }], rowCount: 1 };
          if (sql.includes('data.command.idempotency.read')) {
            const rows = this.ledger.has(String(values[0]))
              ? [{ payload: this.ledger.get(String(values[0])) }]
              : [];
            return { rows, rowCount: rows.length };
          }
          if (sql.includes('data.command.audit.insert'))
            return { rows: [], rowCount: 1 };
          if (sql.includes('data.command.outbox.insert')) {
            this.ledger.set(
              String(values[6]),
              JSON.parse(String(values[4])) as Row,
            );
            this.events++;
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('candidate.saved.references')) {
            this.checkedSelections.push({
              requested: JSON.parse(String(values[0])),
              installed: structuredClone(this.fixedSelection),
            });
            const refs = JSON.parse(String(values[0])) as ReturnType<
              typeof reference
            >[];
            const authority = candidateReadAuthority(this.current);
            return {
              rows: refs
                .filter(
                  (r) =>
                    !this.blocked.has(r.processingBatchId) &&
                    canReadPendingSubmission(
                      this.current,
                      this.submission,
                      authority,
                    ),
                )
                .map((r) => ({
                  ...r,
                  ingestion_id: r.ingestionId,
                  processing_batch_id: r.processingBatchId,
                  review_hash: r.reviewHash,
                  security_level: 'L0_PUBLIC',
                  submitted_by_actor_id: this.submission.actorId,
                  submitted_actor_type: this.submission.actorType,
                  submitted_delegator_actor_id:
                    this.submission.delegatedBy ?? null,
                })),
            };
          }
          if (sql.includes('candidate.saved.anchor'))
            return {
              rows: this.anchor
                ? [{ ordinal: 1, record_index: 1, has_geometry: true }]
                : [],
            };
          if (sql.includes('candidate.saved.insert')) {
            const row: Row = {
              view_id: values[0],
              tenant_id: values[1],
              project_id: values[2],
              actor_id: values[3],
              actor_type: values[4],
              delegated_by: values[5],
              purpose: values[6],
              security_level: values[7],
              policy_version: values[8],
              title: values[9],
              visibility: values[10],
              candidate_refs: JSON.parse(String(values[11])),
              view_spec: JSON.parse(String(values[12])),
              created_at: values[13],
              revoked_at: null,
            };
            this.views.set(String(values[0]), row);
            return { rows: [row], rowCount: 1 };
          }
          if (sql.includes('candidate.saved.revoke')) {
            if (this.denyRevoke) return { rows: [], rowCount: 0 };
            const row = this.views.get(String(values[0]));
            if (row) {
              row.revoked_at ??= values[1];
              return { rows: [row], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes('candidate.saved.get')) {
            if (this.metadataRole)
              throw Error('Limited role cannot select title/spec/refs');
            const row = this.views.get(String(values[0]));
            return {
              rows:
                row &&
                (row.candidate_refs as ReturnType<typeof reference>[]).every(
                  (ref) => !this.blocked.has(ref.processingBatchId),
                )
                  ? [row]
                  : [],
            };
          }
          if (
            sql.includes('candidate.saved.list') ||
            sql.includes('candidate.topic.list')
          ) {
            const visible = [...this.views.values()].filter(
              (r) =>
                (!sql.includes("not (view_spec ? 'schemaVersion')") ||
                  !(r.view_spec as Row).schemaVersion) &&
                r.revoked_at === null &&
                r.purpose === this.current.authorization.purpose &&
                (r.visibility === 'project' ||
                  ownsPendingSubmission(this.current, {
                    actorId: r.actor_id,
                    actorType: r.actor_type,
                    ...(r.delegated_by ? { delegatedBy: r.delegated_by } : {}),
                  })) &&
                (r.candidate_refs as ReturnType<typeof reference>[]).every(
                  (ref) => !this.blocked.has(ref.processingBatchId),
                ),
            );
            visible.sort(
              (a, b) =>
                String(b.created_at).localeCompare(String(a.created_at)) ||
                String(b.view_id).localeCompare(String(a.view_id)),
            );
            const offset = values[1]
              ? visible.findIndex((r) => r.view_id === values[2]) + 1
              : 0;
            return { rows: visible.slice(offset, offset + Number(values[0])) };
          }
          return { rows: [], rowCount: 1 };
        }),
      release: () => {
        this.closedConnections++;
      },
    });
  }
}

const topic = () => ({
  title: 'Synthetic full topic',
  visibility: 'project',
  references: [reference()],
  viewSpec: {
    schemaVersion: 2,
    page: {
      kind: 'records',
      reference: reference(),
      assetId: uuid(30),
      first: 2,
    },
    period: {
      windowMode: 'month',
      from: '2023-04',
      to: '2023-05',
      displayUnit: 'month',
      timeRole: 'REPORT_PERIOD',
      includeUndated: false,
    },
    topic: {
      question: 'Synthetic fixed question',
      regionIds: ['yongding'],
      needIds: ['quality'],
      recordPins: [],
    },
    rulePins: ['projection', 'readiness', 'requirement', 'impact'].map(
      (kind) => ({ kind, ruleId: kind + '-synthetic', version: '1' }),
    ),
    dependencyPins: [
      {
        kind: 'asset',
        reference: reference(),
        assetId: uuid(30),
        sourceHash: 'b'.repeat(64),
        parserVersion: 'synthetic/1',
      },
    ],
    relationPins: [] as {
      relationId: string;
      revision: number;
      decisionVersion: number;
    }[],
  },
});
const authorities = (store: Store): CandidateTopicPinAuthorities => ({
  loadRules: (_client, _context, _selection) => {
    store.providerCalls++;
    const pins = topic().viewSpec.rulePins;
    return Promise.resolve(
      pins.map((p) => ({
        ...p,
        kind: p.kind as 'projection' | 'readiness' | 'requirement' | 'impact',
        version: store.changedRules ? 'not-applicable' : p.version,
      })),
    );
  },
});
async function call(
  store: Store,
  id: string,
  value: unknown,
  actor = context,
  provider: CandidateTopicPinAuthorities | null = authorities(store),
) {
  store.current = actor;
  const factory =
    savedExecutors.createIngestionCandidateSavedExecutors as unknown as (
      pool: Store,
      pins?: CandidateTopicPinAuthorities,
    ) => readonly DataCapabilityExecutor[];
  const executor = factory(store, provider ?? undefined).find(
    (e) => e.id === id,
  );
  expect(executor, `missing public executor ${id}`).toBeDefined();
  return executor!.execute(value, actor) as Promise<Row>;
}
const create = 'data.ingestion.candidate.topic.create',
  list = 'data.ingestion.candidate.topic.list',
  open = 'data.ingestion.candidate.topic.open';
const savedId = (value: Row) => (value.savedView as Row).viewId as string;

describe('complete candidate topic server persistence (synthetic transaction adapter)', () => {
  it('persists v2 through existing immutable save/Outbox and rechecks authoritative pins on open and same-key replay', async () => {
    const store = new Store();
    const value = topic();
    const first = await call(store, create, value);
    const replay = await call(store, create, value);
    expect(replay).toEqual(first);
    expect(store.views.size).toBe(1);
    expect(store.events).toBe(1);
    expect((first.savedView as Row).specVersion).toBe(2);
    const opened = await call(store, open, { viewId: savedId(first) });
    expect(opened.status).toBe('READABLE');
    expect(opened.specVersion).toBe(2);
    expect(opened.viewSpec).toEqual(value.viewSpec);
    expect(opened.references).toEqual(value.references);
    expect(store.providerCalls).toBe(3);
    for (const check of store.checkedSelections)
      expect(check.installed).toEqual(check.requested);
    expect(store.closedConnections).toBe(3);
  });
  it('keeps the old list v1-only while topic list and open explicitly dispatch v1/v2', async () => {
    const store = new Store();
    const old = await call(
      store,
      'data.ingestion.candidate.view.create',
      legacy(),
    );
    const modern = await call(store, create, topic(), {
      ...context,
      idempotencyKey: uuid(81),
    });
    const oldList = await call(store, 'data.ingestion.candidate.view.list', {});
    expect(oldList.items).toHaveLength(1);
    expect((oldList.items as Row[])[0]!.viewId).toBe(savedId(old));
    const newList = await call(store, list, {});
    expect((newList.items as Row[]).map((x) => x.specVersion).sort()).toEqual([
      1, 2,
    ]);
    const oldOpen = await call(store, open, { viewId: savedId(old) });
    expect(oldOpen.specVersion).toBe(1);
    expect(oldOpen.viewSpec).toEqual(legacy().viewSpec);
    expect((oldOpen.viewSpec as Row).topic).toBeUndefined();
    await expect(
      call(store, 'data.ingestion.candidate.view.open', {
        viewId: savedId(modern),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('isolates topic and legacy continuation cursors', async () => {
    const store = new Store();
    await call(store, create, topic());
    await call(
      store,
      create,
      { ...topic(), title: 'Second' },
      { ...context, idempotencyKey: uuid(81) },
    );
    const page = await call(store, list, { first: 1 });
    expect(page.nextCursor).toBeTypeOf('string');
    await expect(
      call(store, 'data.ingestion.candidate.view.list', {
        first: 1,
        after: page.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('fails closed without a host rules provider and never persists authority echoed by the client', async () => {
    const store = new Store();
    await expect(
      call(store, create, topic(), context, null),
    ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
    expect(store.views.size).toBe(0);
    expect(store.events).toBe(0);
  });
  it('rejects a changed actual rule set on save, and exposes only original-owner unavailable on restore/replay', async () => {
    const store = new Store();
    const first = await call(store, create, topic());
    const id = savedId(first);
    store.changedRules = true;
    const restored = await call(store, open, { viewId: id });
    expect(restored).toEqual({ status: 'UNAVAILABLE', viewId: id });
    await expect(call(store, create, topic())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      call(
        store,
        open,
        { viewId: id },
        {
          ...context,
          principal: {
            ...context.principal,
            actorId: uuid(15),
            authUserId: uuid(15),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(store, list, { first: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(store.events).toBe(1);
  });
  it('does not leak hidden topic metadata and narrows receipt to original responsibility, scope, purpose and active identity', async () => {
    const store = new Store();
    const created = await call(store, create, topic());
    const id = savedId(created);
    store.blocked.add(reference().processingBatchId);
    expect(await call(store, open, { viewId: id })).toEqual({
      status: 'UNAVAILABLE',
      viewId: id,
    });
    expect(store.statements).toContain('set local role wiser_data_metadata');
    expect(store.metadataRole).toBe(false);
    const mutations: DataCapabilityExecutionContext[] = [
      {
        ...context,
        authorization: { ...context.authorization, projectId: uuid(22) },
      },
      {
        ...context,
        authorization: { ...context.authorization, purpose: 'another-purpose' },
      },
      {
        ...context,
        principal: {
          ...context.principal,
          actorId: uuid(15),
          authUserId: uuid(15),
        },
      },
      {
        ...context,
        principal: { ...context.principal, expiresAt: '2000-01-01T00:00:00Z' },
      },
    ];
    for (const current of mutations)
      await expect(
        call(store, open, { viewId: id }, current),
      ).rejects.toHaveProperty('code');
    await expect(call(store, open, { viewId: uuid(99) })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    expect(await call(store, list, {})).toMatchObject({ items: [] });
  });
  it('rejects mixed or unknown version specs, changed input and changed same-key immutable identity without second save', async () => {
    const store = new Store();
    const original = topic();
    await call(store, create, original);
    await expect(
      call(store, create, { ...original, title: 'Changed same key' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      call(store, create, original, {
        ...context,
        principal: {
          ...context.principal,
          actorId: uuid(15),
          authUserId: uuid(15),
        },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    for (const spec of [
      { ...original.viewSpec, schemaVersion: 3 },
      { ...original.viewSpec, period: legacy().viewSpec.period },
    ])
      await expect(
        call(
          store,
          create,
          { ...original, viewSpec: spec },
          { ...context, idempotencyKey: uuid(82) },
        ),
      ).rejects.toBeDefined();
    const row = store.views.get(savedId(await call(store, create, original)))!;
    row.view_spec = { ...original.viewSpec, schemaVersion: 3 };
    await expect(
      call(store, open, { viewId: row.view_id }),
    ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
    expect(store.events).toBe(1);
  });
  it('explicitly revokes both versions without changing revoke DTO or allowing hidden-row writes', async () => {
    const store = new Store();
    const created = await call(store, create, topic());
    const id = savedId(created);
    const current = { ...context, idempotencyKey: uuid(81) };
    expect(
      await call(
        store,
        'data.ingestion.candidate.view.revoke',
        { viewId: id },
        current,
      ),
    ).toEqual({ viewId: id, revoked: true });
    await expect(call(store, open, { viewId: id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      await call(
        store,
        'data.ingestion.candidate.view.revoke',
        { viewId: id },
        current,
      ),
    ).toEqual({ viewId: id, revoked: true });
    expect(store.events).toBe(2);
    const old = await call(
      store,
      'data.ingestion.candidate.view.create',
      legacy(),
      { ...context, idempotencyKey: uuid(82) },
    );
    store.anchor = false;
    expect(
      await call(
        store,
        'data.ingestion.candidate.view.revoke',
        { viewId: savedId(old) },
        { ...context, idempotencyKey: uuid(83) },
      ),
    ).toEqual({ viewId: savedId(old), revoked: true });
  });

  it('requires actual nonempty relation authority and rechecks the exact decision version without substituting published versions', async () => {
    const store = new Store();
    const value = topic();
    value.viewSpec.relationPins = [
      { relationId: uuid(91), revision: 1, decisionVersion: 0 },
    ];
    await expect(call(store, create, value)).rejects.toMatchObject({
      code: 'EXECUTION_FAILED',
    });
    let decision = 0;
    const provider: CandidateTopicPinAuthorities = {
      ...authorities(store),
      loadRelations: (_client, _context, pins, references) => {
        expect(references).toEqual(value.references);
        expect(pins).toEqual(value.viewSpec.relationPins);
        return Promise.resolve([
          {
            relationId: uuid(91),
            revision: 1,
            decisionVersion: decision,
            dependencies: [
              {
                reference: reference(),
                assetId: uuid(30),
                sourceHash: 'b'.repeat(64),
              },
            ],
          },
        ]);
      },
    };
    const created = await call(store, create, value, context, provider);
    expect(
      (await call(store, open, { viewId: savedId(created) }, context, provider))
        .status,
    ).toBe('READABLE');
    decision = 1;
    expect(
      await call(store, open, { viewId: savedId(created) }, context, provider),
    ).toEqual({ status: 'UNAVAILABLE', viewId: savedId(created) });
    await expect(
      call(store, create, value, context, provider),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.events).toBe(1);
  });
  it('rechecks source withdrawal after asynchronous host authority work and aborts before insert/commit', async () => {
    const store = new Store();
    const provider: CandidateTopicPinAuthorities = {
      loadRules: async (client, current, selection, pins) => {
        store.blocked.add(reference().processingBatchId);
        return authorities(store).loadRules(client, current, selection, pins);
      },
    };
    await expect(
      call(store, create, topic(), context, provider),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.events).toBe(0);
    expect(store.views.size).toBe(0);
    expect(store.statements.at(-1)).toBe('rollback');
  });
});
