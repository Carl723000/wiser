import { describe, expect, it } from 'vitest';
import { setCandidateReadAuthority } from '../src/data-foundation/candidate-read-authority.js';
import {
  DATA_CAPABILITY_REGISTRY,
  DATA_CAPABILITY_IDS,
} from '@wiser/data-contracts';
import {
  createPostgresDataReadRuntime,
  type PostgresDataReadClient,
} from '../src/data-foundation/postgres-read-executors.js';
import { DataCapabilityHandler } from '../src/data-foundation/capability-handler.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const alphaId = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id(1),
  reviewHash: 'a'.repeat(64),
  processingBatchId: id(2),
};
const context: DataCapabilityExecutionContext = {
  principal: {
    actorId: id(8),
    actorType: 'human',
    authenticationMethod: 'supabase_jwt',
    authUserId: id(8),
    sessionId: id(9),
  },
  authorization: {
    tenantId: id(10),
    projectId: id(11),
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write'],
    purpose: 'candidate-review',
    maxSecurityLevel: 'L0_PUBLIC',
    authzVersion: 1,
  },
  effectiveMaxSecurityLevel: 'L0_PUBLIC',
  traceId: 'a'.repeat(32),
  auditLevel: 'STANDARD',
  timeoutMs: 30_000,
  signal: new AbortController().signal,
};
const asset = {
  asset_id: id(3),
  source_hash: 'b'.repeat(64),
  status: 'READY',
  reason: null,
  record_count: '3',
  feature_count: '1',
  columns: [{ key: 'raw', label: '原值' }],
};
const rows = [null, 0, ''].map((raw, i) => ({
  record_id: id(20 + i),
  asset_id: id(3),
  record_index: String(i + 1),
  source_id: `table:1/row:${i + 1}`,
  record_values: { raw },
  has_geometry: i === 1,
}));

class Client implements PostgresDataReadClient {
  queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  visible = true;
  released = false;
  failRows = false;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    this.queries.push(values === undefined ? { text } : { text, values });
    if (text.includes('data.ingestion.candidate.batch'))
      return Promise.resolve({
        rows: this.visible
          ? [
              {
                processing_batch_id: id(2),
                ingestion_id: id(1),
                review_hash: 'a'.repeat(64),
                parser_version: '1.0.0',
                status: 'READY',
                created_at: '2026-10-03T10:00:00Z',
                total_asset_count: '1',
                known_record_count: '3',
                known_feature_count: '1',
                unknown_asset_count: '0',
              },
            ]
          : [],
      });
    if (text.includes('data.ingestion.candidate.assets'))
      return Promise.resolve({ rows: [asset] });
    if (text.includes('data.ingestion.candidate.asset'))
      return Promise.resolve({ rows: this.visible ? [asset] : [] });
    if (text.includes('data.ingestion.candidate.records')) {
      if (this.failRows)
        return Promise.reject(new Error('private database diagnostic'));
      return Promise.resolve({
        rows: rows
          .filter((row) => Number(row.record_index) > Number(values?.[2] ?? 0))
          .slice(0, Number(values?.[3])),
      });
    }
    if (text.includes('data.ingestion.candidate.geometry'))
      return Promise.resolve({
        rows: [
          {
            ...rows[1],
            source_crs: 'EPSG:4326',
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
    return Promise.resolve({ rows: [] });
  }
  release() {
    this.released = true;
  }
}
function runtime(client: Client) {
  return createPostgresDataReadRuntime({
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  });
}
async function read(
  client: Client,
  name: 'get' | 'records' | 'geometry',
  input: unknown,
  auth: DataCapabilityExecutionContext = context,
) {
  const executor = runtime(client).executors.find(
    (item) => item.id === `data.ingestion.candidate.${name}`,
  );
  expect(executor, `missing candidate ${name} executor`).toBeDefined();
  return executor!.execute(input, auth);
}

describe('pending candidate standard read executors', () => {
  it('passes only canonical trusted actor and delegator UUIDs to candidate RLS', async () => {
    const client = new Client();
    const agent = {
      ...context,
      principal: {
        actorId: alphaId(8).toUpperCase(),
        actorType: 'agent' as const,
        authenticationMethod: 'delegated_credential' as const,
        credentialId: id(9),
        delegationId: id(10),
        delegatedBy: alphaId(7).toUpperCase(),
      },
    };
    await expect(read(client, 'get', reference, agent)).resolves.toBeDefined();
    expect(
      client.queries
        .find((query) => query.text.includes('data.ingestion.candidate.scope'))
        ?.values?.slice(0, 3),
    ).toEqual([alphaId(8), 'agent', alphaId(7)]);
  });
  it('admits managed candidate maintenance while preserving source permissions and current authority checks', async () => {
    const client = new Client();
    const candidateExecutors = runtime(client).executors;
    const managed = {
      principal: context.principal,
      authorization: {
        ...context.authorization,
        resourceAccess: {
          revision: 1,
          fingerprint: 'f'.repeat(64),
          scope: {
            mode: 'managed' as const,
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
      traceId: context.traceId,
    };
    const audit: { decision: string }[] = [];
    const handler = new DataCapabilityHandler({
      executors: DATA_CAPABILITY_IDS.map(
        (id) =>
          candidateExecutors.find((e) => e.id === id) ?? {
            id,
            execute: () => Promise.resolve(undefined),
          },
      ),
      audit: {
        record: (record) => {
          audit.push(record);
          return Promise.resolve();
        },
      },
    });
    expect(
      await handler.execute({
        capabilityId: 'data.ingestion.candidate.get',
        input: reference,
        requestContext: managed,
      }),
    ).toMatchObject({ reference });
    expect(audit).toMatchObject([{ decision: 'SUCCEEDED' }]);
    expect(
      client.queries.some((q) => q.text.includes('wiser.resource_scope')),
    ).toBe(true);
    const withdrawn = {
      ...managed,
      authorization: {
        ...managed.authorization,
        scopes: ['data.operation.read'],
      },
    };
    await expect(
      handler.execute({
        capabilityId: 'data.ingestion.candidate.get',
        input: reference,
        requestContext: withdrawn,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    client.visible = false;
    await expect(
      handler.execute({
        capabilityId: 'data.ingestion.candidate.get',
        input: reference,
        requestContext: managed,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      managed.authorization.resourceAccess.scope.permissions['content.read'],
    ).toEqual([]);
  });

  it('reads bounded whole-batch outcomes without keys, credentials or published identity', async () => {
    const client = new Client();
    const result = await read(client, 'get', reference);
    expect(result).toMatchObject({
      reference,
      totalAssetCount: 1,
      knownRecordCount: 3,
      knownFeatureCount: 1,
      unknownAssetCount: 0,
      assets: [{ assetId: id(3), sourceHash: 'b'.repeat(64) }],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /storage_key|versionId|credential|password/,
    );
    expect(
      client.queries.find((q) =>
        q.text.includes('data.ingestion.candidate.scope'),
      )?.values,
    ).toEqual([
      id(8),
      'human',
      '',
      true,
      false,
      'candidate-review',
      JSON.stringify([reference]),
    ]);
    expect(client.queries.some((q) => q.text === 'COMMIT')).toBe(true);
    expect(client.released).toBe(true);
  });

  it('preserves null, zero and empty string while advancing by actually returned records', async () => {
    const client = new Client();
    const result = (await read(client, 'records', {
      ...reference,
      assetId: id(3),
      first: 2,
    })) as {
      records: Array<{ index: number; values: { raw: unknown } }>;
      nextCursor: string;
    };
    expect(result.records.map((r) => r.values.raw)).toEqual([null, 0]);
    expect(result.nextCursor).toEqual(expect.any(String));
    const continuation = await read(new Client(), 'records', {
      ...reference,
      assetId: id(3),
      first: 2,
      after: result.nextCursor,
    });
    expect(continuation).toMatchObject({
      records: [{ index: 3, values: { raw: '' } }],
      nextCursor: null,
    });
    for (const changed of [
      { assetId: id(4) },
      { processingBatchId: id(4) },
      { reviewHash: 'c'.repeat(64) },
    ]) {
      await expect(
        read(new Client(), 'records', {
          ...reference,
          assetId: id(3),
          after: result.nextCursor,
          ...changed,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_DATA_CURSOR' });
    }
    for (const auth of [
      { ...context, principal: { ...context.principal, actorId: id(7) } },
      {
        ...context,
        authorization: { ...context.authorization, purpose: 'other-purpose' },
      },
    ])
      await expect(
        read(
          new Client(),
          'records',
          { ...reference, assetId: id(3), after: result.nextCursor },
          auth,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_DATA_CURSOR' });
  });

  it('bounds large pages by complete rows and never truncates values or skips records', async () => {
    const client = new Client();
    client.query = (sql, values) => {
      client.queries.push(
        values === undefined ? { text: sql } : { text: sql, values },
      );
      if (sql.includes('data.ingestion.candidate.records'))
        return Promise.resolve({
          rows: Array.from({ length: 21 }, (_, i) => ({
            ...rows[0],
            record_id: id(100 + i),
            record_index: String(i + 1),
            record_values: { raw: '文'.repeat(80_000) },
          })),
        });
      if (sql.includes('data.ingestion.candidate.asset'))
        return Promise.resolve({ rows: [asset] });
      if (sql.includes('data.ingestion.candidate.batch'))
        return Promise.resolve({
          rows: [
            {
              processing_batch_id: id(2),
              ingestion_id: id(1),
              review_hash: 'a'.repeat(64),
              parser_version: '1.0.0',
              status: 'READY',
              created_at: '2026-10-03T10:00:00Z',
              total_asset_count: '1',
              known_record_count: '21',
              known_feature_count: '0',
              unknown_asset_count: '0',
            },
          ],
        });
      return Promise.resolve({ rows: [] });
    };
    const result = (await read(client, 'records', {
      ...reference,
      assetId: id(3),
      first: 20,
    })) as {
      records: Array<{ index: number; values: { raw: string } }>;
      nextCursor: string;
    };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      3 * 1024 * 1024,
    );
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.length).toBeLessThan(20);
    expect(result.records.at(-1)?.values.raw).toBe('文'.repeat(80_000));
    const cursor: unknown = JSON.parse(
      Buffer.from(result.nextCursor, 'base64url').toString(),
    );
    expect(cursor).toMatchObject({ position: [result.records.at(-1)?.index] });
  });

  it('keeps lines as lines with source locator and a fixed candidate reference', async () => {
    const result = await read(new Client(), 'geometry', {
      ...reference,
      assetId: id(3),
    });
    expect(result).toMatchObject({
      reference,
      crs: 'EPSG:4326',
      features: [
        {
          index: 2,
          sourceId: 'table:1/row:2',
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
  });

  it('fails closed on current authority withdrawal and rolls back sanitized database failures', async () => {
    const hidden = new Client();
    hidden.visible = false;
    await expect(read(hidden, 'get', reference)).rejects.toMatchObject({
      code: 'DATA_RESOURCE_NOT_FOUND',
    });
    const reader = {
      ...context,
      authorization: {
        ...context.authorization,
        scopes: ['data.operation.read'],
      },
    };
    await expect(
      read(new Client(), 'records', { ...reference, assetId: id(3) }, reader),
    ).rejects.toMatchObject({ code: 'CANDIDATE_READ_FORBIDDEN' });
    const broken = new Client();
    broken.failRows = true;
    await expect(
      read(broken, 'records', { ...reference, assetId: id(3) }),
    ).rejects.toMatchObject({
      code: 'DATA_READ_FAILED',
      message: 'The data authority read failed.',
    });
    expect(broken.queries.some((q) => q.text === 'ROLLBACK')).toBe(true);
    expect(broken.released).toBe(true);
  });

  it('publishes strict read contracts that reject aliases before authority access', () => {
    const registry = DATA_CAPABILITY_REGISTRY as Record<
      string,
      { inputSchema: { safeParse(input: unknown): { success: boolean } } }
    >;
    const definition = registry['data.ingestion.candidate.records'];
    expect(definition).toBeDefined();
    expect(
      definition!.inputSchema.safeParse({
        ...reference,
        assetId: id(3),
        versionId: id(2),
      }).success,
    ).toBe(false);
    expect(Object.keys(registry)).toContain(
      'data.ingestion.candidate.geometry',
    );
  });
});

describe('bounded fixed-reference candidate history scope', () => {
  it.each(['get', 'records', 'geometry'] as const)(
    'installs only the strictly parsed reference before %s reads',
    async (name) => {
      const client = new Client();
      await read(client, name, {
        ...reference,
        ingestionId: alphaId(1).toUpperCase(),
        processingBatchId: alphaId(2).toUpperCase(),
        ...(name === 'get' ? {} : { assetId: id(3) }),
      });
      const fixed = client.queries.findIndex((q) =>
        q.text.includes('wiser.candidate_fixed_refs'),
      );
      const batch = client.queries.findIndex((q) =>
        q.text.includes('data.ingestion.candidate.batch'),
      );
      expect(fixed).toBeGreaterThan(-1);
      expect(fixed).toBeLessThan(batch);
      expect(JSON.parse(String(client.queries[fixed]!.values?.at(-1)))).toEqual(
        [
          {
            ...reference,
            ingestionId: alphaId(1),
            processingBatchId: alphaId(2),
          },
        ],
      );
    },
  );
  it('clears the history filter for callers with no explicit fixed selection', async () => {
    const client = new Client();
    await setCandidateReadAuthority(client, context);
    const fixed = client.queries.find((q) =>
      q.text.includes('wiser.candidate_fixed_refs'),
    );
    expect(fixed).toBeDefined();
    expect(JSON.parse(String(fixed!.values?.at(-1)))).toEqual([]);
  });
  it.each([
    { ...reference, eligible: true },
    { ...reference, status: 'READY' },
    { ...reference, reviewHash: 'F'.repeat(64) },
  ])(
    'refuses caller qualification or a malformed fixed tuple before SQL',
    async (ref) => {
      const client = new Client();
      await expect(
        setCandidateReadAuthority(client, context, [ref]),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(client.queries).toEqual([]);
    },
  );
  it('rejects canonical duplicates and more than 100 fixed references', async () => {
    for (const refs of [
      [
        { ...reference, ingestionId: alphaId(1) },
        { ...reference, ingestionId: alphaId(1).toUpperCase() },
      ],
      Array.from({ length: 101 }, (_, n) => ({
        ...reference,
        processingBatchId: id(100 + n),
      })),
    ]) {
      const client = new Client();
      await expect(
        setCandidateReadAuthority(client, context, refs),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(client.queries).toEqual([]);
    }
  });
});
