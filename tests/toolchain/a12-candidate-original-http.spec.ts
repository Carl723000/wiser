import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidateLoadTransportError } from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import {
  createCandidateOriginalHttpAdapter,
  type CandidateOriginalHttpAdapter,
  type CandidateOriginalHttpInput,
  type CandidateOriginalHttpOptions,
} from '../../apps/web/e2e-live/support/a12-candidate-original-http.ts';

const tenant = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
const asset = '33333333-3333-4333-8333-333333333333';
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '44444444-4444-4444-8444-444444444444',
  processingBatchId: '55555555-5555-4555-8555-555555555555',
  reviewHash: 'a'.repeat(64),
};
// Deliberately invalid UTF8 and JSON: these are synthetic ORIGINAL bytes.
// No actual source file, credential, scan, standard intake or formal A12.
const bytes = Buffer.from([0xff, 0xfe, 0, 0x61, 0x80, 0x62, 0x63]);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const input = (): CandidateOriginalHttpInput => ({
  reference: { ...reference }, assetId: asset,
  expectedSha256: digest(bytes), expectedSizeBytes: bytes.length,
});
let port = 0;
let hits = 0;
let handler: (request: IncomingMessage, response: ServerResponse) => void;
let server: ReturnType<typeof createServer>;
const owned: CandidateOriginalHttpAdapter[] = [];
const options = (): CandidateOriginalHttpOptions => ({
  apiOrigin: `http://127.0.0.1:${port}`, taskApiPort: port,
  tenantId: tenant, projectId: project, purpose: 'web-console',
  accessToken: () => Promise.resolve('synthetic-only-token'),
});
function adapter(change: Partial<CandidateOriginalHttpOptions> = {}) {
  const result = createCandidateOriginalHttpAdapter({ ...options(), ...change });
  owned.push(result);
  return result;
}
function original(response: ServerResponse, value: Uint8Array = bytes) {
  response.writeHead(200, { 'Content-Length': value.length, 'Content-Type': 'application/octet-stream' });
  response.end(value);
}
async function rejected(read: Promise<unknown>, kind: string) {
  await expect(read).rejects.toBeInstanceOf(CandidateLoadTransportError);
  await expect(read).rejects.toMatchObject({ kind });
}
beforeEach(async () => {
  hits = 0;
  handler = (_request, response) => original(response);
  server = createServer((request, response) => { hits += 1; handler(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Synthetic listener unavailable');
  port = (address as AddressInfo).port;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const value of owned.splice(0)) value.close();
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('candidate original binary GET integrity only', { concurrent: false }, () => {
  it('streams non-UTF8 bytes, constructs only the fixed GET and returns only digest/size/status', async () => {
    let wire: IncomingMessage | undefined;
    let bodyBytes = 0;
    handler = (request, response) => {
      wire = request;
      request.on('data', (chunk: Buffer) => { bodyBytes += chunk.length; });
      original(response);
    };
    const value = adapter();
    const result = await value.read(input());
    expect(result).toEqual({ status: 200, sha256: digest(bytes), sizeBytes: bytes.length });
    expect(Object.keys(result).sort()).toEqual(['sha256','sizeBytes','status']);
    expect(wire?.method).toBe('GET');
    expect(wire?.url).toBe(`/api/data/v1/tenants/${tenant}/projects/${project}/ingestions/${reference.ingestionId}/candidates/${reference.processingBatchId}/assets/${asset}/content?reviewHash=${reference.reviewHash}`);
    expect(wire?.headers).toMatchObject({
      'accept-encoding': 'identity', authorization: 'Bearer synthetic-only-token',
      'x-wiser-tenant-id': tenant, 'x-wiser-project-id': project, 'x-wiser-purpose': 'web-console',
    });
    expect(wire?.headers.range).toBeUndefined();
    expect(bodyBytes).toBe(0);
    expect(hits).toBe(1);
    expect(value.diagnostics()).toEqual({ activeRequests: 0, closed: false });
  });
  it('hashes multiple binary chunks without retaining or decoding them', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Length': bytes.length });
      response.write(bytes.subarray(0, 2));
      setImmediate(() => { response.write(bytes.subarray(2, 4)); response.end(bytes.subarray(4)); });
    };
    expect(await adapter().read(input())).toEqual({ status: 200, sha256: digest(bytes), sizeBytes: bytes.length });
  });
  it('accepts the inclusive 32MiB original bound through the actual binary stream', async () => {
    const large = Buffer.alloc(32 * 1024 * 1024, 0x9f);
    handler = (_request, response) => original(response, large);
    const expected = { ...input(), expectedSha256: digest(large), expectedSizeBytes: large.length };
    expect(await adapter().read(expected)).toEqual({ status: 200, sha256: expected.expectedSha256, sizeBytes: large.length });
  });
  it.each([
    { expectedSizeBytes: 0 }, { expectedSizeBytes: 32 * 1024 * 1024 + 1 },
    { expectedSizeBytes: 1.5 }, { expectedSha256: 'invalid' }, { assetId: 'bad' },
    { reference: { ...reference, reviewHash: 'bad' } },
    { reference: { ...reference, kind: 'catalog-version' } },
    { url: 'http://127.0.0.1/unrelated' }, { method: 'HEAD' }, { range: 'bytes=0-1' },
  ])('rejects malformed binary admission before dispatch %#', async change => {
    await rejected(adapter().read({ ...input(), ...change } as CandidateOriginalHttpInput), 'invalid');
    expect(hits).toBe(0);
  });
  it.each([
    { apiOrigin: 'http://localhost:1234' }, { apiOrigin: 'https://127.0.0.1:1234' },
    { apiOrigin: 'http://127.0.0.1:1234/path' }, { taskApiPort: 65536 },
    { tenantId: 'bad' }, { purpose: '' },
  ])('rejects a wrong fixed origin or scope before token acquisition %#', change => {
    const accessToken = vi.fn(() => Promise.resolve('synthetic-only-token'));
    expect(() => adapter({ ...change, accessToken })).toThrow(CandidateLoadTransportError);
    expect(accessToken).not.toHaveBeenCalled();
    expect(hits).toBe(0);
  });
  it('rejects an origin/manifest port mismatch without touching either port', () => {
    expect(() => adapter({ taskApiPort: port === 65535 ? port - 1 : port + 1 })).toThrow(CandidateLoadTransportError);
    expect(hits).toBe(0);
  });
  it('never evaluates configuration or reference accessors', async () => {
    const getter = vi.fn(() => { throw new Error('synthetic-private-accessor'); });
    const config = options(); Object.defineProperty(config, 'accessToken', { get: getter });
    expect(() => createCandidateOriginalHttpAdapter(config)).toThrow(CandidateLoadTransportError);
    const request = input(); Object.defineProperty(request.reference, 'reviewHash', { get: getter });
    await rejected(adapter().read(request), 'invalid');
    expect(getter).not.toHaveBeenCalled();
  });
  it('holds an immutable reference/hash/size and configuration snapshot across token await', async () => {
    let provide!: (token: string) => void;
    const config = { ...options(), accessToken: () => new Promise<string>(resolve => { provide = resolve; }) };
    const value = createCandidateOriginalHttpAdapter(config); owned.push(value);
    const mutable = { ...input(), reference: { ...reference } };
    const read = value.read(mutable);
    await Promise.resolve();
    mutable.reference.reviewHash = 'b'.repeat(64); mutable.expectedSha256 = 'c'.repeat(64); mutable.expectedSizeBytes = 1;
    config.tenantId = asset; config.apiOrigin = 'http://127.0.0.1:1';
    provide('synthetic-only-token');
    expect(await read).toEqual({ status: 200, sha256: digest(bytes), sizeBytes: bytes.length });
  });
  it.each([206, 301, 302, 304])('rejects partial or redirect status %i without following or retrying', async status => {
    handler = (_request, response) => { response.writeHead(status, { Location: '/never-follow' }); response.end(); };
    await rejected(adapter().read(input()), 'invalid'); expect(hits).toBe(1);
  });
  it.each([[401,'denied'],[403,'denied'],[404,'stale'],[409,'stale'],[410,'stale'],[503,'unavailable']] as const)('keeps existing safe HTTP classification %i', async (status,kind) => {
    handler = (_request, response) => { response.writeHead(status); response.end('synthetic-private-error-body'); };
    await rejected(adapter().read(input()), kind); expect(hits).toBe(1);
  });
  it.each([
    { 'Content-Encoding': 'gzip' }, { 'Content-Encoding': 'br' },
    { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
    { 'Content-Length': bytes.length - 1 }, { 'Content-Length': bytes.length + 1 },
  ])('rejects compression/range or dishonest declared length %#', async headers => {
    handler = (_request, response) => { response.writeHead(200, { 'Content-Length': bytes.length, ...headers }); response.end(bytes); };
    await rejected(adapter().read(input()), 'invalid');
  });
  it('requires Content-Length, rejecting chunked input rather than guessing a denominator', async () => {
    handler = (_request, response) => { response.writeHead(200); response.write(bytes); response.end(); };
    await rejected(adapter().read(input()), 'invalid');
  });
  it('accepts explicit identity encoding but returns no response headers', async () => {
    handler = (_request, response) => { response.writeHead(200, { 'Content-Length': bytes.length, 'Content-Encoding': 'identity', 'X-Synthetic-Private': 'private-marker' }); response.end(bytes); };
    expect(await adapter().read(input())).toEqual({ status: 200, sha256: digest(bytes), sizeBytes: bytes.length });
  });
  it('rejects a complete wrong hash without copying bytes or raw errors into the failure', async () => {
    const read = adapter().read({ ...input(), expectedSha256: 'b'.repeat(64) });
    await rejected(read, 'drift');
    const error: unknown = await read.catch(value => value);
    expect(String(error)).toBe('Error: Candidate measurement could not complete');
    expect(JSON.stringify(error)).not.toContain('synthetic');
  });
  it('rejects a truncated response instead of hashing a complete-looking prefix', async () => {
    handler = (request) => request.socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\nabc`);
    await rejected(adapter().read(input()), 'unavailable');
  });
  it('rejects malformed duplicate Content-Length through the actual Node HTTP parser', async () => {
    handler = request => request.socket.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabc');
    await rejected(adapter().read(input()), 'invalid');
  });
  it('does not accept a hash-matching short Content-Length prefix plus extra raw socket bytes', async () => {
    const prefix = Buffer.from('abc');
    handler = request => request.socket.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabcEXTRA');
    await rejected(adapter().read({ ...input(), expectedSha256: digest(prefix), expectedSizeBytes: prefix.length }), 'invalid');
  });
  it.each(['denied','stale','cancelled'] as const)('preserves the current guard closure %s without dispatch/retry', async kind => {
    await rejected(adapter({ accessToken: () => Promise.reject(new CandidateLoadTransportError(kind)) }).read(input()), kind);
    expect(hits).toBe(0);
  });
  it('sanitizes an ordinary token error even when it imitates a safe kind', async () => {
    const raw = Object.assign(new Error('synthetic-private-token-or-url'), { kind: 'denied' });
    const read = adapter({ accessToken: () => Promise.reject(raw) }).read(input());
    await rejected(read, 'unavailable');
    expect(String(await read.catch(value => value))).not.toContain('synthetic-private');
    expect(hits).toBe(0);
  });
  it('cancels pre-aborted work before token acquisition', async () => {
    const controller = new AbortController(); controller.abort();
    const accessToken = vi.fn(() => Promise.resolve('synthetic-only-token'));
    await rejected(adapter({ signal: controller.signal, accessToken }).read(input()), 'cancelled');
    expect(accessToken).not.toHaveBeenCalled(); expect(hits).toBe(0);
  });
  it('closes only its own pending work and refuses late tokens/new reads', async () => {
    let provide!: (token: string) => void;
    const value = adapter({ accessToken: () => new Promise<string>(resolve => { provide = resolve; }) });
    const read = value.read(input()); await Promise.resolve(); value.close(); value.close();
    await rejected(read, 'cancelled'); provide('synthetic-only-token'); await nextTurn();
    await rejected(value.read(input()), 'cancelled');
    expect(hits).toBe(0); expect(value.diagnostics()).toEqual({ activeRequests: 0, closed: true });
  });
  it('aborts an active binary stream and clears owned request resources', async () => {
    let observed!: () => void; const arrived = new Promise<void>(resolve => { observed = resolve; });
    handler = (_request,response) => { response.writeHead(200, { 'Content-Length': bytes.length }); response.write(bytes.subarray(0,1)); observed(); };
    const controller = new AbortController(); const value = adapter({ signal: controller.signal });
    const read = value.read(input()); await arrived; controller.abort(); await rejected(read,'cancelled');
    expect(value.diagnostics().activeRequests).toBe(0);
  });
  it('enforces the unchanged 30s total deadline during token wait and rejects late completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] });
    let provide!: (token: string) => void;
    const value = adapter({ accessToken: () => new Promise<string>(resolve => { provide = resolve; }) });
    const read = value.read(input()); let settled = false; void read.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected(read,'unavailable');
    provide('synthetic-only-token'); await Promise.resolve(); await Promise.resolve();
    expect(hits).toBe(0); expect(value.diagnostics().activeRequests).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves the first typed failure when subsequent cleanup cancels the adapter', async () => {
    const controller = new AbortController();
    const value = adapter({ signal: controller.signal, accessToken: () => Promise.reject(new CandidateLoadTransportError('denied')) });
    const read = value.read(input()); await rejected(read,'denied'); controller.abort(); value.close();
    await rejected(read,'denied'); expect(hits).toBe(0);
  });
});
