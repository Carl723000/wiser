import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalMetadataHttpProvider } from '../src/data-foundation/external-metadata-http.js';
import { ExternalMetadataReader } from '../src/data-foundation/external-metadata.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';

const sourceId = 'e1000000-0000-4000-8000-000000000001';
const input = {
  request: { sourceId, fromYear: 2021, toYear: 2025, offset: 0, limit: 2 },
  fields: ['stationCode', 'year'] as const,
  signal: new AbortController().signal,
};
const page = { items: [{ stationCode: 'SYNTHETIC-A', year: 2024 }], total: 1 };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('TEST_SERVER_ADDRESS');
  return `http://127.0.0.1:${address.port}/metadata`;
}
function provider(endpoint: string, extra = {}) {
  return new ExternalMetadataHttpProvider({
    sourceId,
    endpoint,
    allowInsecureLoopback: true,
    ...extra,
  });
}
function json(res: ServerResponse, value: unknown) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

describe('fixed external metadata HTTP transport (isolated loopback)', () => {
  it('requests one bounded metadata page with host-only credentials and no-cache headers', async () => {
    let observed: unknown;
    const endpoint = await serve((req, res) => {
      observed = {
        path: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        cache: req.headers['cache-control'],
      };
      json(res, page);
    });
    expect(
      await provider(endpoint, {
        authorization: 'Bearer synthetic-only',
      }).readPage(input),
    ).toEqual(page);
    expect(observed).toEqual({
      path: '/metadata?fromYear=2021&toYear=2025&offset=0&limit=2&fields=stationCode%2Cyear',
      method: 'GET',
      authorization: 'Bearer synthetic-only',
      cache: 'no-store',
    });
  });
  it('does not cache a previous page', async () => {
    let requests = 0;
    const endpoint = await serve((_req, res) =>
      json(res, { ...page, total: ++requests }),
    );
    const p = provider(endpoint);
    expect(await p.readPage(input)).toMatchObject({ total: 1 });
    expect(await p.readPage(input)).toMatchObject({ total: 2 });
  });
  it('rejects another source and caller extras before any request', async () => {
    let requests = 0;
    const endpoint = await serve((_req, res) => {
      requests++;
      json(res, page);
    });
    const p = provider(endpoint);
    await expect(
      p.readPage({
        ...input,
        request: {
          ...input.request,
          sourceId: 'e1000000-0000-4000-8000-000000000002',
        },
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(
      p.readPage({
        ...input,
        request: { ...input.request, url: endpoint } as typeof input.request,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toBe(0);
  });
  it.each([301, 302, 303, 307, 308])(
    'never follows redirect %i or forwards credentials',
    async (status) => {
      let reached = false;
      const target = await serve((_req, res) => {
        reached = true;
        json(res, page);
      });
      const endpoint = await serve((_req, res) => {
        res.writeHead(status, { location: target });
        res.end('synthetic private error');
      });
      await expect(
        provider(endpoint, { authorization: 'Bearer synthetic-only' }).readPage(
          input,
        ),
      ).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE',
        message: 'SOURCE_UNAVAILABLE',
      });
      expect(reached).toBe(false);
    },
  );
  it.each([401, 403, 429, 500, 206])(
    'returns a stable failure for status %i, never its body',
    async (status) => {
      const endpoint = await serve((_req, res) => {
        res.writeHead(status);
        res.end('synthetic private error');
      });
      const code =
        status === 401 || status === 403
          ? 'SOURCE_ACCESS_DENIED'
          : 'SOURCE_UNAVAILABLE';
      await expect(provider(endpoint).readPage(input)).rejects.toMatchObject({
        code,
        message: code,
      });
    },
  );
  it('rejects a declared oversized body before reading it', async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '999999',
      });
      res.flushHeaders();
    });
    await expect(
      provider(endpoint, { maxResponseBytes: 128 }).readPage(input),
    ).rejects.toMatchObject({ code: 'INVALID_METADATA' });
  });
  it.each([false, true])(
    'bounds the decoded response bytes (gzip=%s)',
    async (compressed) => {
      const payload = JSON.stringify({ padding: 'x'.repeat(4096) });
      const endpoint = await serve((_req, res) => {
        res.setHeader('content-type', 'application/json');
        if (compressed) res.setHeader('content-encoding', 'gzip');
        res.write(compressed ? gzipSync(payload) : payload);
        res.end();
      });
      await expect(
        provider(endpoint, { maxResponseBytes: 256 }).readPage(input),
      ).rejects.toMatchObject({ code: 'INVALID_METADATA' });
    },
  );
  it.each(['before-headers', 'during-body'])('times out %s', async (phase) => {
    const endpoint = await serve((_req, res) => {
      if (phase === 'during-body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
      }
    });
    await expect(
      provider(endpoint, { timeoutMs: 100 }).readPage(input),
    ).rejects.toMatchObject({
      code: 'SOURCE_TIMEOUT',
      message: 'SOURCE_TIMEOUT',
    });
  });
  it('aborts an in-flight body after caller cancellation', async () => {
    const caller = new AbortController();
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const endpoint = await serve((_req, res) => {
      res.once('close', closed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{', () => {
        setTimeout(() => caller.abort(), 20);
      });
    });
    await expect(
      provider(endpoint).readPage({ ...input, signal: caller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await disconnected;
  });
  it('never requests when already cancelled', async () => {
    let reached = false;
    const endpoint = await serve((_req, res) => {
      reached = true;
      json(res, page);
    });
    await expect(
      provider(endpoint).readPage({ ...input, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(reached).toBe(false);
  });
  it.each([
    ['text/html', '<html>login</html>'],
    ['application/json', '{not-json'],
    ['application/json', Buffer.from([0xff])],
  ])('rejects non-JSON or invalid UTF8: %s', async (type, body) => {
    const endpoint = await serve((_req, res) => {
      res.setHeader('content-type', type);
      res.end(body);
    });
    await expect(provider(endpoint).readPage(input)).rejects.toMatchObject({
      code: 'INVALID_METADATA',
      message: 'INVALID_METADATA',
    });
  });
  it.each([
    { endpoint: 'http://provider.example/metadata' },
    { endpoint: 'https://name:password@provider.example/metadata' },
    { endpoint: 'https://provider.example/metadata?token=example' },
    { endpoint: 'https://provider.example/metadata#fragment' },
    { endpoint: 'file:///tmp/data.json' },
    { timeoutMs: 0 },
    { timeoutMs: 30001 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1048577 },
  ])('rejects unsafe host configuration %j', (extra) => {
    expect(
      () =>
        new ExternalMetadataHttpProvider({
          sourceId,
          endpoint: 'https://provider.example/metadata',
          ...extra,
        }),
    ).toThrow('EXTERNAL_METADATA_HTTP_CONFIGURATION_INVALID');
  });
  it('requires explicit loopback test opt-in for unencrypted HTTP', () => {
    expect(
      () =>
        new ExternalMetadataHttpProvider({
          sourceId,
          endpoint: 'http://127.0.0.1:9876/metadata',
        }),
    ).toThrow('EXTERNAL_METADATA_HTTP_CONFIGURATION_INVALID');
  });
});

describe('external reader with actual isolated HTTP provider', () => {
  const actorId = 'e1000000-0000-4000-8000-000000000002';
  const projectId = 'e1000000-0000-4000-8000-000000000003';
  const tenantId = 'e1000000-0000-4000-8000-000000000004';
  const now = Date.parse('2026-09-20T00:00:00Z');
  const context: DataCapabilityExecutionContext = {
    principal: {
      actorId,
      actorType: 'human',
      authUserId: actorId,
      sessionId: sourceId,
      authenticationMethod: 'supabase_jwt',
    },
    authorization: {
      tenantId,
      projectId,
      purpose: 'synthetic-test',
      roles: ['reader'],
      scopes: ['data.catalog.read'],
      maxSecurityLevel: 'L2_RESTRICTED',
      authzVersion: 1,
    },
    effectiveMaxSecurityLevel: 'L2_RESTRICTED',
    traceId: 'e'.repeat(32),
    auditLevel: 'STANDARD',
    timeoutMs: 30000,
    signal: input.signal,
  };
  const grant = {
    sourceId,
    actorId,
    actorType: 'human',
    tenantId,
    projectId,
    purpose: 'synthetic-test',
    authzVersion: 1,
    policyVersion: 'synthetic-v1',
    expiresAt: '2026-09-21T00:00:00Z',
    fromYear: 2021,
    toYear: 2025,
    fields: ['stationCode', 'year'],
    securityLevel: 'L2_RESTRICTED',
  };
  it('strips disallowed values after a real HTTP response and refuses the next page after revocation', async () => {
    let permission: unknown = grant;
    let requests = 0;
    const endpoint = await serve((_req, res) => {
      requests++;
      json(res, {
        items: [
          {
            ...page.items[0],
            value: 999,
            province: 'not-granted',
            longitude: 116,
            token: 'synthetic-only',
          },
        ],
        total: 2,
      });
    });
    const reader = new ExternalMetadataReader({
      provider: provider(endpoint),
      access: { resolve: () => Promise.resolve(permission) },
      now: () => now,
    });
    const first = await reader.read(input.request, context);
    expect(first).toMatchObject({
      items: page.items,
      nextOffset: 1,
      status: 'AVAILABLE',
    });
    permission = null;
    await expect(
      reader.read({ ...input.request, offset: first.nextOffset }, context),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(requests).toBe(1);
  });
  it('discards an HTTP page when the grant is revoked during the fetch', async () => {
    let permission: unknown = grant;
    const endpoint = await serve((_req, res) => {
      permission = null;
      json(res, page);
    });
    const reader = new ExternalMetadataReader({
      provider: provider(endpoint),
      access: { resolve: () => Promise.resolve(permission) },
      now: () => now,
    });
    await expect(reader.read(input.request, context)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });
  it.each([
    ['timeout', 'SOURCE_TIMEOUT'],
    ['rejected', 'SOURCE_ACCESS_DENIED'],
    ['malformed', 'INVALID_METADATA'],
  ])(
    'preserves the safe %s result through the reader without provider text',
    async (mode, code) => {
      const endpoint = await serve((_req, res) => {
        if (mode === 'timeout') return;
        res.writeHead(mode === 'rejected' ? 403 : 200, {
          'content-type': 'application/json',
        });
        res.end('synthetic private response');
      });
      const reader = new ExternalMetadataReader({
        provider: provider(endpoint, { timeoutMs: 100 }),
        access: { resolve: () => Promise.resolve(grant) },
        now: () => now,
      });
      await expect(reader.read(input.request, context)).rejects.toMatchObject({
        code,
        message: code,
      });
    },
  );
});
