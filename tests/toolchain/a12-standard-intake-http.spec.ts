import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_CAPABILITY_REGISTRY } from '../../packages/data-contracts/src/index.ts';
import {
  CandidateLoadTransportError,
  LOAD_PAGE_BYTES,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import {
  createA12StandardIntakeHttpAdapter,
  redactA12StandardIntakeReply,
  type A12StandardIntakeCapability,
  type A12StandardIntakeHttpAdapter,
  type A12StandardIntakeHttpOptions,
  type A12StandardIntakePutInput,
  type A12StandardIntakeRequest,
} from '../../apps/web/e2e-live/support/a12-standard-intake-http.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const uploadSessionId = '44444444-4444-4444-8444-444444444444';
const operationId = '55555555-5555-4555-8555-555555555555';
const ingestionId = '66666666-6666-4666-8666-666666666666';
const idempotencyKey = '77777777-7777-4777-8777-777777777777';
const eventId = '88888888-8888-4888-8888-888888888888';
const instant = '2026-10-06T00:00:00Z';
const syntheticBytes = Buffer.from('synthetic upload bytes 水');
const sha = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
const sourceSha = sha(syntheticBytes);
let apiPort = 0;
let storagePort = 0;
let api: ReturnType<typeof createServer>;
let storage: ReturnType<typeof createServer>;
let apiHandler: (req: IncomingMessage, res: ServerResponse) => void;
let storageHandler: (req: IncomingMessage, res: ServerResponse) => void;
let apiHits = 0;
let storageHits = 0;
const adapters: A12StandardIntakeHttpAdapter[] = [];
const options = (): A12StandardIntakeHttpOptions => ({
  apiOrigin: `http://127.0.0.1:${apiPort}`,
  taskApiPort: apiPort,
  storageOrigin: `http://127.0.0.1:${storagePort}`,
  taskStoragePort: storagePort,
  tenantId,
  projectId,
  purpose: 'web-console',
  accessToken: () => Promise.resolve('synthetic-token'),
});
function adapter(change: Partial<A12StandardIntakeHttpOptions> = {}) {
  const result = createA12StandardIntakeHttpAdapter({
    ...options(),
    ...change,
  });
  adapters.push(result);
  return result;
}
function uploadSession(status = 'OPEN') {
  return {
    uploadSessionId,
    tenantId,
    projectId,
    status,
    assetIds: [assetId],
    version: status === 'OPEN' ? 1 : 2,
    expiresAt: '2030-01-01T00:00:00Z',
    createdAt: instant,
    ...(status === 'COMPLETED' ? { completedAt: instant } : {}),
  };
}
function target() {
  return {
    assetId,
    method: 'PRESIGNED_PUT',
    uploadUrl: `http://127.0.0.1:${storagePort}/private-synthetic-path?X-Amz-Signature=private-signature`,
    headers: {
      'content-length': String(syntheticBytes.length),
      'content-type': 'application/octet-stream',
      'x-amz-meta-sha256': sourceSha,
    },
  };
}
const operation = () => ({
  operationId,
  tenantId,
  projectId,
  capabilityId: 'data.ingestion.create',
  status: 'WAITING_REVIEW',
  resource: `operation://${operationId}`,
  progressPercent: 50,
  version: 1,
  createdAt: instant,
  updatedAt: instant,
});
const event = () => ({
  eventId,
  operationId,
  sequence: 1,
  eventType: 'WAITING_REVIEW',
  status: 'WAITING_REVIEW',
  progressPercent: 50,
  operationVersion: 1,
  occurredAt: instant,
  message: '合成事件',
});
function output(id: A12StandardIntakeCapability) {
  if (id === 'data.uploadSession.create')
    return { uploadSession: uploadSession(), uploadTargets: [target()] };
  if (id === 'data.uploadSession.complete')
    return { uploadSession: uploadSession('COMPLETED') };
  if (id === 'data.ingestion.create')
    return { ingestionId, operation: operation() };
  if (id === 'data.operation.get') return operation();
  if (id === 'data.operation.events')
    return { items: [event()], nextCursor: 'synthetic-cursor' };
  return {
    ingestion: {
      ingestionId,
      tenantId,
      projectId,
      assetIds: [assetId],
      intendedUses: ['analysis'],
      requestedSecurityLevel: 'L1_INTERNAL',
      state: 'REVIEW_REQUIRED',
      operationId,
      version: 2,
      createdAt: instant,
      updatedAt: instant,
    },
    candidateReference: {
      kind: 'ingestion-candidate',
      ingestionId,
      processingBatchId: uploadSessionId,
      reviewHash: 'a'.repeat(64),
    },
  };
}
function input(
  id: A12StandardIntakeCapability,
): A12StandardIntakeRequest<A12StandardIntakeCapability> {
  if (id === 'data.uploadSession.create')
    return {
      capabilityId: id,
      input: {
        ownerProjectId: projectId,
        objects: [
          {
            fileName: 'synthetic.bin',
            mediaType: 'application/octet-stream',
            sizeBytes: syntheticBytes.length,
            sha256: sourceSha,
          },
        ],
        preferredMode: 'PRESIGNED_PUT',
      },
      idempotencyKey,
    };
  if (id === 'data.uploadSession.complete')
    return {
      capabilityId: id,
      input: {
        uploadSessionId,
        expectedVersion: 1,
        objects: [
          { assetId, sizeBytes: syntheticBytes.length, sha256: sourceSha },
        ],
      },
      idempotencyKey,
      ifMatch: '"v1"',
    };
  if (id === 'data.ingestion.create')
    return {
      capabilityId: id,
      input: {
        ownerProjectId: projectId,
        assetIds: [assetId],
        intendedUses: ['analysis'],
        requestedSecurityLevel: 'L1_INTERNAL',
      },
      idempotencyKey,
    };
  if (id === 'data.ingestion.get')
    return { capabilityId: id, input: { ingestionId } };
  return {
    capabilityId: id,
    input: {
      operationId,
      ...(id === 'data.operation.events'
        ? { first: 50, after: 'old-cursor' }
        : {}),
    },
  };
}
const get = () => input('data.operation.get');
const put = (): A12StandardIntakePutInput => ({
  target: target(),
  bytes: syntheticBytes,
  sizeBytes: syntheticBytes.length,
  sha256: sourceSha,
});
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
async function failure(task: Promise<unknown>, kind: string) {
  try {
    await task;
    throw new Error('Expected a sanitized transport failure.');
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateLoadTransportError);
    expect(error).toMatchObject({ kind });
    expect(String(error)).not.toContain('private-');
  }
}
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
beforeEach(async () => {
  apiHits = 0;
  storageHits = 0;
  apiHandler = (_req, res) => json(res, 200, operation());
  storageHandler = (_req, res) => {
    res.writeHead(200, { etag: '"synthetic-etag"' });
    res.end();
  };
  api = createServer((req, res) => {
    apiHits += 1;
    apiHandler(req, res);
  });
  storage = createServer((req, res) => {
    storageHits += 1;
    storageHandler(req, res);
  });
  apiPort = await listen(api);
  storagePort = await listen(storage);
});
afterEach(async () => {
  for (const value of adapters.splice(0)) value.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of [api, storage]) {
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('task-private standard intake HTTP evidence, never scanner certification', () => {
  it.each([
    'data.uploadSession.create',
    'data.uploadSession.complete',
    'data.ingestion.create',
    'data.ingestion.get',
    'data.operation.get',
  ] as const)(
    'uses actual registered method/path/status and validates the %s DTO',
    async (id) => {
      const request = input(id);
      const definition = DATA_CAPABILITY_REGISTRY[id];
      let received = '';
      apiHandler = (req, res) => {
        expect(req.method).toBe(definition.restMapping.method);
        expect(req.url).toBe(
          definition.restMapping.path
            .replace(':uploadSessionId', uploadSessionId)
            .replace(':ingestionId', ingestionId)
            .replace(':operationId', operationId),
        );
        expect(req.headers.authorization).toBe('Bearer synthetic-token');
        expect(req.headers['x-wiser-tenant-id']).toBe(tenantId);
        expect(req.headers['x-wiser-project-id']).toBe(projectId);
        expect(req.headers['x-wiser-purpose']).toBe('web-console');
        if (definition.kind === 'command')
          expect(req.headers['idempotency-key']).toBe(idempotencyKey);
        if (id === 'data.uploadSession.complete')
          expect(req.headers['if-match']).toBe('"v1"');
        req.on('data', (chunk) => {
          received += chunk.toString();
        });
        req.on('end', () =>
          json(res, definition.restMapping.successStatus, output(id)),
        );
      };
      // Fixture schemas are independently admitted before the adapter runs.
      expect(definition.outputSchema.safeParse(output(id)).success).toBe(true);
      const reply = await adapter().send(request);
      expect(reply.body).toEqual(output(id));
      expect(reply.wireBytes).toBe(
        Buffer.byteLength(JSON.stringify(output(id))),
      );
      expect(reply.wireSha256).toBe(sha(JSON.stringify(output(id))));
      expect(apiHits).toBe(1);
      if (definition.kind === 'query') expect(received).toBe('');
      else
        expect(JSON.parse(received)).toMatchObject(
          id === 'data.uploadSession.complete'
            ? { expectedVersion: 1 }
            : request.input,
        );
    },
  );

  it('parses a chunk-split UTF8 SSE snapshot with actual id/type/data and cursor', async () => {
    const wire = `id: ${eventId}\nevent: WAITING_REVIEW\ndata: ${JSON.stringify(event())}\n\n`;
    const bytes = Buffer.from(wire);
    const chinese = bytes.indexOf(Buffer.from('合'));
    apiHandler = (req, res) => {
      expect(req.url).toBe(
        `/api/data/v1/operations/${operationId}/events?first=50&after=old-cursor`,
      );
      expect(req.headers.accept).toBe('text/event-stream');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'x-next-cursor': 'synthetic-cursor',
      });
      res.write(bytes.subarray(0, chinese + 1));
      res.write(bytes.subarray(chinese + 1, chinese + 2));
      res.end(bytes.subarray(chinese + 2));
    };
    const result = await adapter().send(input('data.operation.events'));
    expect(result.body).toEqual(output('data.operation.events'));
    expect(result.wireBytes).toBe(bytes.length);
    expect(result.wireSha256).toBe(sha(bytes));
  });

  it('retains an empty finite SSE snapshot as an actual empty event page', async () => {
    apiHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(': snapshot\n\n');
    };
    const result = await adapter().send(input('data.operation.events'));
    expect(result.body).toEqual({ items: [] });
    expect(result.wireSha256).toBe(sha(': snapshot\n\n'));
  });

  it.each([
    'wrong-id',
    'wrong-type',
    'truncated-frame',
    'json-page',
    'bad-cursor',
    'duplicate-data',
  ] as const)('rejects malformed actual SSE snapshot %s', async (kind) => {
    apiHandler = (_req, res) => {
      res.writeHead(200, {
        'content-type':
          kind === 'json-page' ? 'application/json' : 'text/event-stream',
        ...(kind === 'bad-cursor' ? { 'x-next-cursor': 'x'.repeat(2049) } : {}),
      });
      if (kind === 'json-page')
        return res.end(JSON.stringify(output('data.operation.events')));
      const wire = `id: ${kind === 'wrong-id' ? assetId : eventId}\nevent: ${kind === 'wrong-type' ? 'STARTED' : 'WAITING_REVIEW'}\ndata: ${JSON.stringify(event())}${kind === 'duplicate-data' ? '\ndata: {}' : ''}${kind === 'truncated-frame' ? '' : '\n\n'}`;
      res.end(wire);
    };
    await failure(adapter().send(input('data.operation.events')), 'invalid');
  });

  it.each([
    'missing-idempotency',
    'bad-idempotency',
    'missing-if-match',
    'version-mismatch',
    'unknown-capability',
    'query-command-header',
  ] as const)(
    'rejects invalid immutable standard request %s before token/network',
    async (kind) => {
      const token = vi.fn(() => Promise.resolve('synthetic-token'));
      const value = adapter({ accessToken: token });
      const request = {
        ...input('data.uploadSession.complete'),
      } as A12StandardIntakeRequest<A12StandardIntakeCapability>;
      if (kind === 'missing-idempotency')
        delete (request as { idempotencyKey?: string }).idempotencyKey;
      if (kind === 'bad-idempotency')
        (request as { idempotencyKey?: string }).idempotencyKey =
          'private-invalid-key';
      if (kind === 'missing-if-match')
        delete (request as { ifMatch?: string }).ifMatch;
      if (kind === 'version-mismatch')
        (request as { ifMatch?: string }).ifMatch = '"v2"';
      if (kind === 'unknown-capability')
        (request as { capabilityId: string }).capabilityId =
          'data.ingestion.approve';
      if (kind === 'query-command-header') {
        (request as { capabilityId: string }).capabilityId =
          'data.operation.get';
        (request as { input: unknown }).input = { operationId };
      }
      await failure(value.send(request), 'invalid');
      expect(token).not.toHaveBeenCalled();
      expect(apiHits).toBe(0);
    },
  );

  it('rejects option and nested input accessors without evaluating them', async () => {
    const getter = vi.fn(() => 'private-accessor');
    const bad = { ...options() };
    Object.defineProperty(bad, 'purpose', { get: getter });
    expect(() => createA12StandardIntakeHttpAdapter(bad)).toThrow(
      CandidateLoadTransportError,
    );
    const nested = { operationId };
    Object.defineProperty(nested, 'operationId', { get: getter });
    await failure(
      adapter().send({ capabilityId: 'data.operation.get', input: nested }),
      'invalid',
    );
    expect(getter).not.toHaveBeenCalled();
    expect(apiHits).toBe(0);
  });

  it('snapshots options and input before awaiting a late access token', async () => {
    let release!: (token: string) => void;
    const token = new Promise<string>((resolve) => {
      release = resolve;
    });
    const config = { ...options(), accessToken: () => token };
    const value = createA12StandardIntakeHttpAdapter(config);
    adapters.push(value);
    const data = { operationId };
    const task = value.send({
      capabilityId: 'data.operation.get',
      input: data,
    });
    config.apiOrigin = 'http://127.0.0.1:1';
    config.tenantId = assetId;
    data.operationId = assetId;
    apiHandler = (req, res) => {
      expect(req.url).toBe(`/api/data/v1/operations/${operationId}`);
      expect(req.headers['x-wiser-tenant-id']).toBe(tenantId);
      json(res, 200, operation());
    };
    release('synthetic-token');
    await task;
    expect(apiHits).toBe(1);
  });

  it.each([
    'redirect',
    'wrong-status',
    'wrong-schema',
    'compressed',
    'overflow',
    'partial',
    'utf8',
  ] as const)(
    'rejects unsafe API response %s and clears its request',
    async (kind) => {
      apiHandler = (_req, res) => {
        if (kind === 'redirect') {
          res.writeHead(302, {
            location: `http://127.0.0.1:${storagePort}/private-token`,
          });
          return res.end('private-error');
        }
        if (kind === 'wrong-status') return json(res, 201, operation());
        if (kind === 'wrong-schema') return json(res, 200, { verified: true });
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(kind === 'compressed' ? { 'content-encoding': 'gzip' } : {}),
          ...(kind === 'partial' ? { 'content-length': '10000' } : {}),
        });
        if (kind === 'overflow')
          return res.end(' '.repeat(LOAD_PAGE_BYTES + 1));
        if (kind === 'partial') {
          res.write('{');
          return res.socket!.destroy();
        }
        if (kind === 'utf8') return res.end(Buffer.from([0xff]));
        res.end(JSON.stringify(operation()));
      };
      const value = adapter();
      await failure(
        value.send(get()),
        kind === 'partial' ? 'unavailable' : 'invalid',
      );
      expect(value.diagnostics().activeRequests).toBe(0);
      expect(storageHits).toBe(0);
    },
  );

  it.each([401, 403, 404, 409, 429, 503])(
    'maps API %i to a bounded sanitized cause',
    async (status) => {
      apiHandler = (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('private-server-credential');
      };
      await failure(
        adapter().send(get()),
        status === 401 || status === 403
          ? 'denied'
          : status === 404 || status === 409
            ? 'stale'
            : 'unavailable',
      );
    },
  );

  it('uploads the copied admitted bytes only to the fixed storage origin without API credentials', async () => {
    let received = Buffer.alloc(0);
    storageHandler = (req, res) => {
      expect(req.method).toBe('PUT');
      expect(req.url).toContain('X-Amz-Signature=private-signature');
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers['x-wiser-tenant-id']).toBeUndefined();
      expect(req.headers['content-length']).toBe(String(syntheticBytes.length));
      req.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
      });
      req.on('end', () => {
        res.writeHead(200, { etag: '"synthetic-etag"' });
        res.end('ok');
      });
    };
    const body = Uint8Array.from(syntheticBytes);
    const definition = put();
    const task = adapter().put({ ...definition, bytes: body });
    body.fill(0);
    const result = await task;
    expect(received).toEqual(syntheticBytes);
    expect(result.requestBytes).toBe(syntheticBytes.length);
    expect(result.requestSha256).toBe(sourceSha);
    expect(result.wireSha256).toBe(sha('ok'));
    expect(result.etag).toBe('"synthetic-etag"');
  });

  it.each([
    'foreign-origin',
    'userinfo',
    'fragment',
    'multipart',
    'authorization',
    'cookie',
    'host',
    'length',
    'digest',
    'overflow',
  ] as const)('rejects unsafe storage input %s before HTTP', async (kind) => {
    const data = put();
    const t = { ...target(), headers: { ...target().headers } };
    if (kind === 'foreign-origin')
      t.uploadUrl = `http://127.0.0.1:${apiPort}/private-path`;
    if (kind === 'userinfo')
      t.uploadUrl = `http://private-password@127.0.0.1:${storagePort}/private-path`;
    if (kind === 'fragment') t.uploadUrl += '#private-fragment';
    if (kind === 'multipart') (t as { method: string }).method = 'MULTIPART';
    if (kind === 'authorization' || kind === 'cookie' || kind === 'host')
      (t.headers as Record<string, string>)[kind] = 'private-credential';
    if (kind === 'length') t.headers['content-length'] = '1';
    const bytes =
      kind === 'overflow' ? new Uint8Array(32 * 1024 * 1024 + 1) : data.bytes;
    await failure(
      adapter().put({
        ...data,
        target: t,
        bytes,
        ...(kind === 'digest' ? { sha256: 'a'.repeat(64) } : {}),
      }),
      'invalid',
    );
    expect(storageHits).toBe(0);
    expect(apiHits).toBe(0);
  });

  it.each(['redirect', 'overflow', 'partial'] as const)(
    'bounds and cleans storage response %s',
    async (kind) => {
      storageHandler = (_req, res) => {
        if (kind === 'redirect') {
          res.writeHead(307, {
            location: `http://127.0.0.1:${apiPort}/private-url`,
          });
          return res.end();
        }
        res.writeHead(
          200,
          kind === 'partial' ? { 'content-length': '10000' } : {},
        );
        if (kind === 'partial') {
          res.write('o');
          return res.socket!.destroy();
        }
        res.end('x'.repeat(65537));
      };
      const value = adapter();
      await failure(
        value.put(put()),
        kind === 'partial' ? 'unavailable' : 'invalid',
      );
      expect(value.diagnostics().activeRequests).toBe(0);
      expect(apiHits).toBe(0);
    },
  );

  it('produces only an explicitly redacted DTO projection and the actual wire digest', async () => {
    const response = output('data.uploadSession.create');
    apiHandler = (_req, res) => json(res, 201, response);
    const reply = await adapter().send(input('data.uploadSession.create'));
    const projected = redactA12StandardIntakeReply(reply);
    const serialized = JSON.stringify(projected);
    for (const secret of [
      'private-synthetic-path',
      'private-signature',
      'X-Amz',
      `127.0.0.1:${storagePort}`,
      'content-length',
      sourceSha,
      'synthetic-token',
    ])
      expect(serialized).not.toContain(secret);
    expect(projected.kind).toBe('redacted-actual-http-projection');
    expect(projected.wireSha256).toBe(sha(JSON.stringify(response)));
    expect(projected.projectionSha256).toBe(
      sha(JSON.stringify(projected.body)),
    );
    expect(
      DATA_CAPABILITY_REGISTRY[
        'data.uploadSession.create'
      ].outputSchema.safeParse(projected.body).success,
    ).toBe(true);
    expect(projected.body).toMatchObject({
      uploadTargets: [{ uploadUrl: 'https://redacted.invalid/', headers: {} }],
    });
    expect(reply.body).toEqual(response);
    expect(projected.redactedFields).toEqual([
      'body.uploadTargets[0].uploadUrl',
      'body.uploadTargets[0].headers',
    ]);
    expect(serialized).not.toContain('verified');
  });

  it.each([
    'data.uploadSession.create',
    'data.uploadSession.complete',
    'data.ingestion.create',
  ] as const)(
    'keeps the registered %s deadline through token wait and clears the timer',
    async (id) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const value = adapter({
        accessToken: () => new Promise<string>(() => {}),
      });
      const pending = failure(value.send(input(id)), 'unavailable');
      await vi.advanceTimersByTimeAsync(
        DATA_CAPABILITY_REGISTRY[id].timeout - 1,
      );
      expect(value.diagnostics().activeRequests).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(value.diagnostics().activeRequests).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(apiHits).toBe(0);
    },
  );

  it('close cancels a pending token, ignores late token/abort and never opens a socket', async () => {
    let release!: (value: string) => void;
    const token = new Promise<string>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const value = adapter({
      accessToken: () => token,
      signal: controller.signal,
    });
    const pending = failure(value.send(get()), 'cancelled');
    value.close();
    release('private-late-token');
    controller.abort();
    await pending;
    await pause(5);
    expect(apiHits).toBe(0);
    expect(value.diagnostics()).toEqual({ activeRequests: 0, closed: true });
    await failure(value.put(put()), 'cancelled');
  });

  it('preserves token stale cause and cancellation during response streaming', async () => {
    const denied = adapter({
      accessToken: () =>
        Promise.reject(new CandidateLoadTransportError('stale')),
    });
    await failure(denied.send(get()), 'stale');
    expect(apiHits).toBe(0);
    let started!: () => void;
    const observed = new Promise<void>((resolve) => {
      started = resolve;
    });
    apiHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      started();
    };
    const controller = new AbortController();
    const value = adapter({ signal: controller.signal });
    const pending = failure(value.send(get()), 'cancelled');
    await observed;
    controller.abort();
    value.close();
    await pending;
    expect(value.diagnostics()).toEqual({ activeRequests: 0, closed: true });
  });
});
