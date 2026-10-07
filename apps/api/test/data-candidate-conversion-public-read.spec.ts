import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DATA_CAPABILITY_IDS,
  DATA_CAPABILITY_REGISTRY,
  type DataCapabilityId,
} from '@wiser/data-contracts';
import type { PlatformRequestContext } from '@wiser/platform-contracts';
import { buildApp } from '../src/app.js';
import {
  DataCapabilityHandler,
  type DataCapabilityAuditRecord,
  type ExecuteDataCapabilityInput,
} from '../src/data-foundation/capability-handler.js';
import { admitsManagedCapability } from '../src/data-foundation/managed-capability-policy.js';
import { createPostgresDataReadRuntime } from '../src/data-foundation/postgres-read-executors.js';
import { createDataFoundationRestModule } from '../src/data-foundation/rest-module.js';
import { createDataFoundationGraphqlModule } from '../src/data-foundation/graphql-module.js';

const capabilityId =
  'data.ingestion.candidate.provenance.get' as DataCapabilityId;
const id = (n: number) =>
  `35000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
const input = { ...reference, preparedAssetId: id(3) };
const context: PlatformRequestContext = {
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
  traceId: 'b'.repeat(32),
};
const check = {
  schemaVersion: 1,
  resultId: id(8),
  reference,
  original: { assetId: id(9), sha256: 'c'.repeat(64), byteSize: 12 },
  prepared: { assetId: id(3), sha256: 'd'.repeat(64), byteSize: 18 },
  manifest: { assetId: id(10), sha256: 'e'.repeat(64) },
  sourceLocalWorkId: 'synthetic-private-conversion-work',
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
function row(provenance: unknown = check) {
  return {
    ingestion_id: id(1),
    processing_batch_id: id(2),
    review_hash: reference.reviewHash,
    asset_id: id(3),
    submitted_by_actor_id: id(4),
    submitted_actor_type: 'human',
    submitted_delegator_actor_id: null,
    provenance,
  };
}
// Executes the production runtime, handler and transports against a query control
// seam. It does not establish PostgreSQL FORCE RLS or live Auth acceptance.
function runtime(
  getRows: (connection: number) => readonly Record<string, unknown>[] = () => [
    row(),
  ],
) {
  const queries: {
    sql: string;
    values?: readonly unknown[];
    connection: number;
  }[] = [];
  let connections = 0;
  let releases = 0;
  const read = createPostgresDataReadRuntime({
    connect() {
      const connection = ++connections;
      return Promise.resolve({
        query(sql: string, values?: readonly unknown[]) {
          queries.push({ sql, connection, ...(values ? { values } : {}) });
          return Promise.resolve({
            rows: sql.includes('candidate.provenance.fixed')
              ? getRows(connection)
              : [],
          });
        },
        release() {
          releases++;
        },
      });
    },
    end: () => Promise.resolve(),
  });
  const selected = read.executors.find(
    (executor) => executor.id === capabilityId,
  );
  expect(
    selected,
    'the standard runtime must supply the narrow reader',
  ).toBeDefined();
  const audits: DataCapabilityAuditRecord[] = [];
  const handler = new DataCapabilityHandler({
    executors: DATA_CAPABILITY_IDS.map((id) =>
      id === capabilityId
        ? selected!
        : {
            id,
            execute: () =>
              Promise.reject(new Error('Unexpected fixture capability')),
          },
    ),
    audit: {
      record(record) {
        audits.push(record);
        return Promise.resolve();
      },
    },
  });
  const requests: ExecuteDataCapabilityInput[] = [];
  return {
    queries,
    audits,
    read,
    connections: () => connections,
    releases: () => releases,
    execute(this: void, request: ExecuteDataCapabilityInput) {
      requests.push(request);
      return handler.execute(request);
    },
    requests,
  };
}
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function headers() {
  return {
    authorization: 'Bearer synthetic-test-token',
    'x-wiser-tenant-id': id(6),
    'x-wiser-project-id': id(7),
    'x-wiser-purpose': 'candidate-review',
  };
}
function url(extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    kind: reference.kind,
    reviewHash: reference.reviewHash,
    ...extra,
  });
  return `/api/data/v1/ingestions/${id(1)}/candidates/${id(2)}/${id(3)}/provenance?${query.toString()}`;
}
function appWith(
  r: ReturnType<typeof runtime>,
  transport: 'rest' | 'graphql',
  resolve: () => PlatformRequestContext | null = () => context,
) {
  const options = {
    handler: { execute: r.execute },
    resolver: { resolve: () => Promise.resolve(resolve()) },
  };
  const app = buildApp({
    logger: false,
    modules: [
      transport === 'rest'
        ? createDataFoundationRestModule(options)
        : createDataFoundationGraphqlModule(options),
    ],
  });
  apps.push(app);
  return app;
}
function graphql(inputValue: unknown = input, aliases = false) {
  return {
    query: aliases
      ? 'query($input: JSON!) { first: dataIngestionCandidateProvenance(input: $input) second: dataIngestionCandidateProvenance(input: $input) }'
      : 'query($input: JSON!) { dataIngestionCandidateProvenance(input: $input) }',
    variables: { input: inputValue },
  };
}
function managed(validUntil = '2099-01-01T00:00:00Z'): PlatformRequestContext {
  return {
    ...context,
    authorization: {
      ...context.authorization,
      resourceAccess: {
        revision: 1,
        fingerprint: 'f'.repeat(64),
        scope: {
          mode: 'managed',
          validUntil,
          permissions: {
            'content.read': [],
            'original.read': [],
            'result.export': [],
            'source.discover': [],
            'external.directory': [],
          },
        },
      },
    },
  };
}

describe('registered narrow candidate conversion provenance read', () => {
  it('registers one versioned query with strict fixed identity and bounded safe output', () => {
    expect(DATA_CAPABILITY_IDS).toContain(capabilityId);
    const definition = DATA_CAPABILITY_REGISTRY[capabilityId];
    expect(definition).toMatchObject({
      version: '1.0.0',
      kind: 'query',
      requiredScopes: ['data.operation.read'],
      restMapping: {
        method: 'GET',
        path: '/api/data/v1/ingestions/:ingestionId/candidates/:processingBatchId/:preparedAssetId/provenance',
      },
      graphqlMapping: {
        operationType: 'query',
        field: 'dataIngestionCandidateProvenance',
      },
      mcpMapping: { toolName: 'data_ingestion_candidate_provenance_get' },
    });
    expect(definition.inputSchema.safeParse(input).success).toBe(true);
    expect(
      definition.inputSchema.safeParse({ ...input, verified: true }).success,
    ).toBe(false);
    expect(
      definition.outputSchema.safeParse({
        reference,
        preparedAssetId: id(3),
        check,
      }).success,
    ).toBe(true);
    expect(
      definition.outputSchema.safeParse({
        reference,
        preparedAssetId: id(3),
        check: { ...check, storageKey: 'must-not-leak' },
      }).success,
    ).toBe(false);
    expect(admitsManagedCapability(capabilityId)).toBe(true);
    expect(admitsManagedCapability('data.ingestion.approve')).toBe(false);
  });

  it('runs the existing scoped reader through the standard handler and hashes audit payloads', async () => {
    const r = runtime();
    await expect(
      r.execute({ capabilityId, input, requestContext: managed() }),
    ).resolves.toEqual({ reference, preparedAssetId: id(3), check });
    expect(r.queries[0]?.sql).toBe(
      'begin isolation level repeatable read read only',
    );
    expect(
      r.queries.some(({ sql }) => sql.includes('wiser.candidate_maintainer')),
    ).toBe(true);
    const fixed = r.queries.find(({ sql }) =>
      sql.includes('candidate.provenance.fixed'),
    )!;
    expect(fixed.values).toEqual([id(1), id(2), reference.reviewHash, id(3)]);
    expect(fixed.sql).not.toContain('storage_key');
    expect(r.releases()).toBe(1);
    expect(r.audits).toMatchObject([
      {
        capabilityId,
        decision: 'SUCCEEDED',
        purpose: 'candidate-review',
      },
    ]);
    expect(r.audits[0]?.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.audits[0]?.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(r.audits)).not.toContain(
      'synthetic-private-conversion-work',
    );
    expect(JSON.stringify(r.audits)).not.toContain('preparedAssetId');
  });

  it('rejects forged verification, arbitrary filters and malformed reference before connecting', async () => {
    const r = runtime();
    for (const raw of [
      { ...input, verified: true },
      { ...input, filter: 'arbitrary' },
      { ...input, reviewHash: 'bad-hash' },
    ]) {
      await expect(
        r.execute({ capabilityId, input: raw, requestContext: context }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(r.connections()).toBe(0);
    expect(r.audits).toHaveLength(3);
    expect(
      r.audits.every(
        (record) =>
          record.decision === 'DENIED' &&
          record.errorCode === 'VALIDATION_FAILED',
      ),
    ).toBe(true);
    expect(JSON.stringify(r.audits)).not.toMatch(/verified|arbitrary|bad-hash/);
  });

  it('reuses current maintenance or independent human review authority without new scopes', async () => {
    const r = runtime();
    const reviewer = {
      ...context,
      principal: { ...context.principal, actorId: id(90), authUserId: id(90) },
      authorization: {
        ...context.authorization,
        scopes: ['data.operation.read', 'data.publish'],
      },
    };
    await expect(
      r.execute({ capabilityId, input, requestContext: reviewer }),
    ).resolves.toEqual({ reference, preparedAssetId: id(3), check });
    for (const denied of [
      {
        ...context,
        authorization: {
          ...context.authorization,
          scopes: ['data.operation.read'],
        },
      },
      {
        ...context,
        principal: { ...context.principal, expiresAt: '2000-01-01T00:00:00Z' },
      },
      managed('2000-01-01T00:00:00Z'),
      {
        ...context,
        principal: {
          actorId: id(90),
          actorType: 'agent' as const,
          authenticationMethod: 'delegated_credential' as const,
          credentialId: id(91),
          delegationId: id(92),
          delegatedBy: id(4),
        },
        authorization: reviewer.authorization,
      },
    ]) {
      await expect(
        r.execute({ capabilityId, input, requestContext: denied }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(r.connections()).toBe(1);
  });

  it('returns no content for a missing member or another submitter under maintenance authority', async () => {
    for (const rows of [
      [],
      [{ ...row(), submitted_by_actor_id: id(90) }],
      [{ ...row(), asset_id: id(90) }],
    ]) {
      const r = runtime(() => rows);
      await expect(
        r.execute({ capabilityId, input, requestContext: context }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(r.audits).toMatchObject([
        { decision: 'FAILED', errorCode: 'NOT_FOUND' },
      ]);
      expect(r.queries.at(-1)?.sql).toBe('rollback');
    }
  });

  it('refuses a malformed server result without exposing its private storage address', async () => {
    const r = runtime(() => [
      row({ ...check, storageKey: 'private-storage-address' }),
    ]);
    const app = appWith(r, 'rest');
    const response = await app.inject({
      method: 'GET',
      url: url(),
      headers: headers(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private-storage-address');
    expect(JSON.stringify(r.audits)).not.toContain('private-storage-address');
  });

  it('REST maps only the fixed path and returns a no-store, safe summary', async () => {
    const r = runtime();
    const app = appWith(r, 'rest');
    const response = await app.inject({
      method: 'GET',
      url: url(),
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toEqual({
      reference,
      preparedAssetId: id(3),
      check,
    });
    expect(response.body).not.toMatch(
      /storageKey|storage_key|jobPayload|internalUrl|versionId/,
    );
    expect(r.requests[0]?.input).toEqual(input);
    const missing = appWith(
      runtime(() => []),
      'rest',
    );
    const absent = await missing.inject({
      method: 'GET',
      url: url(),
      headers: headers(),
    });
    expect(absent.statusCode).toBe(404);
    expect(absent.body).not.toContain('synthetic-private-conversion-work');
  });

  it('REST rejects untrusted extra query arguments before database access', async () => {
    const r = runtime();
    const app = appWith(r, 'rest');
    const response = await app.inject({
      method: 'GET',
      url: url({ verified: 'true' }),
      headers: headers(),
    });
    expect(response.statusCode).toBe(422);
    expect(r.connections()).toBe(0);
    expect(r.audits).toMatchObject([
      { decision: 'DENIED', errorCode: 'VALIDATION_FAILED' },
    ]);
  });

  it('REST discards a successful read if transport delivery authority changed', async () => {
    const r = runtime();
    let resolutions = 0;
    const app = appWith(r, 'rest', () =>
      ++resolutions === 1
        ? context
        : {
            ...context,
            authorization: { ...context.authorization, authzVersion: 2 },
          },
    );
    const response = await app.inject({
      method: 'GET',
      url: url(),
      headers: headers(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('synthetic-private-conversion-work');
    expect(r.audits).toMatchObject([{ decision: 'SUCCEEDED' }]);
  });

  it('GraphQL maps the same strict read and each identical alias rechecks candidate visibility', async () => {
    const r = runtime((connection) => (connection === 1 ? [row()] : []));
    const app = appWith(r, 'graphql');
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: headers(),
      payload: graphql(input, true),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: unknown }>().data).toBeNull();
    expect(r.connections()).toBe(2);
    expect(r.audits.map((a) => a.decision).sort()).toEqual([
      'FAILED',
      'SUCCEEDED',
    ]);
    expect(r.audits.find((a) => a.decision === 'FAILED')?.errorCode).toBe(
      'NOT_FOUND',
    );
    expect(
      r.requests.every((request) => request.signal instanceof AbortSignal),
    ).toBe(true);
    expect(response.body).not.toContain('synthetic-private-conversion-work');
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('GraphQL returns the bounded result and validates strict input before connecting', async () => {
    const r = runtime();
    const app = appWith(r, 'graphql');
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: headers(),
      payload: graphql(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        dataIngestionCandidateProvenance: {
          reference,
          preparedAssetId: id(3),
          check,
        },
      },
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: headers(),
      payload: graphql({ ...input, verified: true }),
    });
    expect(invalid.json<{ data: unknown }>().data).toBeNull();
    expect(r.connections()).toBe(1);
    expect(r.audits.at(-1)).toMatchObject({
      decision: 'DENIED',
      errorCode: 'VALIDATION_FAILED',
    });
  });

  it('GraphQL discards a successful read when transport delivery authorization changed', async () => {
    const r = runtime();
    let resolutions = 0;
    const app = appWith(r, 'graphql', () =>
      ++resolutions === 1 ? context : null,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: headers(),
      payload: graphql(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('synthetic-private-conversion-work');
  });
});
