import { describe, expect, it } from 'vitest';
import {
  DATA_CAPABILITY_REGISTRY,
  type DataCapabilityId,
} from '@wiser/data-contracts';
import * as savedExecutors from '../src/data-foundation/exploration-saved.js';
import type {
  DataCapabilityExecutor,
  DataCapabilityExecutionContext,
} from '../src/data-foundation/capability-handler.js';
import {
  ownsPendingSubmission,
  canReadPendingSubmission,
} from '../src/data-foundation/managed-ingestion-access.js';
import { candidateReadAuthority } from '../src/data-foundation/candidate-read-authority.js';
import { createPostgresDataReadRuntime } from '../src/data-foundation/postgres-read-executors.js';

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
const input = () => ({
  title: '固定待审资料',
  visibility: 'private',
  references: [reference()],
  viewSpec: {
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
  events = 0;
  connect() {
    let snapshot:
      | { views: Map<string, Row>; ledger: Map<string, Row>; events: number }
      | undefined;
    return Promise.resolve({
      query: (sql: string, values: readonly unknown[] = []) =>
        Promise.resolve().then(() => {
          this.statements.push(sql);
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
          if (sql.includes('candidate.saved.get'))
            return {
              rows: this.views.has(String(values[0]))
                ? [this.views.get(String(values[0]))!]
                : [],
            };
          if (sql.includes('candidate.saved.list')) {
            const visible = [...this.views.values()].filter(
              (r) =>
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
      release() {},
    });
  }
}
function executors(store: Store): readonly DataCapabilityExecutor[] {
  const factory = Reflect.get(
    savedExecutors,
    'createIngestionCandidateSavedExecutors',
  ) as ((pool: unknown) => readonly DataCapabilityExecutor[]) | undefined;
  expect(factory, 'missing durable candidate-save factory').toBeTypeOf(
    'function',
  );
  return factory!(store);
}
async function call(
  store: Store,
  name: string,
  value: unknown,
  actor = context,
) {
  store.current = actor;
  const executor = executors(store).find(
    (e) => e.id === `data.ingestion.candidate.view.${name}`,
  );
  expect(executor, `missing candidate view ${name}`).toBeDefined();
  return executor!.execute(value, actor) as Promise<Row>;
}
const savedId = (value: Row) => (value.savedView as Row).viewId as string;
const capability = (name: string) => {
  const result =
    DATA_CAPABILITY_REGISTRY[
      `data.ingestion.candidate.view.${name}` as DataCapabilityId
    ];
  expect(result, 'missing candidate-save registry contract').toBeDefined();
  return result;
};
const agentContext = (): DataCapabilityExecutionContext => ({
  ...context,
  principal: {
    actorId: uuid(50),
    actorType: 'agent',
    authenticationMethod: 'delegated_credential',
    credentialId: uuid(51),
    delegationId: uuid(52),
    delegatedBy: uuid(10),
  },
});

describe('durable fixed pending candidate views', () => {
  it('registers four distinct contracts without weakening published saved views', () => {
    for (const name of ['create', 'list', 'open', 'revoke'])
      expect(capability(name).version).toBe('1.0.0');
    expect(
      DATA_CAPABILITY_REGISTRY[
        'data.explore.view.create'
      ].inputSchema.safeParse(input()).success,
    ).toBe(false);
    expect(capability('create').inputSchema.safeParse(input()).success).toBe(
      true,
    );
  });
  it('persists eight exact references and resumes the same fixed asset/record after a new executor', async () => {
    const store = new Store(),
      value = input();
    value.references = Array.from({ length: 8 }, (_, n) => reference(n + 1));
    const created = await call(store, 'create', value);
    expect(store.views.size).toBe(1);
    const opened = await call(store, 'open', { viewId: savedId(created) });
    expect(opened).toMatchObject({
      kind: 'ingestion-candidate-view',
      references: value.references,
      viewSpec: value.viewSpec,
      request: {
        capabilityId: 'data.ingestion.candidate.records',
        input: { ...reference(), assetId: uuid(30), first: 2 },
      },
    });
    const body = (opened.request as Row).input as Row;
    expect(body.after).toEqual(expect.any(String));
    expect(opened).not.toHaveProperty('queryId');
    expect(opened).not.toHaveProperty('versionId');
    expect(store.views.values().next().value?.view_spec).not.toHaveProperty(
      'after',
    );
  });
  it('replays create once and revokes without altering raw candidates or saved configuration', async () => {
    const store = new Store(),
      created = await call(store, 'create', input());
    expect(await call(store, 'create', input())).toEqual(created);
    expect(store.views.size).toBe(1);
    expect(store.events).toBe(1);
    const revokeContext = { ...context, idempotencyKey: uuid(81) };
    expect(
      await call(store, 'revoke', { viewId: savedId(created) }, revokeContext),
    ).toMatchObject({ revoked: true });
    expect(
      await call(store, 'revoke', { viewId: savedId(created) }, revokeContext),
    ).toMatchObject({ revoked: true });
    await expect(
      call(store, 'open', { viewId: savedId(created) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await call(store, 'list', {})).items).toEqual([]);
    expect(store.views.values().next().value?.candidate_refs).toEqual(
      input().references,
    );
  });
  it('does not record a successful revoke when current RLS permits no write', async () => {
    const store = new Store(),
      created = await call(store, 'create', input());
    store.denyRevoke = true;
    await expect(
      call(
        store,
        'revoke',
        { viewId: savedId(created) },
        {
          ...context,
          idempotencyKey: uuid(81),
        },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.events).toBe(1);
    expect(store.ledger.size).toBe(1);
    expect(store.views.get(savedId(created))?.revoked_at).toBeNull();
  });
  it('lists only bounded current entries and rejects a cursor from another permission fingerprint', async () => {
    const store = new Store();
    for (let n = 0; n < 3; n++)
      await call(
        store,
        'create',
        {
          ...input(),
          title: `资料清单 ${n}`,
        },
        { ...context, idempotencyKey: uuid(90 + n) },
      );
    const first = await call(store, 'list', { first: 1 });
    expect(first.items).toHaveLength(1);
    expect(first).not.toHaveProperty('total');
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await call(store, 'list', {
      first: 1,
      after: first.nextCursor,
    });
    const third = await call(store, 'list', {
      first: 1,
      after: second.nextCursor,
    });
    expect(
      new Set(
        [first, second, third].flatMap((v) =>
          (v.items as Row[]).map((item) => item.viewId),
        ),
      ).size,
    ).toBe(3);
    expect(third.nextCursor).toBeNull();
    await expect(
      call(
        store,
        'list',
        { first: 1, after: first.nextCursor },
        {
          ...context,
          authorization: {
            ...context.authorization,
            resourceAccess: {
              ...context.authorization.resourceAccess!,
              fingerprint: 'e'.repeat(64),
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it.each(['assets', 'records', 'geometry'] as const)(
    'reopens %s using the original bounded candidate reader and a current authority cursor',
    async (kind) => {
      const store = new Store();
      const value = {
        ...input(),
        viewSpec: {
          page:
            kind === 'assets'
              ? {
                  kind,
                  reference: reference(),
                  first: 2,
                  afterAssetId: uuid(30),
                }
              : {
                  kind,
                  reference: reference(),
                  first: 2,
                  assetId: uuid(30),
                  afterRecordId: uuid(32),
                },
        },
      };
      const created = await call(store, 'create', value);
      const opened = await call(store, 'open', { viewId: savedId(created) });
      const asset = {
        asset_id: uuid(30),
        source_hash: 'b'.repeat(64),
        status: 'READY',
        reason: null,
        record_count: '3',
        feature_count: '2',
        columns: [{ key: 'raw', label: '原值' }],
        ordinal: 2,
      };
      const runtime = createPostgresDataReadRuntime({
        connect: () =>
          Promise.resolve({
            query: (sql: string, values: readonly unknown[] = []) => {
              if (sql.includes('data.ingestion.candidate.batch'))
                return Promise.resolve({
                  rows: [
                    {
                      processing_batch_id: reference().processingBatchId,
                      ingestion_id: reference().ingestionId,
                      review_hash: reference().reviewHash,
                      parser_version: '1.0.0',
                      status: 'READY',
                      created_at: '2026-10-03T10:00:00Z',
                      total_asset_count: '2',
                      known_record_count: '3',
                      known_feature_count: '2',
                      unknown_asset_count: '0',
                    },
                  ],
                });
              if (sql.includes('data.ingestion.candidate.assets'))
                return Promise.resolve({ rows: [asset] });
              if (sql.includes('data.ingestion.candidate.asset'))
                return Promise.resolve({ rows: [asset] });
              if (
                sql.includes('data.ingestion.candidate.records') ||
                sql.includes('data.ingestion.candidate.geometry')
              ) {
                expect(values[2]).toBe(1);
                return Promise.resolve({
                  rows: [2, 3].map((index) => ({
                    record_id: uuid(31 + index),
                    asset_id: uuid(30),
                    record_index: index,
                    source_id: `table:1/row:${index}`,
                    record_values: { raw: index === 2 ? 0 : null },
                    has_geometry: true,
                    source_crs: 'EPSG:4326',
                    geometry: {
                      type: 'LineString',
                      coordinates: [
                        [116, 39],
                        [117, 40],
                      ],
                    },
                    has_more: false,
                  })),
                });
              }
              return Promise.resolve({ rows: [] });
            },
            release() {},
          }),
        end: () => Promise.resolve(),
      });
      const request = opened.request as {
        capabilityId: DataCapabilityId;
        input: Row;
      };
      const executor = runtime.executors.find(
        (entry) => entry.id === request.capabilityId,
      )!;
      const result = await executor.execute(request.input, context);
      expect(result).toMatchObject({ reference: reference() });
      if (kind === 'records')
        expect(result).toMatchObject({
          records: [
            { recordId: uuid(33), index: 2, values: { raw: 0 } },
            { recordId: uuid(34), index: 3, values: { raw: null } },
          ],
        });
      if (kind === 'geometry')
        expect(result).toMatchObject({
          features: [
            {
              index: 2,
              geometry: {
                type: 'LineString',
                coordinates: [
                  [116, 39],
                  [117, 40],
                ],
              },
            },
            {
              index: 3,
              geometry: {
                type: 'LineString',
                coordinates: [
                  [116, 39],
                  [117, 40],
                ],
              },
            },
          ],
        });
      const changed = {
        ...context,
        authorization: {
          ...context.authorization,
          resourceAccess: {
            ...context.authorization.resourceAccess!,
            fingerprint: 'e'.repeat(64),
          },
        },
      };
      await expect(
        executor.execute(request.input, changed),
      ).rejects.toMatchObject({ code: 'INVALID_DATA_CURSOR' });
      const rebound = await call(
        store,
        'open',
        { viewId: savedId(created) },
        changed,
      );
      expect((rebound.request as Row).input).not.toEqual(request.input);
      await expect(
        executor.execute((rebound.request as { input: Row }).input, changed),
      ).resolves.toMatchObject({ reference: reference() });
      await runtime.close();
    },
  );
  it('does not silently omit an unreadable fixed member or resolve a newer batch', async () => {
    const store = new Store(),
      value = input();
    value.references = [reference(), reference(2)];
    store.blocked.add(reference(2).processingBatchId);
    await expect(call(store, 'create', value)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(store.views.size).toBe(0);
    expect(store.events).toBe(0);
    store.blocked.clear();
    const created = await call(store, 'create', value);
    store.blocked.add(reference(2).processingBatchId);
    await expect(
      call(store, 'open', { viewId: savedId(created) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(store, 'create', value)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await call(store, 'list', {})).items).toEqual([]);
    expect(store.views.values().next().value?.candidate_refs).toEqual(
      value.references,
    );
  });
  it.each(['actor', 'purpose', 'project'])(
    'does not disclose a private title when %s changes',
    async (kind) => {
      const store = new Store(),
        created = await call(store, 'create', input());
      const actor = {
        ...context,
        principal: { ...context.principal },
        authorization: { ...context.authorization },
      };
      if (kind === 'actor')
        actor.principal = {
          ...actor.principal,
          actorId: uuid(70),
          authUserId: uuid(70),
        };
      if (kind === 'purpose')
        actor.authorization = { ...actor.authorization, purpose: 'research' };
      if (kind === 'project')
        actor.authorization = { ...actor.authorization, projectId: uuid(70) };
      await expect(
        call(store, 'open', { viewId: savedId(created) }, actor),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    },
  );
  it.each(['scope', 'principal', 'permission'])(
    'rejects current %s withdrawal before cached create/open',
    async (kind) => {
      const store = new Store(),
        created = await call(store, 'create', input());
      const actor = {
        ...context,
        principal: { ...context.principal },
        authorization: { ...context.authorization },
      };
      if (kind === 'scope')
        actor.authorization.resourceAccess = {
          ...context.authorization.resourceAccess!,
          scope: {
            ...context.authorization.resourceAccess!.scope,
            mode: 'managed',
            validUntil: '2000-01-01T00:00:00Z',
          },
        } as typeof context.authorization.resourceAccess;
      if (kind === 'principal')
        actor.principal = {
          ...actor.principal,
          expiresAt: '2000-01-01T00:00:00Z',
        };
      if (kind === 'permission')
        actor.authorization = {
          ...actor.authorization,
          scopes: ['data.operation.read'],
        };
      await expect(call(store, 'create', input(), actor)).rejects.toMatchObject(
        { code: 'FORBIDDEN' },
      );
      await expect(
        call(store, 'open', { viewId: savedId(created) }, actor),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
  );
  it('excludes self-review and unknown legacy responsibility', async () => {
    const reviewer = {
      ...context,
      authorization: {
        ...context.authorization,
        scopes: ['data.operation.read', 'data.publish'],
      },
    };
    await expect(
      call(new Store(), 'create', input(), reviewer),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const unknown = new Store();
    unknown.submission = {};
    await expect(call(unknown, 'create', input())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('keeps creator/delegator ownership independent from review role and current candidate access', async () => {
    const store = new Store(),
      agent = agentContext();
    store.submission = {
      actorId: uuid(50),
      actorType: 'agent',
      delegatedBy: uuid(10),
    };
    const created = await call(store, 'create', input(), agent);
    expect(
      await call(store, 'open', { viewId: savedId(created) }, context),
    ).toMatchObject({ references: input().references });
    await expect(
      call(
        store,
        'open',
        { viewId: savedId(created) },
        { ...agent, principal: { ...agent.principal, delegatedBy: uuid(60) } },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call(store, 'create', input(), {
        ...agent,
        principal: { ...agent.principal, delegatedBy: uuid(60) },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('allows explicit project sharing to an independent human without granting another maintainer access', async () => {
    const store = new Store(),
      value = input();
    value.visibility = 'project';
    const created = await call(store, 'create', value);
    const other = {
      ...context,
      principal: {
        ...context.principal,
        actorId: uuid(70),
        authUserId: uuid(70),
      },
    };
    await expect(
      call(store, 'open', { viewId: savedId(created) }, other),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const reviewer = {
      ...other,
      authorization: {
        ...other.authorization,
        scopes: ['data.operation.read', 'data.publish'],
      },
    };
    expect(
      await call(store, 'open', { viewId: savedId(created) }, reviewer),
    ).toMatchObject({ references: value.references });
    await expect(
      call(
        store,
        'revoke',
        { viewId: savedId(created) },
        { ...reviewer, idempotencyKey: uuid(85) },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects foreign or missing page/focus anchors instead of trusting a client row number', async () => {
    const store = new Store();
    store.anchor = false;
    await expect(call(store, 'create', input())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(store.events).toBe(0);
    expect(
      capability('create').inputSchema.safeParse({
        ...input(),
        viewSpec: {
          page: { ...input().viewSpec.page, after: 'opaque-old-cursor' },
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    'duplicate',
    'too-many',
    'large-title',
    'bad-first',
    'out-of-manifest',
    'injected-authority',
    'raw-pack',
  ])('rejects typed %s input', (kind) => {
    const value: Row = structuredClone(input());
    if (kind === 'duplicate') value.references = [reference(), reference()];
    if (kind === 'too-many')
      value.references = Array.from({ length: 101 }, (_, n) =>
        reference(n + 1),
      );
    if (kind === 'large-title') value.title = 'x'.repeat(161);
    if (kind === 'bad-first')
      value.viewSpec = { page: { ...input().viewSpec.page, first: 201 } };
    if (kind === 'out-of-manifest')
      value.viewSpec = {
        page: { ...input().viewSpec.page, reference: reference(2) },
      };
    if (kind === 'injected-authority') value.actorId = uuid(70);
    if (kind === 'raw-pack')
      value.viewSpec = { records: [{ raw: 3 }], page: input().viewSpec.page };
    expect(capability('create').inputSchema.safeParse(value).success).toBe(
      false,
    );
  });
});
