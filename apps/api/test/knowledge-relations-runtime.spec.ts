import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createKnowledgeRelationExecutors } from '../src/data-foundation/knowledge-relations-runtime.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';

function fixture() {
  const item = randomUUID(),
    version = randomUUID(),
    actor = randomUUID();
  const candidate = {
    subject: {
      key: 'enterprise:1',
      label: 'Source enterprise',
      kind: 'ENTERPRISE',
      externalId: null,
    },
    predicate: 'HAS_DECLARED_MONITORING_POINT',
    object: {
      key: 'point:1',
      label: 'Source point',
      kind: 'MONITORING_POINT',
      externalId: null,
    },
    qualifiers: {
      measure: null,
      unit: null,
      observedAt: null,
      spatialScope: null,
      missing: true,
      limitations: [],
      reportedConclusion: null,
    },
    generation: { method: 'SOURCE_TABLE', model: null },
    evidence: [
      {
        assetId: randomUUID(),
        sourceHash: 'a'.repeat(64),
        locator: 'page 1 row 2',
        excerpt: null,
        polarity: 'SUPPORTS',
      },
    ],
    supersedesId: null,
  };
  const context: DataCapabilityExecutionContext = {
    principal: {
      actorId: actor,
      actorType: 'human',
      authenticationMethod: 'supabase_jwt',
      authUserId: actor,
      sessionId: randomUUID(),
    },
    authorization: {
      tenantId: randomUUID(),
      projectId: randomUUID(),
      roles: ['data-steward'],
      scopes: ['data.catalog.read', 'data.ingestion.write', 'data.publish'],
      purpose: 'unit-test',
      maxSecurityLevel: 'L1_INTERNAL',
      authzVersion: 1,
    },
    effectiveMaxSecurityLevel: 'L1_INTERNAL',
    traceId: 'a'.repeat(32),
    auditLevel: 'FULL',
    timeoutMs: 30000,
    signal: new AbortController().signal,
    idempotencyKey: randomUUID(),
  };
  const rows = new Map<string, Record<string, unknown>>();
  const ledger = new Map<unknown, unknown>();
  let visible = true;
  const query = vi.fn(async (sql: string, v: readonly unknown[] = []) => {
    await Promise.resolve();
    if (sql.includes('data.command.idempotency.read'))
      return {
        rows: ledger.has(v[0]) ? [{ payload: ledger.get(v[0]) }] : [],
        rowCount: ledger.has(v[0]) ? 1 : 0,
      };
    if (sql.includes('data.command.outbox.insert'))
      ledger.set(v[6], JSON.parse(String(v[4])));
    if (sql.includes('count(*)::int total'))
      return {
        rows: [
          {
            total: visible
              ? sql.includes('knowledge.assertion_binding')
                ? rows.size
                : 1
              : 0,
          },
        ],
        rowCount: 1,
      };
    if (
      sql.startsWith('select value') ||
      sql.startsWith('select assertion_id,encode')
    )
      return { rows: [], rowCount: 0 };
    if (sql.startsWith('insert into knowledge.assertion('))
      rows.set(String(v[0]), {
        assertion_id: v[0],
        data_item_id: item,
        version_id: version,
        row_version: 1,
        mapping_version: 'v1',
        status: 'PENDING_REVIEW',
        created_at: v[10],
        reviews: [],
      });
    if (sql.startsWith('insert into knowledge.assertion_binding'))
      rows.get(String(v[0]))!['candidate'] = JSON.parse(String(v[8]));
    if (sql.startsWith('insert into knowledge.review_record'))
      (rows.get(String(v[3]))!['reviews'] as unknown[]).push({
        reviewId: v[0],
        reviewerId: v[4],
        decision: v[5],
        rationale: v[6],
        createdAt: v[10],
      });
    if (sql.startsWith('update knowledge.assertion set'))
      Object.assign(rows.get(String(v[0]))!, {
        status: v[1],
        row_version: Number(v[3]) + 1,
      });
    if (sql.startsWith('select b.*')) {
      const selected = sql.includes('where b.assertion_id=any(')
        ? (v[0] as string[]).map((id) => rows.get(id)).filter(Boolean)
        : sql.includes('where b.assertion_id=')
          ? [rows.get(String(v[0]))].filter(Boolean)
          : [...rows.values()];
      return {
        rows: visible ? selected : [],
        rowCount: visible ? selected.length : 0,
      };
    }
    return { rows: [{}], rowCount: 1 };
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(() => Promise.resolve({ query, release })),
    end: vi.fn(async () => {}),
  };
  const executors = createKnowledgeRelationExecutors(pool);
  const call = (name: string, input: unknown, ctx = context) =>
    executors.find((e) => e.id.endsWith(`.${name}`))!.execute(input, ctx);
  return {
    call,
    context,
    rows,
    query,
    release,
    pool,
    candidate,
    input: {
      dataItemId: item,
      versionId: version,
      mappingVersion: 'v1',
      candidates: [candidate],
    },
    withdraw: () => {
      visible = false;
    },
  };
}

it('replays imports and reviews through current authority and hides a withdrawn source', async () => {
  const f = fixture();
  const imported = (await f.call('import', f.input)) as {
    items: { assertionId: string }[];
  };
  const id = imported.items[0]!.assertionId;
  expect(await f.call('import', f.input)).toEqual(imported);
  expect(f.rows.size).toBe(1);
  const review = {
    assertionId: id,
    expectedVersion: 1,
    decision: 'APPROVED',
    rationale: 'Compared source row with the proposed relation.',
  };
  const ctx = { ...f.context, idempotencyKey: randomUUID() };
  const approved = await f.call('review', review, ctx);
  expect(approved).toMatchObject({
    assertion: {
      status: 'APPROVED',
      version: 2,
      confidence: null,
      reviews: [{ rationale: review.rationale }],
    },
  });
  expect(await f.call('review', review, ctx)).toEqual(approved);
  expect(await f.call('get', { assertionId: id })).toEqual(approved);
  expect(
    await f.call('list', {
      dataItemId: f.input.dataItemId,
      versionId: f.input.versionId,
    }),
  ).toMatchObject({ totalCount: 1, items: [{ assertionId: id }] });
  await expect(
    f.call('review', review, { ...ctx, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  f.withdraw();
  await expect(f.call('import', f.input)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(f.call('get', { assertionId: id })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(f.release).toHaveBeenCalledTimes(9);
});

it('looks up a batch of existing relation identities once while preserving reuse, order, and conflicts', async () => {
  const f = fixture();
  const second = {
    ...f.candidate,
    subject: { ...f.candidate.subject, key: 'enterprise:2' },
    object: { ...f.candidate.object, key: 'point:2' },
  };
  const third = {
    ...f.candidate,
    subject: { ...f.candidate.subject, key: 'enterprise:3' },
    object: { ...f.candidate.object, key: 'point:3' },
  };
  const bindings = new Map<
    string,
    { identity_key: string; assertion_id: string; fingerprint: string }
  >();
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values = []) => {
    if (sql.includes('from knowledge.assertion_binding where version_id=')) {
      const identities = Array.isArray(values[2])
        ? (values[2] as string[])
        : [String(values[2])];
      const rows = identities.flatMap((identity) => {
        const row = bindings.get(identity);
        return row ? [row] : [];
      });
      return { rows, rowCount: rows.length };
    }
    const result = await original(sql, values);
    if (sql.startsWith('insert into knowledge.assertion_binding')) {
      const identity = String(values[6]);
      bindings.set(identity, {
        identity_key: identity,
        assertion_id: String(values[0]),
        fingerprint: String(values[7]),
      });
    }
    return result;
  });
  const lookupCalls = () =>
    f.query.mock.calls.filter(([sql]) =>
      sql.includes('from knowledge.assertion_binding where version_id='),
    );
  const batchLoadCalls = () =>
    f.query.mock.calls.filter(
      ([sql]) =>
        sql.startsWith('select b.*') &&
        sql.includes('where b.assertion_id=any('),
    );
  const initial = (await f.call('import', {
    ...f.input,
    candidates: [second, f.candidate],
  })) as {
    items: { assertionId: string; candidate: { subject: { key: string } } }[];
    createdCount: number;
    reusedCount: number;
  };
  expect(initial).toMatchObject({ createdCount: 2, reusedCount: 0 });
  expect(lookupCalls()).toHaveLength(1);
  expect(lookupCalls()[0]![1]?.[2]).toHaveLength(2);
  expect(batchLoadCalls()).toHaveLength(1);
  expect(batchLoadCalls()[0]![1]?.[0]).toHaveLength(2);

  f.query.mockClear();
  const mixed = (await f.call(
    'import',
    { ...f.input, candidates: [third, second, f.candidate] },
    { ...f.context, idempotencyKey: randomUUID() },
  )) as typeof initial;
  expect(mixed).toMatchObject({ createdCount: 1, reusedCount: 2 });
  expect(mixed.items.map((row) => row.candidate.subject.key)).toEqual([
    'enterprise:1',
    'enterprise:2',
    'enterprise:3',
  ]);
  expect(mixed.items.slice(0, 2).map((row) => row.assertionId)).toEqual(
    initial.items.map((row) => row.assertionId),
  );
  expect(lookupCalls()).toHaveLength(1);
  expect(lookupCalls()[0]![1]?.[2]).toHaveLength(3);
  expect(batchLoadCalls()).toHaveLength(1);
  expect(batchLoadCalls()[0]![1]?.[0]).toHaveLength(3);

  f.query.mockClear();
  await expect(
    f.call(
      'import',
      {
        ...f.input,
        candidates: [
          third,
          {
            ...second,
            qualifiers: { ...second.qualifiers, unit: 'mg/L' },
          },
        ],
      },
      { ...f.context, idempotencyKey: randomUUID() },
    ),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(lookupCalls()).toHaveLength(1);
  expect(batchLoadCalls()).toHaveLength(0);
  expect(f.rows.size).toBe(3);
});

it('rejects an import when a batch-loaded assertion is hidden by row scope', async () => {
  const f = fixture();
  const second = {
    ...f.candidate,
    subject: { ...f.candidate.subject, key: 'enterprise:2' },
    object: { ...f.candidate.object, key: 'point:2' },
  };
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    const result = await original(sql, values);
    if (
      sql.startsWith('select b.*') &&
      sql.includes('where b.assertion_id=any(')
    )
      return { rows: result.rows.slice(0, 1), rowCount: 1 };
    return result;
  });
  await expect(
    f.call('import', { ...f.input, candidates: [f.candidate, second] }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(f.query.mock.calls.some(([sql]) => sql === 'rollback')).toBe(true);
});

it('rolls back reads on cancellation or persistence failure without exposing database errors', async () => {
  const f = fixture();
  await f.call('import', f.input);
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.call(
      'list',
      { dataItemId: f.input.dataItemId, versionId: f.input.versionId },
      { ...f.context, signal: abort.signal },
    ),
  ).rejects.toMatchObject({ code: 'CAPABILITY_TIMEOUT' });
  f.query.mockRejectedValueOnce(Error('private server address'));
  await expect(
    f.call('get', { assertionId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
  expect(f.query.mock.calls.filter(([sql]) => sql === 'rollback')).toHaveLength(
    2,
  );
  expect(f.release).toHaveBeenCalledTimes(3);
});

it('rejects automatic review, conflicting identities and oversized evidence before connecting', async () => {
  const f = fixture();
  await expect(
    f.call(
      'review',
      {},
      {
        ...f.context,
        principal: { ...f.context.principal, actorType: 'agent' },
      },
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    f.call('import', {
      ...f.input,
      candidates: [
        f.candidate,
        {
          ...f.candidate,
          subject: { ...f.candidate.subject, label: 'Conflicting name' },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const evidence = Array.from({ length: 30 }, (_, n) => ({
    ...f.candidate.evidence[0],
    locator: `row ${n}`,
    excerpt: 'x'.repeat(4000),
  }));
  await expect(
    f.call('import', {
      ...f.input,
      candidates: [{ ...f.candidate, evidence }],
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(f.pool.connect).not.toHaveBeenCalled();
});

it('does not admit an identity link whose source entities do not exist', async () => {
  const f = fixture();
  const reference = (versionId: string) => ({
    dataItemId: f.input.dataItemId,
    versionId,
    mappingVersion: 'v1',
    entityKey: 'person:one',
  });
  const candidate = {
    ...f.candidate,
    predicate: 'IDENTITY_MATCH',
    subject: {
      key: 'a',
      kind: 'PERSON',
      label: 'Same name',
      externalId: null,
      reference: reference(f.input.versionId),
    },
    object: {
      key: 'b',
      kind: 'PERSON',
      label: 'Same name',
      externalId: null,
      reference: reference(randomUUID()),
    },
    qualifiers: {
      ...f.candidate.qualifiers,
      context: {
        recordNature: 'SOURCE_RELATION',
        timeRole: 'UNKNOWN',
        validFrom: null,
        validTo: null,
        locationRole: 'UNKNOWN',
        applicability: 'Identity candidate only',
      },
    },
  };
  await expect(
    f.call('import', { ...f.input, candidates: [candidate] }),
  ).rejects.toThrow();
  expect(f.rows.size).toBe(0);
});

it('authorizes every selected source in a 64-source case and stops before listing on denial', async () => {
  const f = fixture();
  const sources = Array.from({ length: 64 }, () => ({
    dataItemId: randomUUID(),
    versionId: randomUUID(),
  }));
  const first = sources[0]!;
  const input = {
    ...first,
    relatedSources: sources.slice(1),
    status: 'PENDING_REVIEW',
  };
  await f.call('list', input);
  const auth = f.query.mock.calls.filter(([sql]) =>
    sql.includes('select count(*)::int total from authorized'),
  );
  expect(
    auth.map(([, v]) => {
      const r = (
        JSON.parse(String(v?.[0])) as {
          dataItemId: string;
          versionId: string;
        }[]
      )[0]!;
      return { dataItemId: r.dataItemId, versionId: r.versionId };
    }),
  ).toEqual(sources);
  f.query.mockClear();
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values = []) => {
    if (
      sql.includes('select count(*)::int total from authorized') &&
      (JSON.parse(String(values[0])) as { versionId: string }[])[0]!
        .versionId === sources[63]!.versionId
    )
      return { rows: [{ total: 0 }], rowCount: 1 };
    return original(sql, values);
  });
  await expect(f.call('list', input)).rejects.toThrow();
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.includes('total from knowledge.assertion_binding'),
    ),
  ).toBe(false);
});

it('uses all 149 persisted sources, and refuses a partially unauthorized scope', async () => {
  const f = fixture();
  const sources = Array.from({ length: 149 }, () => ({
    dataItemId: randomUUID(),
    versionId: randomUUID(),
  }));
  const queryId = randomUUID();
  let allowed = true;
  f.query.mockImplementation(
    async (sql: string, v: readonly unknown[] = []) => {
      await Promise.resolve();
      if (sql.includes('from service.exploration_snapshot'))
        return { rows: [{ version_refs: sources }], rowCount: 1 };
      if (sql.includes('from authorized'))
        return {
          rows: [{ total: allowed ? sources.length : sources.length - 1 }],
          rowCount: 1,
        };
      if (sql.includes('count(*)::int total')) {
        expect(JSON.parse(String(v[0]))).toEqual(sources);
        return { rows: [{ total: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  );
  expect(await f.call('list', { queryId })).toMatchObject({
    totalCount: 0,
    items: [],
  });
  allowed = false;
  await expect(f.call('list', { queryId })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it('does not treat an absent or expired snapshot as an empty successful graph', async () => {
  const f = fixture();
  f.query.mockResolvedValue({ rows: [], rowCount: 0 });
  await expect(f.call('list', { queryId: randomUUID() })).rejects.toMatchObject(
    { code: 'NOT_FOUND' },
  );
});

it('refuses review 101 when RLS hides previous review records', async () => {
  const f = fixture();
  const result = (await f.call('import', f.input)) as {
    items: { assertionId: string }[];
  };
  const id = result.items[0]!.assertionId;
  f.rows.get(id)!['row_version'] = 101;
  f.rows.get(id)!['reviews'] = [];
  await expect(
    f.call(
      'review',
      {
        assertionId: id,
        expectedVersion: 101,
        decision: 'APPROVED',
        rationale: 'Check hidden review history',
      },
      { ...f.context, idempotencyKey: randomUUID() },
    ),
  ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
});

it('bounds project pages after complete scope checks and rechecks withdrawal between pages', async () => {
  const f = fixture();
  await f.call('import', f.input);
  const template = [...f.rows.values()][0]!;
  f.rows.clear();
  for (let index = 0; index < 503; index++) {
    const id = `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
    f.rows.set(id, { ...template, assertion_id: id });
  }
  const original = f.query.getMockImplementation()!;
  const queryId = randomUUID();
  let scope: 'project' | undefined = 'project';
  const refs = [
    { dataItemId: f.input.dataItemId, versionId: f.input.versionId },
  ];
  const business = {
    schemaVersion: 1,
    status: 'PENDING_REVIEW',
    revisionMode: 'all',
    filters: {
      kind: 'ALL',
      timeRole: 'ALL',
      from: null,
      to: null,
      includeUndated: true,
    },
  };
  const pins = [...f.rows.keys()].map((id) => [id, 1]);
  f.query.mockImplementation(async (sql, values) => {
    if (sql.includes('from service.exploration_snapshot'))
      return {
        rows: [
          {
            version_refs: refs,
            spec: scope
              ? { scope, businessQuery: business }
              : {
                  versions: [
                    {
                      dataItemId: f.input.dataItemId,
                      versionId: f.input.versionId,
                    },
                  ],
                  businessQuery: business,
                },
            business_pins: pins,
          },
        ],
        rowCount: 1,
      };
    if (
      sql.includes('from knowledge.assertion_binding b') &&
      sql.includes('jsonb_array_elements($1::jsonb) ref')
    ) {
      const boundValues = values ?? [];
      expect(sql).toContain('jsonb_array_elements($3::jsonb) pin');
      expect(JSON.parse(String(boundValues[0]))).toEqual(refs);
      expect(boundValues[1]).toEqual(['PENDING_REVIEW']);
      expect(JSON.parse(String(boundValues[2]))).toEqual(pins);
      expect(boundValues[3]).toBe(100001);
      return { rows: [...f.rows.values()], rowCount: f.rows.size };
    }
    return original(sql, values);
  });
  const request = {
    queryId,
    status: 'PENDING_REVIEW',
    pageMode: 'BOUNDED_PROJECT',
    first: 500,
  };
  const page = (await f.call('list', request)) as {
    items: { assertionId: string }[];
    nextCursor: string;
  };
  expect(page.items).toHaveLength(500);
  expect(page.nextCursor).toBe(page.items.at(-1)!.assertionId);
  expect(
    await f.call('list', { ...request, after: page.nextCursor }),
  ).toMatchObject({
    totalCount: 503,
    items: [
      { assertionId: [...f.rows.keys()][500] },
      { assertionId: [...f.rows.keys()][501] },
      { assertionId: [...f.rows.keys()][502] },
    ],
  });
  await expect(
    f.call('list', { ...request, after: randomUUID() }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  scope = undefined;
  await expect(f.call('list', request)).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
  });
  scope = 'project';
  f.rows.values().next().value!['row_version'] = 2;
  await expect(
    f.call('list', { ...request, after: page.nextCursor }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  f.rows.values().next().value!['row_version'] = 1;
  f.withdraw();
  await expect(
    f.call('list', { ...request, after: page.nextCursor }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
