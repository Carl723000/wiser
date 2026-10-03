import { afterEach, expect, it, vi } from 'vitest';

const { candidate, getDal } = vi.hoisted(() => ({
  candidate: vi.fn(),
  getDal: vi.fn(),
}));
vi.mock('./data-foundation-dal.server', () => ({
  getDataFoundationDal: getDal,
  DataFoundationApiError: class extends Error {},
}));
import { DataFoundationApiError } from './data-foundation-dal.server';
import { POST } from '../app/api/data-foundation/candidates/[action]/route';

function request(
  body?: BodyInit,
  origin = 'http://localhost',
  signal?: AbortSignal,
) {
  return new Request('http://localhost/api/data-foundation/candidates/get', {
    method: 'POST',
    headers: { host: 'localhost', origin },
    ...(body === undefined ? {} : { body }),
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    signal,
  });
}
const call = (action: string, body?: BodyInit, origin?: string) =>
  POST(request(body, origin), { params: Promise.resolve({ action }) });
afterEach(() => vi.resetAllMocks());

it.each([
  ['unknown', '{}', 'http://localhost', 404],
  ['get', '{}', 'https://foreign.example', 403],
  ['get', undefined, 'http://localhost', 422],
  ['get', '{', 'http://localhost', 422],
  ['get', new Uint8Array([0xff]), 'http://localhost', 422],
  ['get', 'x'.repeat(16385), 'http://localhost', 413],
] as const)(
  'rejects %s request with %i before accessing the DAL',
  async (action, body, origin, status) => {
    const response = await call(action, body, origin);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(getDal).not.toHaveBeenCalled();
  },
);
it.each(['get', 'records', 'geometry'])(
  'forwards the read-only %s command and caller cancellation',
  async (action) => {
    getDal.mockResolvedValue({ candidate });
    candidate.mockResolvedValue({ reference: 'fixed' });
    const req = request('{"kind":"ingestion-candidate"}');
    const response = await POST(req, { params: Promise.resolve({ action }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reference: 'fixed' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(candidate).toHaveBeenCalledWith(
      action,
      { kind: 'ingestion-candidate' },
      req.signal,
    );
  },
);
it('enforces the body limit across chunks and cancels the unread stream', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8192));
      controller.enqueue(new Uint8Array(8193));
    },
    cancel,
  });
  expect((await call('records', body)).status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
  expect(getDal).not.toHaveBeenCalled();
});
it('does not acquire a session after the browser aborts a stalled request body', async () => {
  const abort = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      queueMicrotask(() => abort.abort());
    },
    cancel,
  });
  const response = await POST(request(body, undefined, abort.signal), {
    params: Promise.resolve({ action: 'get' }),
  });
  expect(response.status).toBe(499);
  expect(cancel).toHaveBeenCalledOnce();
  expect(getDal).not.toHaveBeenCalled();
});
it('preserves safe DAL status and hides every upstream diagnostic', async () => {
  getDal.mockResolvedValue({ candidate });
  const error = Object.create(
    DataFoundationApiError.prototype,
  ) as DataFoundationApiError;
  Object.assign(error, {
    status: 403,
    message: 'private/path https://internal.example',
  });
  candidate.mockRejectedValueOnce(error);
  const denied = await call('get', '{}');
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe('{"code":"CANDIDATE_FAILED"}');
  candidate.mockRejectedValueOnce(new Error('private upstream body'));
  const failed = await call('get', '{}');
  expect(failed.status).toBe(503);
  expect(await failed.text()).toBe('{"code":"CANDIDATE_FAILED"}');
});
