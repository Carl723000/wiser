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
    body?: Uint8Array;
    current?: PlatformRequestContext;
    revoke?: boolean;
    sign?: () => void;
  } = {},
) {
  let reads = 0;
  const download = vi.fn(() => {
    options.sign?.();
    return Promise.resolve({
      url: 'http://private-store/candidate',
      expiresAt: '2099-01-01T00:00:00Z',
      sha256,
      sizeBytes: original.byteLength,
    });
  });
  const authorize = vi.fn(() => {
    if (options.revoke && ++reads > 1)
      return Promise.reject(
        Object.assign(new Error('private db detail'), { code: 'NOT_FOUND' }),
      );
    return Promise.resolve();
  });
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(options.body ?? original, {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ),
  );
  const resolver = vi.fn(() => Promise.resolve(options.current ?? context));
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
        } as never,
        assetContentFetch: fetch,
      }),
    ],
  });
  apps.push(app);
  return { app, download, authorize, fetch, resolver };
}

describe('fixed pending original HTTP delivery', () => {
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
    } as never,
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
