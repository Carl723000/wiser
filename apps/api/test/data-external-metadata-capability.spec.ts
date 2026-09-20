import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
} from '../src/data-foundation/capability-handler.js';
import { createDataFoundationRestModule } from '../src/data-foundation/rest-module.js';
import { createDataFoundationGraphqlModule } from '../src/data-foundation/graphql-module.js';
import {
  ExternalMetadataReader,
  ExternalMetadataError,
} from '../src/data-foundation/external-metadata.js';

const id = 'data.external.metadata.read' as DataCapabilityId;
const sourceId = 'e2000000-0000-4000-8000-000000000001';
const actorId = 'e2000000-0000-4000-8000-000000000002';
const tenantId = 'e2000000-0000-4000-8000-000000000003';
const projectId = 'e2000000-0000-4000-8000-000000000004';
const input = { sourceId, fromYear: 2021, toYear: 2025, offset: 0, limit: 2 };
const context: PlatformRequestContext = {
  principal: {
    actorType: 'human',
    actorId,
    authUserId: actorId,
    sessionId: sourceId,
    authenticationMethod: 'supabase_jwt',
  },
  authorization: {
    tenantId,
    projectId,
    purpose: 'metadata-read',
    roles: ['reader'],
    scopes: ['data.catalog.read'],
    maxSecurityLevel: 'L2_RESTRICTED',
    authzVersion: 7,
  },
  traceId: 'e'.repeat(32),
};
const grant = {
  sourceId,
  actorId,
  actorType: 'human',
  tenantId,
  projectId,
  purpose: 'metadata-read',
  authzVersion: 7,
  policyVersion: 'v1',
  expiresAt: '2026-09-21T00:00:00Z',
  fromYear: 2021,
  toYear: 2025,
  fields: ['stationCode', 'year'],
  securityLevel: 'L2_RESTRICTED',
};
const headers = {
  authorization: 'Bearer synthetic-test-token',
  'x-wiser-tenant-id': tenantId,
  'x-wiser-project-id': projectId,
  'x-wiser-purpose': 'metadata-read',
};
const url = `/api/data/v1/external-sources/${sourceId}/metadata/query`;
const payload = { fromYear: 2021, toYear: 2025, limit: 2 };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup(disabled = false, queryTimeoutMs = 30000) {
  const { createExternalMetadataExecutor } =
    await import('../src/data-foundation/external-metadata-executor.js');
  const resolve = vi.fn((): Promise<unknown> =>
    Promise.resolve(structuredClone(grant)),
  );
  const readPage = vi.fn((): Promise<unknown> =>
    Promise.resolve({
      items: [
        {
          stationCode: 'SYNTHETIC-A',
          year: 2024,
          value: 'RESTRICTED-NUMERIC-VALUE',
          city: 'UNGRANTED-CITY',
        },
      ],
      total: 1,
    }),
  );
  const reader = new ExternalMetadataReader({
    access: { resolve },
    provider: { readPage },
    now: () => Date.parse('2026-09-20T00:00:00Z'),
  });
  const executor = createExternalMetadataExecutor(
    disabled ? undefined : reader,
  );
  const audit: DataCapabilityAuditRecord[] = [];
  const handler = new DataCapabilityHandler({
    executors: DATA_CAPABILITY_IDS.map((capabilityId) =>
      capabilityId === id
        ? executor
        : {
            id: capabilityId,
            execute: () => Promise.reject(new Error('Unexpected capability')),
          },
    ),
    audit: {
      record: (record) => {
        audit.push(record);
        return Promise.resolve();
      },
    },
  });
  const resolver = { resolve: vi.fn(() => Promise.resolve(context)) };
  const app = buildApp({
    logger: false,
    modules: [
      createDataFoundationRestModule({ handler, resolver }),
      createDataFoundationGraphqlModule({ handler, resolver, queryTimeoutMs }),
    ],
  });
  apps.push(app);
  return { app, handler, audit, resolve, readPage, resolver };
}

describe('external metadata through the platform capability boundary', () => {
  it('reports GraphQL transport timeout distinctly and audits it as timeout', async () => {
    const { app, readPage, audit } = await setup(false, 40);
    readPage.mockImplementation(() => new Promise(() => {}));
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers,
      payload: {
        query: 'query($input: JSON!) { externalSourceMetadata(input:$input) }',
        variables: { input },
      },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      errors: [{ extensions: { code: 'CAPABILITY_TIMEOUT' } }],
    });
    await vi.waitFor(() => expect(audit).toHaveLength(1));
    expect(audit[0]).toMatchObject({
      decision: 'FAILED',
      errorCode: 'CAPABILITY_TIMEOUT',
    });
  });
  it('does not present disabled GraphQL metadata as an empty source', async () => {
    const { app, readPage } = await setup(true);
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers,
      payload: {
        query: 'query($input: JSON!) { externalSourceMetadata(input:$input) }',
        variables: { input },
      },
    });
    expect(response.json()).toMatchObject({
      data: null,
      errors: [{ extensions: { code: 'EXTERNAL_SOURCE_UNCONFIGURED' } }],
    });
    expect(response.body).not.toContain('EMPTY');
    expect(readPage).not.toHaveBeenCalled();
  });

  it('aborts external work when a real REST client disconnects', async () => {
    const { app, readPage, audit } = await setup();
    let started!: () => void;
    const reachedProvider = new Promise<void>((resolve) => {
      started = resolve;
    });
    readPage.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = httpRequest(new URL(url, origin), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify(payload));
    await reachedProvider;
    client.destroy();
    await vi.waitFor(() => expect(audit).toHaveLength(1));
    expect(audit[0]).toMatchObject({
      decision: 'FAILED',
      errorCode: 'REQUEST_CANCELLED',
    });
  });
  it('returns a safe GraphQL permission failure without metadata', async () => {
    const { app, resolve } = await setup();
    resolve.mockResolvedValue(null);
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers,
      payload: {
        query: 'query($input: JSON!) { externalSourceMetadata(input:$input) }',
        variables: { input },
      },
    });
    expect(response.json()).toMatchObject({
      data: null,
      errors: [{ extensions: { code: 'FORBIDDEN' } }],
    });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).not.toContain('SYNTHETIC-A');
  });
  it('rejects an already cancelled request before permission lookup', async () => {
    const { handler, resolve, audit } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      handler.execute({
        capabilityId: id,
        input,
        requestContext: context,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(resolve).not.toHaveBeenCalled();
    expect(audit[0]?.decision).toBe('FAILED');
  });

  it('publishes one strict readonly capability with all four transport mappings', () => {
    expect(DATA_CAPABILITY_REGISTRY[id]).toMatchObject({
      kind: 'query',
      requiredScopes: ['data.catalog.read'],
      restMapping: {
        method: 'POST',
        path: '/api/data/v1/external-sources/:sourceId/metadata/query',
      },
      graphqlMapping: {
        operationType: 'query',
        field: 'externalSourceMetadata',
      },
      mcpMapping: { toolName: 'data_external_metadata_read' },
    });
  });
  it('returns only authorized metadata with no-store headers and hash-only audit', async () => {
    const { app, audit } = await setup();
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({
      sourceId,
      status: 'AVAILABLE',
      items: [{ stationCode: 'SYNTHETIC-A', year: 2024 }],
      timePrecision: 'year',
    });
    expect(response.body).not.toContain('RESTRICTED-NUMERIC-VALUE');
    expect(response.body).not.toContain('UNGRANTED-CITY');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      capabilityId: id,
      actorId,
      tenantId,
      projectId,
      purpose: 'metadata-read',
      decision: 'SUCCEEDED',
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
      outputHash: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
    });
    expect(JSON.stringify(audit)).not.toContain('SYNTHETIC-A');
  });
  it('requires authentication before provider access', async () => {
    const { app, resolve, readPage } = await setup();
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(resolve).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });
  it('does not turn platform scope into a provider grant', async () => {
    const { app, resolve, readPage, audit } = await setup();
    resolve.mockResolvedValue(null);
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(readPage).not.toHaveBeenCalled();
    expect(audit[0]).toMatchObject({
      decision: 'DENIED',
      errorCode: 'FORBIDDEN',
    });
  });
  it.each(['token', 'fields', 'endpoint', 'grant'])(
    'rejects caller-controlled %s before provider access',
    async (field) => {
      const { app, readPage } = await setup();
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...payload, [field]: 'not-allowed' },
      });
      expect(response.statusCode).toBe(422);
      expect(readPage).not.toHaveBeenCalled();
    },
  );
  it('keeps the default runtime disabled rather than fabricating an empty page', async () => {
    const { app } = await setup(true);
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain('EXTERNAL_SOURCE_UNCONFIGURED');
    expect(response.body).not.toContain('EMPTY');
    expect(response.headers['cache-control']).toContain('no-store');
  });
  it.each([
    ['SOURCE_TIMEOUT', 'EXTERNAL_SOURCE_TIMEOUT', 504],
    ['SOURCE_ACCESS_DENIED', 'EXTERNAL_SOURCE_ACCESS_DENIED', 403],
    ['INVALID_METADATA', 'EXTERNAL_METADATA_INVALID', 502],
    ['SOURCE_UNAVAILABLE', 'EXTERNAL_SOURCE_UNAVAILABLE', 503],
  ] as const)(
    'preserves safe %s distinctions through REST and audit',
    async (sourceCode, code, status) => {
      const { app, readPage, audit } = await setup();
      readPage.mockRejectedValue(new ExternalMetadataError(sourceCode));
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).toContain(code);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(audit[0]?.errorCode).toBe(code);
    },
  );
  it('supports GraphQL through the same field restrictions without alias caching', async () => {
    const { app, resolve, audit } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers,
      payload: {
        query:
          'query($input: JSON!) { one: externalSourceMetadata(input:$input) two: externalSourceMetadata(input:$input) }',
        variables: { input },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        one: { items: [{ stationCode: 'SYNTHETIC-A', year: 2024 }] },
        two: { items: [{ stationCode: 'SYNTHETIC-A', year: 2024 }] },
      },
    });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(audit).toHaveLength(2);
  });
  it('propagates a trusted cancellation signal and never audits cancelled work as success', async () => {
    const { handler, readPage, audit } = await setup();
    let started!: () => void;
    const reachedProvider = new Promise<void>((resolve) => {
      started = resolve;
    });
    readPage.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const work = handler.execute({
      capabilityId: id,
      input,
      requestContext: context,
      signal: controller.signal,
    });
    const result = expect(work).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    });
    await reachedProvider;
    controller.abort();
    await result;
    expect(audit[0]).toMatchObject({
      decision: 'FAILED',
      errorCode: 'REQUEST_CANCELLED',
    });
  });
});
