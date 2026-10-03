import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlatformRequestContext } from '@wiser/platform-contracts';
import { buildApp } from '../src/app.js';
import { PostgresDataAssetDownloadPort } from '../src/data-foundation/postgres-asset-download.js';
import { createDataFoundationRestModule } from '../src/data-foundation/rest-module.js';

const tenantId = 'ca000000-0000-4000-8000-000000000001';
const projectId = 'ca000000-0000-4000-8000-000000000002';
const actorId = 'ca000000-0000-4000-8000-000000000003';
const ingestionId = 'ca000000-0000-4000-8000-000000000004';
const processingBatchId = 'ca000000-0000-4000-8000-000000000005';
const assetId = 'ca000000-0000-4000-8000-000000000006';
const uploadId = 'ca000000-0000-4000-8000-000000000007';
const reviewHash = 'a'.repeat(64);
const original = new TextEncoder().encode('原月报，零值0，等级Ⅱ');
const sha256 = createHash('sha256').update(original).digest('hex');
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId,
  processingBatchId,
  reviewHash,
};
const context: PlatformRequestContext = {
  principal: {
    actorType: 'human',
    actorId,
    authUserId: actorId,
    sessionId: actorId,
    authenticationMethod: 'supabase_jwt',
  },
  authorization: {
    tenantId,
    projectId,
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write'],
    purpose: 'verify-original',
    maxSecurityLevel: 'L3_CONFIDENTIAL',
    authzVersion: 7,
  },
  traceId: 'c'.repeat(32),
};
const url = `/api/data/v1/tenants/${tenantId}/projects/${projectId}/ingestions/${ingestionId}/candidates/${processingBatchId}/assets/${assetId}/content?reviewHash=${reviewHash}`;
const headers = {
  authorization: 'Bearer verified',
  'x-wiser-tenant-id': tenantId,
  'x-wiser-project-id': projectId,
  'x-wiser-purpose': 'verify-original',
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

interface CandidatePort {
  createCandidateDownload(input: {
    context: PlatformRequestContext;
    reference: typeof reference;
    assetId: string;
  }): Promise<{
    url: string;
    expiresAt: string;
    sha256: string;
    sizeBytes: number;
  }>;
  authorizeCandidateDownload(input: {
    context: PlatformRequestContext;
    reference: typeof reference;
    assetId: string;
  }): Promise<void>;
}
function fixture(
  options: {
    body?: Uint8Array | ReadableStream<Uint8Array>;
    current?: PlatformRequestContext;
    revoke?: boolean;
    sign?: () => void;
    sizeBytes?: number;
    sha256?: string;
    fetcher?: typeof globalThis.fetch;
    authorizeCall?: (call: number) => Promise<void>;
    contextForToken?: (token: string) => PlatformRequestContext;
  } = {},
) {
  let reads = 0;
  const download = vi.fn(() => {
    options.sign?.();
    return Promise.resolve({
      url: 'http://private-store/candidate',
      expiresAt: '2099-01-01T00:00:00Z',
      sha256: options.sha256 ?? sha256,
      sizeBytes: options.sizeBytes ?? original.byteLength,
    });
  });
  const authorize = vi.fn(() => {
    reads += 1;
    if (options.revoke && reads > 1)
      return Promise.reject(
        Object.assign(new Error('private db detail'), { code: 'NOT_FOUND' }),
      );
    return options.authorizeCall?.(reads) ?? Promise.resolve();
  });
  const fetch = vi.fn(
    options.fetcher ??
      (() =>
        Promise.resolve(
          new Response(options.body ?? original, {
            headers: { 'content-type': 'application/octet-stream' },
          }),
        )),
  );
  const resolver = vi.fn((input: { token: string }) =>
    Promise.resolve(
      options.contextForToken?.(input.token) ?? options.current ?? context,
    ),
  );
  const app = buildApp({
    logger: false,
    modules: [
      createDataFoundationRestModule({
        resolver: { resolve: resolver },
        handler: { execute: () => Promise.resolve({}) },
        assetDownload: {
          createDownload: () =>
            Promise.reject(
              new Error('Published download must remain separate'),
            ),
          createCandidateDownload: download,
          authorizeCandidateDownload: authorize,
        },
        assetContentFetch: fetch,
      }),
    ],
  });
  apps.push(app);
  return { app, download, authorize, fetch, resolver };
}

describe('fixed pending original HTTP delivery', () => {
  it('bounds concurrent GET, HEAD and Range upstream reads for one responsible actor', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const f = fixture({
      fetcher: () =>
        waiting.length < 2
          ? new Promise<Response>((resolve) => waiting.push(resolve))
          : Promise.resolve(new Response(original)),
    });
    const first = f.app.inject({ method: 'GET', url, headers });
    const second = f.app.inject({ method: 'HEAD', url, headers });
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      const excess = await f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range: 'bytes=0-0' },
      });
      expect(excess.statusCode).toBe(503);
      expect(excess.headers['retry-after']).toBe('1');
      expect(excess.body).not.toContain('private-store');
      expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all([first, second]);
    }
  });

  it('shares the responsible human limit with delegated agents', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const agentContext = (id: string): PlatformRequestContext => ({
      ...context,
      principal: {
        actorType: 'agent',
        actorId: id,
        credentialId: id,
        delegationId: id,
        delegatedBy: actorId,
        authenticationMethod: 'delegated_credential',
      },
    });
    const f = fixture({
      contextForToken: (token) =>
        token === 'agent-a'
          ? agentContext('ca000000-0000-4000-8000-000000000008')
          : token === 'agent-b'
            ? agentContext('ca000000-0000-4000-8000-000000000009')
            : context,
      fetcher: () =>
        waiting.length < 2
          ? new Promise<Response>((resolve) => waiting.push(resolve))
          : Promise.resolve(new Response(original)),
    });
    const first = f.app.inject({
      method: 'GET',
      url,
      headers: { ...headers, authorization: 'Bearer agent-a' },
    });
    const second = f.app.inject({
      method: 'HEAD',
      url,
      headers: { ...headers, authorization: 'Bearer agent-b' },
    });
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      const excess = await f.app.inject({ method: 'GET', url, headers });
      expect(excess.statusCode).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all([first, second]);
    }
  });

  it('bounds the whole API instance across distinct responsible actors', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const f = fixture({
      contextForToken: (token) => {
        const id = `ca000000-0000-4000-8000-0000000000${token.padStart(2, '0')}`;
        return {
          ...context,
          principal: {
            ...context.principal,
            actorId: id,
            authUserId: id,
            sessionId: id,
          },
        };
      },
      fetcher: () =>
        waiting.length < 4
          ? new Promise<Response>((resolve) => waiting.push(resolve))
          : Promise.resolve(new Response(original)),
    });
    const requests = [1, 2, 3, 4].map((actor) =>
      f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, authorization: `Bearer ${actor}` },
      }),
    );
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(4));
      const excess = await f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, authorization: 'Bearer 5' },
      });
      expect(excess.statusCode).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(4);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all(requests);
    }
  });

  it.each([0, 32 * 1024 * 1024 + 1])(
    'rejects an invalid authorized size before fetching original bytes: %s',
    async (sizeBytes) => {
      const f = fixture({ sizeBytes });
      const response = await f.app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(503);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it('releases the reservation after HEAD, 416, an upstream failure and an authorization refusal', async () => {
    const normal = fixture();
    for (let index = 0; index < 3; index++) {
      const head = await normal.app.inject({ method: 'HEAD', url, headers });
      expect(head.statusCode).toBe(200);
      const unsatisfiable = await normal.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range: 'bytes=999999-' },
      });
      expect(unsatisfiable.statusCode).toBe(416);
    }
    expect(normal.fetch).toHaveBeenCalledTimes(6);

    const failed = fixture({
      fetcher: () => Promise.reject(new Error('private store failure')),
    });
    for (let index = 0; index < 3; index++)
      expect(
        (await failed.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(500);
    expect(failed.fetch).toHaveBeenCalledTimes(3);

    const refused = fixture({
      authorizeCall: (call) =>
        call % 2 === 0
          ? Promise.reject(
              Object.assign(new Error('candidate withdrawn'), {
                code: 'FORBIDDEN',
              }),
            )
          : Promise.resolve(),
    });
    for (let index = 0; index < 3; index++)
      expect(
        (await refused.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(403);
    expect(refused.fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps slow or unconsumed response bytes reserved until the client closes', async () => {
    const bytes = new Uint8Array(256 * 1024).fill(65);
    const f = fixture({
      body: bytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const first = await f.app.inject({
      method: 'GET',
      url,
      headers,
      payloadAsStream: true,
    });
    const second = await f.app.inject({
      method: 'GET',
      url,
      headers,
      payloadAsStream: true,
    });
    try {
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const excess = await f.app.inject({ method: 'HEAD', url, headers });
      expect(excess.statusCode).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally {
      first.raw.res.destroy();
      second.raw.res.destroy();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovered = await f.app.inject({ method: 'HEAD', url, headers });
    expect(recovered.statusCode).toBe(200);
  });

  it('keeps a fresh authorization check before each delivered chunk', async () => {
    const bytes = new Uint8Array(128 * 1024).fill(66);
    const f = fixture({
      body: bytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const response = await f.app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from(bytes));
    expect(f.authorize).toHaveBeenCalledTimes(4);
  });

  it('releases the budget when an in-flight client cancels and after principal expiry', async () => {
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let hold = true;
    const f = fixture({
      fetcher: (_input, init) =>
        hold
          ? new Promise<Response>((_resolve, reject) => {
              started();
              init?.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            })
          : Promise.resolve(new Response(original)),
    });
    const caller = new AbortController();
    const pending = f.app.inject({
      method: 'GET',
      url,
      headers,
      signal: caller.signal,
    });
    await fetching;
    caller.abort();
    await expect(pending).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    hold = false;
    for (let index = 0; index < 3; index++)
      expect(
        (await f.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(200);

    const state = {
      current: context,
      expireOnFetch: true,
      fetcher: () => {
        if (state.expireOnFetch)
          state.current = {
            ...context,
            principal: {
              ...context.principal,
              expiresAt: '2020-01-01T00:00:00Z',
            },
          };
        return Promise.resolve(new Response(original));
      },
    };
    const expiry = fixture(state);
    expect(
      (await expiry.app.inject({ method: 'GET', url, headers })).statusCode,
    ).toBe(403);
    state.current = context;
    state.expireOnFetch = false;
    for (let index = 0; index < 3; index++)
      expect(
        (await expiry.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(200);
  });

  it('holds a cancelled request slot until a non-cooperative upstream fetch settles', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const f = fixture({
      fetcher: () =>
        waiting.length < 2
          ? new Promise<Response>((resolve) => waiting.push(resolve))
          : Promise.resolve(new Response(original)),
    });
    const caller = new AbortController();
    const cancelled = f.app.inject({
      method: 'GET',
      url,
      headers,
      signal: caller.signal,
    });
    const second = f.app.inject({ method: 'GET', url, headers });
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      caller.abort();
      await expect(cancelled).rejects.toThrow();
      const excess = await f.app.inject({ method: 'HEAD', url, headers });
      expect(excess.statusCode).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      waiting[0]!(new Response(original));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const recovered = await f.app.inject({ method: 'HEAD', url, headers });
      expect(recovered.statusCode).toBe(200);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await second;
    }
  });

  it('serves exact original bytes without a published version or signed redirect', async () => {
    const f = fixture();
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload).toEqual(Buffer.from(original));
    expect(r.headers.location).toBeUndefined();
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['content-disposition']).toBe('attachment');
    expect(f.download).toHaveBeenCalledWith({ context, reference, assetId });
    expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('checks the full hash before releasing even a valid byte range', async () => {
    const f = fixture();
    const r = await f.app.inject({
      method: 'GET',
      url,
      headers: { ...headers, range: 'bytes=0-5' },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload).toEqual(Buffer.from(original).subarray(0, 6));
    expect(r.headers['content-range']).toBe(`bytes 0-5/${original.byteLength}`);
  });
  it.each([new Uint8Array(original.byteLength).fill(65), original.slice(1)])(
    'withholds changed or truncated quarantine bytes',
    async (body) => {
      const f = fixture({ body });
      const r = await f.app.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(503);
      expect(r.body).not.toContain('private-store');
      expect(r.body).not.toContain('原月报');
      expect(r.headers.location).toBeUndefined();
    },
  );
  it('does not release bytes after a frozen candidate is superseded or withdrawn', async () => {
    const f = fixture({ revoke: true });
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('原月报');
    expect(f.authorize).toHaveBeenCalled();
  });
  it('withholds delivery when current authority changes while signing', async () => {
    const options = { current: context, sign: () => {} };
    options.sign = () => {
      options.current = {
        ...context,
        authorization: { ...context.authorization, authzVersion: 8 },
      };
    };
    const f = fixture(options);
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(403);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('denies a catalog-only reader without maintenance or independent review authority', async () => {
    const f = fixture({
      current: {
        ...context,
        authorization: {
          ...context.authorization,
          scopes: ['data.catalog.read'],
        },
      },
    });
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(403);
    expect(f.download).not.toHaveBeenCalled();
  });
  it.each([
    url.replace(reviewHash, 'f'.repeat(63)),
    `${url}&versionId=${assetId}`,
    url.replace(assetId + '/content', 'source/content'),
    `${url}&reviewHash=${reviewHash}`,
  ])(
    'rejects incomplete, aliased or repeated fixed references: %s',
    async (url) => {
      const f = fixture();
      const r = await f.app.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(422);
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it('verifies copied bytes when a reader reuses its underlying buffer', async () => {
    const shared = new Uint8Array(1);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === original.length) {
            controller.close();
            return;
          }
          shared[0] = original[offset++]!;
          controller.enqueue(shared);
        },
      },
      { highWaterMark: 0 },
    );
    const f = fixture({ body });
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload).toEqual(Buffer.from(original));
  });
  it.each(['bytes=1-0', 'bytes=-0'])(
    'rejects unsatisfiable single ranges: %s',
    async (range) => {
      const f = fixture();
      const r = await f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range },
      });
      expect(r.statusCode).toBe(416);
      expect(r.body).toBe('');
    },
  );
  it.each(['bytes=0-1,3-4', 'bytes=1-a'])(
    'rejects unsupported range syntax: %s',
    async (range) => {
      const f = fixture();
      const r = await f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range },
      });
      expect(r.statusCode).toBe(422);
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...context, authorization: { ...context.authorization, purpose: ' ' } },
    {
      ...context,
      principal: { ...context.principal, expiresAt: '2020-01-01T00:00:00Z' },
    },
    { ...context, principal: { ...context.principal, delegatedBy: actorId } },
    {
      ...context,
      authorization: { ...context.authorization, tenantId: actorId },
    },
  ])(
    'rejects unavailable purpose, identity or tenant authority',
    async (current) => {
      const f = fixture({ current });
      const r = await f.app.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(403);
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it('returns body-free HEAD and rejects unsatisfiable ranges after original verification', async () => {
    const f = fixture();
    const head = await f.app.inject({ method: 'HEAD', url, headers });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(original.byteLength));
    const r = await f.app.inject({
      method: 'GET',
      url,
      headers: { ...headers, range: 'bytes=999999-' },
    });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe(`bytes */${original.byteLength}`);
    expect(r.body).toBe('');
  });
});

function databaseFixture(
  row: Record<string, unknown> | null = {
    source_hash: sha256,
    content_hash: sha256,
    blob_hash: sha256,
    storage_key: `tenants/${tenantId}/projects/${projectId}/quarantine/${uploadId}/object`,
    byte_size: original.byteLength,
    media_type: 'application/octet-stream',
    security_level: 'L0_PUBLIC',
    policy_version: 7,
  },
) {
  const queries: { text: string; values?: readonly unknown[] }[] = [];
  const client = {
    query(text: string, values?: readonly unknown[]) {
      queries.push({ text, ...(values ? { values } : {}) });
      return Promise.resolve({
        rows: text.includes('candidate-original.lookup')
          ? row
            ? [row]
            : []
          : [],
      });
    },
    release: vi.fn(),
  };
  const signer = vi.fn(() =>
    Promise.resolve({
      bucket: 'authority',
      key: 'never-output',
      url: 'http://private-store/original',
      expiresAt: '2099-01-01T00:00:00Z',
    }),
  );
  const port = new PostgresDataAssetDownloadPort({
    pool: {
      connect: () => Promise.resolve(client),
      end: () => Promise.resolve(),
    },
    objectStore: {
      planVersionDownload: () =>
        Promise.reject(new Error('no published version')),
      planCandidateDownload: signer,
    },
  });
  return { port: port as unknown as CandidatePort, signer, queries, client };
}
describe('pending original fixed authority database boundary', () => {
  it('signs only the original upload derived from a current fixed candidate and audits it', async () => {
    const f = databaseFixture();
    const r = await f.port.createCandidateDownload({
      context,
      reference,
      assetId,
    });
    expect(r).toEqual({
      url: 'http://private-store/original',
      expiresAt: '2099-01-01T00:00:00Z',
      sha256,
      sizeBytes: original.byteLength,
    });
    expect(f.signer).toHaveBeenCalledWith({
      tenantId,
      projectId,
      uploadId,
      sizeBytes: original.byteLength,
      contentType: 'application/octet-stream',
      sha256,
      ttlSeconds: 60,
    });
    expect(
      f.queries.some(
        (q) =>
          q.text.includes('candidate-original.scope') &&
          q.values?.includes(reviewHash),
      ),
    ).toBe(true);
    expect(
      f.queries.some(
        (q) =>
          q.text.includes('candidate-original.audit') &&
          q.values?.includes(ingestionId),
      ),
    ).toBe(true);
    expect(f.queries.at(-1)?.text).toBe('COMMIT');
    expect(f.client.release).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'other-project-key', 'changed-hash'])(
    'does not sign an unavailable or conflicting fixed original: %s',
    async (change) => {
      const row = {
        source_hash: sha256,
        content_hash: change === 'changed-hash' ? reviewHash : sha256,
        blob_hash: sha256,
        storage_key: `tenants/${tenantId}/projects/${change === 'other-project-key' ? actorId : projectId}/quarantine/${uploadId}/object`,
        byte_size: original.byteLength,
        media_type: 'application/octet-stream',
        security_level: 'L0_PUBLIC',
        policy_version: 7,
      };
      const f = databaseFixture(change === 'missing' ? null : row);
      await expect(
        f.port.createCandidateDownload({ context, reference, assetId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(f.signer).not.toHaveBeenCalled();
      expect(f.queries.at(-1)?.text).toBe('ROLLBACK');
    },
  );
});
