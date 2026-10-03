import { afterEach, expect, it, vi } from 'vitest';

const { candidateSavedView, getDal } = vi.hoisted(() => ({
  candidateSavedView: vi.fn(),
  getDal: vi.fn(),
}));
vi.mock('./data-foundation-dal.server', () => ({
  getDataFoundationDal: getDal,
  DataFoundationApiError: class extends Error {},
}));
import { DataFoundationApiError } from './data-foundation-dal.server';
import { POST } from '../app/api/data-foundation/candidate-saved-views/[action]/route';

const key = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
function request(
  body?: BodyInit,
  options: { origin?: string; key?: string; signal?: AbortSignal } = {},
) {
  return new Request(
    'http://localhost/api/data-foundation/candidate-saved-views/open',
    {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: options.origin ?? 'http://localhost',
        ...(options.key ? { 'idempotency-key': options.key } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      signal: options.signal,
    },
  );
}
const call = (action: string, req: Request) =>
  POST(req, { params: Promise.resolve({ action }) });
afterEach(() => vi.resetAllMocks());

it.each([
  ['unknown', '{}', 'http://localhost', 404],
  ['create', '{}', 'https://foreign.example', 403],
  ['open', undefined, 'http://localhost', 422],
  ['open', '{', 'http://localhost', 422],
  ['open', new Uint8Array([0xff]), 'http://localhost', 422],
  ['create', 'x'.repeat(128 * 1024 + 1), 'http://localhost', 413],
] as const)(
  'rejects invalid %s requests before accessing the DAL',
  async (action, body, origin, status) => {
    const response = await call(action, request(body, { origin }));
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(getDal).not.toHaveBeenCalled();
  },
);
it.each(['create', 'list', 'open', 'revoke'])(
  'forwards %s with command identity and cancellation',
  async (action) => {
    getDal.mockResolvedValue({ candidateSavedView });
    candidateSavedView.mockResolvedValue({ kind: 'ingestion-candidate-view' });
    const mutation = action === 'create' || action === 'revoke';
    const req = request('{"viewId":"fixed"}', { ...(mutation ? { key } : {}) });
    const response = await call(action, req);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(candidateSavedView).toHaveBeenCalledWith(
      action,
      { viewId: 'fixed' },
      mutation ? key : undefined,
      req.signal,
    );
  },
);
it('accepts exactly 128 KiB of streamed JSON, including split UTF-8 characters', async () => {
  getDal.mockResolvedValue({ candidateSavedView });
  candidateSavedView.mockResolvedValue({ savedView: 'fixed' });
  const json = '{"title":"待审"}';
  const raw = new TextEncoder().encode(json);
  const bytes = new Uint8Array(128 * 1024);
  bytes.fill(32);
  bytes.set(raw);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 11));
      controller.enqueue(bytes.slice(11));
      controller.close();
    },
  });
  expect((await call('create', request(body, { key }))).status).toBe(200);
  expect(candidateSavedView).toHaveBeenCalledWith(
    'create',
    { title: '待审' },
    key,
    expect.any(AbortSignal),
  );
});
it('returns 413 immediately even when body cancellation never completes', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65536));
      controller.enqueue(new Uint8Array(65537));
    },
    cancel,
  });
  await expect(
    Promise.race([
      call('create', request(body, { key })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]),
  ).resolves.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
  expect(getDal).not.toHaveBeenCalled();
});
it('cancels a stalled body before acquiring the DAL', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{'));
      queueMicrotask(() => controller.abort());
    },
    cancel,
  });
  expect(
    (await call('open', request(body, { signal: controller.signal }))).status,
  ).toBe(499);
  expect(cancel).toHaveBeenCalledOnce();
  expect(getDal).not.toHaveBeenCalled();
});
it('discards late results after caller cancellation', async () => {
  const controller = new AbortController();
  getDal.mockResolvedValue({ candidateSavedView });
  candidateSavedView.mockImplementation(() => {
    controller.abort();
    return Promise.resolve({ title: 'private late result' });
  });
  const response = await call(
    'open',
    request('{}', { signal: controller.signal }),
  );
  expect(response.status).toBe(499);
  expect(await response.text()).not.toContain('private');
});
it('preserves safe DAL status without exposing any upstream detail', async () => {
  getDal.mockResolvedValue({ candidateSavedView });
  const error = Object.create(
    DataFoundationApiError.prototype,
  ) as DataFoundationApiError;
  Object.assign(error, {
    status: 403,
    message: 'private SQL https://storage.example',
  });
  candidateSavedView.mockRejectedValueOnce(error);
  const denied = await call('open', request('{}'));
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe('{"code":"CANDIDATE_VIEW_FAILED"}');
  candidateSavedView.mockRejectedValueOnce(new Error('private SQL'));
  const failed = await call('create', request('{}', { key }));
  expect(failed.status).toBe(503);
  expect(await failed.text()).toBe('{"code":"CANDIDATE_VIEW_FAILED"}');
});
