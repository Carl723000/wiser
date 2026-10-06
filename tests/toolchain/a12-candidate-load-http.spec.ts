import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CandidateLoadTransportError,
  LOAD_PAGE_BYTES,
  canonicalLoadContent,
  pageFingerprint,
  runCandidateLoadCondition,
  type FrozenCandidateDataset,
  type LoadAction,
  type LoadPage,
  type LoadRequest,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import {
  createCandidateLoadHttpAdapter,
  type CandidateLoadHttpAdapter,
  type CandidateLoadHttpOptions,
} from '../../apps/web/e2e-live/support/a12-candidate-load-http.ts';
import {
  runCandidateLoadTraversal,
  traversalContentDigest,
} from '../../apps/web/e2e-live/support/a12-candidate-load-traversal.ts';
import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordPageSchema,
} from '../../packages/data-contracts/src/index.ts';

// Assigned only by this case's own loopback server, without probing other ports.
let PORT = 0;
const uuid = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const ref = {
  kind: 'ingestion-candidate' as const,
  ingestionId: uuid,
  processingBatchId: assetId,
  reviewHash: 'a'.repeat(64),
};
const options = (): CandidateLoadHttpOptions => ({
  apiOrigin: `http://127.0.0.1:${PORT}`,
  taskApiPort: PORT,
  tenantId: uuid,
  projectId: assetId,
  purpose: 'web-console',
  accessToken: () => Promise.resolve('synthetic-token'),
});
const request = (action: LoadRequest['action'] = 'get'): LoadRequest => ({
  method: 'GET',
  action,
  reference: { ...ref },
  first: 200,
  ...(action === 'get' ? {} : { assetId }),
});
const adapters: CandidateLoadHttpAdapter[] = [];
function adapter(change: Partial<CandidateLoadHttpOptions> = {}) {
  const value = createCandidateLoadHttpAdapter({ ...options(), ...change });
  adapters.push(value);
  return value;
}
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let server: ReturnType<typeof createServer>;
let hits = 0;
function json(res: ServerResponse, value: unknown) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalLoadContent(value)))
    .digest('hex');
function sourceFixture() {
  // Independent synthetic source literals, frozen BEFORE the HTTP server reads.
  // The S10 label is the driver track type, not a claim of actual S10 scale/intake.
  const columns = [{ key: 'value', label: '合成原值' }];
  const records = [
    {
      recordId: uuid,
      assetId,
      index: 1,
      sourceId: null,
      values: { value: null },
      hasGeometry: false,
    },
    {
      recordId: '33333333-3333-4333-8333-333333333333',
      assetId,
      index: 3,
      sourceId: null,
      values: { value: '' },
      hasGeometry: true,
    },
  ];
  const features = [
    {
      recordId: records[1]!.recordId,
      assetId,
      index: 3,
      sourceId: null,
      sourceCrs: null,
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [116, 40] },
          { type: 'Point', coordinates: [117, 41] },
        ],
      },
    },
  ];
  const asset = {
    assetId,
    status: 'READY',
    sourceHash: 'b'.repeat(64),
    recordCount: records.length,
    featureCount: features.length,
    reason: null,
  };
  const batch = IngestionCandidateBatchSchema.parse({
    reference: ref,
    status: 'READY',
    parserVersion: 'synthetic-http-fixture',
    createdAt: '2026-10-06T00:00:00Z',
    assets: [asset],
  });
  const pages = {
    get: IngestionCandidateAssetPageSchema.parse({
      ...batch,
      totalAssetCount: 1,
      knownRecordCount: records.length,
      knownFeatureCount: features.length,
      unknownAssetCount: 0,
      nextCursor: null,
    }),
    records: IngestionCandidateRecordPageSchema.parse({
      reference: ref,
      assetId,
      columns,
      records,
      nextCursor: null,
    }),
    geometry: IngestionCandidateGeometryPageSchema.parse({
      reference: ref,
      assetId,
      crs: 'EPSG:4326',
      features,
      nextCursor: null,
    }),
  };
  const frozen: FrozenCandidateDataset = {
    dataset: 'SYNTHETIC-S10',
    provenance: {
      kind: 'standard-intake-http',
      receiptSha256: 'c'.repeat(64),
      inventorySha256: 'd'.repeat(64),
    },
    batch,
    materials: [
      {
        assetId,
        columns,
        recordsDigest: traversalContentDigest(
          'records',
          columns,
          pages.records.records,
          fingerprint,
        ),
        geometryDigest: traversalContentDigest(
          'geometry',
          [],
          pages.geometry.features,
          fingerprint,
        ),
      },
    ],
    firstPages: (['get', 'records', 'geometry'] as const).flatMap((action) =>
      ([50, 200] as const).map((first) => ({
        action,
        first,
        assetId: action === 'get' ? null : assetId,
        digest: pageFingerprint(pages[action], fingerprint),
      })),
    ),
  };
  handler = (req, res) => {
    hits += 1;
    const path = new URL(req.url!, options().apiOrigin).pathname;
    const action: LoadAction = path.endsWith('/records')
      ? 'records'
      : path.endsWith('/geometry')
        ? 'geometry'
        : 'get';
    json(res, structuredClone(pages[action]) satisfies LoadPage);
  };
  return frozen;
}
async function failure(work: Promise<unknown>, kind: string) {
  const error: unknown = await work.then(
    () => null,
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(CandidateLoadTransportError);
  expect((error as CandidateLoadTransportError).kind).toBe(kind);
  expect((error as Error).message).toBe(
    'Candidate measurement could not complete',
  );
  return error;
}

describe('A12 raw public GET HTTP adapter', { concurrent: false }, () => {
  beforeEach(async () => {
    hits = 0;
    handler = (_req, res) => {
      hits += 1;
      json(res, { value: '合成' });
    };
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        PORT = (server.address() as AddressInfo).port;
        server.off('error', reject);
        resolve();
      });
    });
    expect((server.address() as AddressInfo).port).toBe(PORT);
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const item of adapters.splice(0)) item.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.removeAllListeners('listening');
  });

  it.each(['get', 'records', 'geometry'] as const)(
    'serializes the registered %s GET without a body and returns actual bytes',
    async (action) => {
      let received: IncomingMessage | undefined;
      let bodyBytes = 0;
      handler = (req, res) => {
        hits += 1;
        received = req;
        req.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.length;
        });
        req.on('end', () => json(res, { value: '合成' }));
      };
      const sent = { ...request(action), after: 'synthetic+/cursor=' };
      const result = await adapter().send(sent);
      expect(result).toEqual({
        boundary: 'api-http',
        status: 200,
        contentType: 'application/json; charset=utf-8',
        wireBytes: Buffer.byteLength(JSON.stringify({ value: '合成' })),
        body: { value: '合成' },
      });
      expect(received?.method).toBe('GET');
      const url = new URL(received!.url!, options().apiOrigin);
      const tail = action === 'get' ? '' : `/${assetId}/${action}`;
      expect(url.pathname).toBe(
        `/api/data/v1/ingestions/${uuid}/candidates/${assetId}${tail}`,
      );
      expect([...url.searchParams.keys()].sort()).toEqual([
        'after',
        'first',
        'kind',
        'reviewHash',
      ]);
      expect(url.searchParams.get('after')).toBe(sent.after);
      expect(url.searchParams.get('first')).toBe('200');
      expect(received?.headers.authorization).toBe('Bearer synthetic-token');
      expect(received?.headers['x-wiser-tenant-id']).toBe(uuid);
      expect(received?.headers['x-wiser-project-id']).toBe(assetId);
      expect(received?.headers['x-wiser-purpose']).toBe('web-console');
      expect(received?.headers['accept-encoding']).toBe('identity');
      expect(bodyBytes).toBe(0);
      expect(hits).toBe(1);
    },
  );

  it.each([
    () => ({ apiOrigin: `http://example.invalid:${PORT}` }),
    () => ({ apiOrigin: `http://localhost:${PORT}` }),
    () => ({
      apiOrigin: `http://127.0.0.1:${PORT === 65535 ? PORT - 1 : PORT + 1}`,
    }),
    () => ({ apiOrigin: `http://user:pass@127.0.0.1:${PORT}` }),
    () => ({ apiOrigin: `http://127.0.0.1:${PORT}/path` }),
    () => ({ apiOrigin: `http://127.0.0.1:${PORT}?query=1` }),
    () => ({ taskApiPort: 0 }),
    () => ({ tenantId: 'bad' }),
    () => ({ purpose: 'bad\r\nheader' }),
  ])(
    'rejects an unadmitted target or context before sending (%#)',
    (change) => {
      expect(() => adapter(change())).toThrow(CandidateLoadTransportError);
      expect(hits).toBe(0);
    },
  );

  it.each([
    { ...request(), first: 1 },
    { ...request('records'), assetId: undefined },
    { ...request(), method: 'POST' },
    { ...request(), reference: { ...ref, kind: 'catalog-version' } },
    { ...request(), reference: { ...ref, ingestionId: 'bad' } },
    { ...request(), after: 'x'.repeat(2049) },
  ])(
    'rejects invalid immutable request input before HTTP (%#)',
    async (bad) => {
      await failure(adapter().send(bad as LoadRequest), 'invalid');
      expect(hits).toBe(0);
    },
  );

  it('never follows redirects or consumes an error body', async () => {
    handler = (_req, res) => {
      hits += 1;
      res.writeHead(302, {
        location: `http://127.0.0.1:${PORT}/forbidden`,
        'content-type': 'text/html',
      });
      res.end('synthetic private response');
    };
    const result = await adapter().send(request());
    expect(result).toEqual({
      boundary: 'api-http',
      status: 302,
      contentType: 'text/html',
      wireBytes: 0,
      body: null,
    });
    expect(hits).toBe(1);
  });
  it.each([401, 403, 404, 409, 410, 422, 499, 503])(
    'preserves HTTP %s without parsing errors',
    async (status) => {
      handler = (_req, res) => {
        res.writeHead(status);
        res.end('not JSON');
      };
      expect(await adapter().send(request())).toEqual({
        boundary: 'api-http',
        status,
        contentType: '',
        wireBytes: 0,
        body: null,
      });
    },
  );
  it.each([
    { 'content-type': 'text/html' },
    { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    {
      'content-type': 'application/json',
      'content-length': String(LOAD_PAGE_BYTES + 1),
    },
    { 'content-type': 'application/json', 'content-length': 'not-a-number' },
  ])(
    'rejects invalid response headers and disposes bytes (%#)',
    async (headers) => {
      handler = (_req, res) => {
        res.writeHead(200, headers);
        res.end('{}');
      };
      await failure(adapter().send(request()), 'invalid');
    },
  );
  it('enforces the actual chunked three MiB boundary', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('"');
      res.write('x'.repeat(LOAD_PAGE_BYTES));
      res.end('"');
    };
    const value = adapter();
    await failure(value.send(request()), 'invalid');
    expect(value.diagnostics().activeRequests).toBe(0);
  });
  it('accepts exactly three MiB without rewriting original null empty or missing values', async () => {
    const text = JSON.stringify({ value: 'x'.repeat(LOAD_PAGE_BYTES - 12) });
    expect(Buffer.byteLength(text)).toBe(LOAD_PAGE_BYTES);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
    };
    const result = await adapter().send(request());
    expect(result.wireBytes).toBe(LOAD_PAGE_BYTES);
    expect((result.body as { value: string }).value.length).toBe(
      LOAD_PAGE_BYTES - 12,
    );
  });
  it('fatal-decodes a split UTF8 sequence and retains original shapes', async () => {
    const original = { cells: [null, '', {}, ['合成']] };
    const bytes = Buffer.from(JSON.stringify(original));
    const cut = bytes.indexOf(Buffer.from('合')) + 1;
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(bytes.subarray(0, cut));
      setImmediate(() => res.end(bytes.subarray(cut)));
    };
    expect((await adapter().send(request())).body).toEqual(original);
  });
  it.each([
    Buffer.from([0x22, 0xc3, 0x22]),
    Buffer.from('{'),
    Buffer.from([0x22, 0xc3]),
  ])('rejects well-ended malformed JSON or UTF8 (%#)', async (body) => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    };
    await failure(adapter().send(request()), 'invalid');
  });
  it('rejects an incomplete response even if its JSON prefix parses', async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '200',
      });
      res.write('{}');
      setImmediate(() => res.destroy());
    };
    await failure(adapter().send(request()), 'unavailable');
  });
  it('aborts before dispatch without acquiring a token or connection', async () => {
    const controller = new AbortController();
    controller.abort();
    const token = vi.fn(options().accessToken);
    await failure(
      adapter({ signal: controller.signal, accessToken: token }).send(
        request(),
      ),
      'cancelled',
    );
    expect(token).not.toHaveBeenCalled();
    expect(hits).toBe(0);
  });
  it('cancels during streaming and ignores a late completion', async () => {
    const controller = new AbortController();
    let respond!: () => void;
    const started = new Promise<void>((resolve) => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        respond = () => res.end('}');
        resolve();
      };
    });
    const value = adapter({ signal: controller.signal });
    const pending = failure(value.send(request()), 'cancelled');
    await Promise.race([
      started,
      pause(200).then(() => {
        throw Error('HTTP did not start');
      }),
    ]);
    controller.abort();
    await pending;
    respond();
    await pause(5);
    expect(value.diagnostics().activeRequests).toBe(0);
  });
  it('uses only the existing thirty second total deadline and clears owned resources', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    handler = (_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    };
    const value = adapter();
    const pending = failure(value.send(request()), 'unavailable');
    // Network is real. Only the adapter deadline clock is simulated.
    for (let i = 0; i < 30 && hits === 0; i++) await pause(5);
    expect(hits).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(value.diagnostics().activeRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(value.diagnostics().activeRequests).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('contains token-provider exceptions and settles promptly on adapter close', async () => {
    const privateText = 'synthetic-private-sentinel';
    const error = await failure(
      adapter({
        accessToken: () => Promise.reject(new Error(privateText)),
      }).send(request()),
      'unavailable',
    );
    expect(JSON.stringify(error)).not.toContain(privateText);
    expect((error as Error).stack).not.toContain(privateText);
    const value = adapter({ accessToken: () => new Promise(() => {}) });
    const pending = failure(value.send(request()), 'cancelled');
    value.close();
    await pending;
    expect(value.diagnostics()).toEqual({ activeRequests: 0, closed: true });
    await failure(value.send(request()), 'cancelled');
  });
  it.each(['denied', 'cancelled', 'stale'] as const)(
    'preserves the fixed transport %s classification from the verified session closure',
    async (kind) => {
      const value = adapter({
        accessToken: () =>
          Promise.reject(new CandidateLoadTransportError(kind)),
      });
      await failure(value.send(request()), kind);
      expect(hits).toBe(0);
      expect(value.diagnostics().activeRequests).toBe(0);
    },
  );
  it('does not trust a spoofed kind or retain ordinary private exception text', async () => {
    const privateText = 'synthetic-private-sentinel';
    const error = await failure(
      adapter({
        accessToken: () =>
          Promise.reject(
            Object.assign(new Error(privateText), { kind: 'denied' }),
          ),
      }).send(request()),
      'unavailable',
    );
    expect(JSON.stringify(error)).not.toContain(privateText);
    expect((error as Error).stack).not.toContain(privateText);
  });
  it('control: the real driver completes five warmups and one hundred raw HTTP responses', async () => {
    const frozen = sourceFixture();
    const value = adapter();
    const result = await runCandidateLoadCondition(
      frozen,
      { dataset: 'SYNTHETIC-S10', action: 'get', first: 200, concurrency: 1 },
      { send: value.send, now: () => performance.now(), fingerprint },
    );
    expect(result.status).toBe('passed');
    expect(result.warmup).toHaveLength(5);
    expect(result.measured).toHaveLength(100);
    expect(
      result.measured.every(
        (sample) => sample.outcome === 'completed' && sample.wireBytes !== null,
      ),
    ).toBe(true);
    expect(hits).toBe(105);
    expect(value.diagnostics().activeRequests).toBe(0);
  });
  it('control: twenty real traversals compare all raw HTTP material with independent frozen contents', async () => {
    const frozen = sourceFixture();
    const value = adapter();
    const result = await runCandidateLoadTraversal(frozen, {
      send: value.send,
      now: () => performance.now(),
      fingerprint,
    });
    expect(result.status).toBe('passed');
    expect(result.iterations).toHaveLength(20);
    expect(
      result.iterations.every(
        (iteration) =>
          iteration.outcome === 'completed' &&
          iteration.counts.assets === 1 &&
          iteration.counts.records === 2 &&
          iteration.counts.geometry === 1 &&
          Object.values(iteration.checks).every(Boolean),
      ),
    ).toBe(true);
    expect(hits).toBe(60);
    expect(value.diagnostics().activeRequests).toBe(0);
  });
  it.each([1, 4] as const)(
    'stops expired verified session dispatch after warmups while retaining C%s started attempts',
    async (concurrency) => {
      const frozen = sourceFixture();
      let calls = 0;
      const value = adapter({
        accessToken: () =>
          ++calls === 6
            ? Promise.reject(new CandidateLoadTransportError('denied'))
            : Promise.resolve('synthetic-token'),
      });
      const result = await runCandidateLoadCondition(
        frozen,
        { dataset: 'SYNTHETIC-S10', action: 'get', first: 200, concurrency },
        { send: value.send, now: () => performance.now(), fingerprint },
      );
      expect(result.status).toBe('failed');
      expect(result.warmup).toHaveLength(5);
      expect(result.measured).toHaveLength(concurrency);
      expect(
        result.measured.filter((sample) => sample.outcome === 'denied'),
      ).toHaveLength(1);
      expect(
        result.measured.filter((sample) => sample.outcome === 'completed'),
      ).toHaveLength(concurrency - 1);
      expect(
        result.measured.find((sample) => sample.outcome === 'denied')
          ?.wireBytes,
      ).toBeNull();
      expect(calls).toBe(5 + concurrency);
      expect(hits).toBe(4 + concurrency);
      expect(value.diagnostics().activeRequests).toBe(0);
    },
  );
  it('control: dishonest small Content-Length cannot admit a parseable JSON prefix with extra raw socket bytes', async () => {
    handler = (_req, res) => {
      hits += 1;
      // Raw wire framing intentionally bypasses ServerResponse serialization.
      res.socket!.end(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}synthetic-extra-body',
      );
    };
    const value = adapter();
    await failure(value.send(request()), 'invalid');
    expect(hits).toBe(1);
    expect(value.diagnostics().activeRequests).toBe(0);
  });
});
