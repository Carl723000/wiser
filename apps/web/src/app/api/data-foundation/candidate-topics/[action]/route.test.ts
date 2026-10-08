import { afterEach, expect, it, vi } from 'vitest';

const { candidateTopic, getDal } = vi.hoisted(() => ({
  candidateTopic: vi.fn(),
  getDal: vi.fn(),
}));
vi.mock('@/lib/data-foundation-dal.server', () => ({
  getDataFoundationDal: getDal,
  DataFoundationApiError: class extends Error {},
}));
import { DataFoundationApiError } from '@/lib/data-foundation-dal.server';
import { POST } from './route';

const viewId = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
function request(
  body?: BodyInit,
  options: { origin?: string; site?: string; signal?: AbortSignal } = {},
) {
  return new Request(
    'http://localhost/api/data-foundation/candidate-topics/open',
    {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: options.origin ?? 'http://localhost',
        'idempotency-key': viewId,
        ...(options.site ? { 'sec-fetch-site': options.site } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      signal: options.signal,
    },
  );
}
const call = (action: string, req: Request) =>
  POST(req, { params: Promise.resolve({ action }) });
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

it.each([
  ['unknown', '{}', 'http://localhost', 404],
  ['create', '{}', 'http://localhost', 404],
  ['revoke', '{}', 'http://localhost', 404],
  ['list', '{}', 'https://foreign.example', 403],
  ['open', undefined, 'http://localhost', 422],
  ['open', '{', 'http://localhost', 422],
  ['open', new Uint8Array([0xff]), 'http://localhost', 422],
  ['open', 'x'.repeat(128 * 1024 + 1), 'http://localhost', 413],
] as const)(
  'rejects invalid or non-read %s requests before acquiring the DAL',
  async (action, body, origin, status) => {
    const response = await call(action, request(body, { origin }));
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(getDal).not.toHaveBeenCalled();
  },
);
it('rejects a cross-site fetch even when its supplied Origin matches', async () => {
  expect(
    (await call('open', request('{}', { site: 'cross-site' }))).status,
  ).toBe(403);
  expect(getDal).not.toHaveBeenCalled();
});
it.each(['list', 'open'] as const)(
  'forwards only the topic %s read and caller signal',
  async (action) => {
    getDal.mockResolvedValue({ candidateTopic });
    const output =
      action === 'list'
        ? { items: [], nextCursor: null }
        : { status: 'UNAVAILABLE', viewId };
    candidateTopic.mockResolvedValue(output);
    const input = action === 'list' ? { first: 20 } : { viewId };
    const req = request(JSON.stringify(input));
    const response = await call(action, req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(output);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(candidateTopic).toHaveBeenCalledOnce();
    expect(candidateTopic).toHaveBeenCalledWith(action, input, req.signal);
  },
);
it('accepts exactly 128 KiB of streamed JSON with split UTF-8 characters', async () => {
  getDal.mockResolvedValue({ candidateTopic });
  candidateTopic.mockResolvedValue({ status: 'UNAVAILABLE', viewId });
  const raw = new TextEncoder().encode('{"title":"待审"}');
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
  expect((await call('open', request(body))).status).toBe(200);
  expect(candidateTopic).toHaveBeenCalledWith(
    'open',
    { title: '待审' },
    expect.any(AbortSignal),
  );
});
it('returns 413 across chunks without waiting for stream cancellation', async () => {
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
      call('list', request(body)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]),
  ).resolves.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
  expect(getDal).not.toHaveBeenCalled();
});
it('cancels a stalled body before acquiring the DAL', async () => {
  const caller = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      queueMicrotask(() => caller.abort());
    },
    cancel,
  });
  const response = await call('open', request(body, { signal: caller.signal }));
  expect(response.status).toBe(499);
  expect(cancel).toHaveBeenCalledOnce();
  expect(getDal).not.toHaveBeenCalled();
});
it('bounds a stalled body by 30 seconds without exposing its partial content', async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel,
  });
  let response: Response | undefined;
  const pending = call('open', request(body, { signal: caller.signal })).then(
    (value) => {
      response = value;
      return value;
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(30000);
    expect(response?.status).toBe(504);
    expect(response?.headers.get('cache-control')).toBe('private, no-store');
    expect(cancel).toHaveBeenCalledOnce();
    expect(getDal).not.toHaveBeenCalled();
  } finally {
    caller.abort();
    await pending;
  }
});
it('discards a late topic result after caller cancellation', async () => {
  const caller = new AbortController();
  getDal.mockResolvedValue({ candidateTopic });
  candidateTopic.mockImplementation(() => {
    caller.abort();
    return Promise.resolve({ title: 'private late source' });
  });
  const response = await call('open', request('{}', { signal: caller.signal }));
  expect(response.status).toBe(499);
  expect(await response.text()).not.toContain('private');
});
it('preserves safe DAL denial status and returns 503 for unknown failures', async () => {
  getDal.mockResolvedValue({ candidateTopic });
  const error = Object.create(
    DataFoundationApiError.prototype,
  ) as DataFoundationApiError;
  Object.assign(error, {
    status: 403,
    message: 'private SQL https://storage.example',
  });
  candidateTopic.mockRejectedValueOnce(error);
  const denied = await call('open', request('{}'));
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe('{"code":"CANDIDATE_TOPIC_FAILED"}');
  candidateTopic.mockRejectedValueOnce(new Error('private upstream body'));
  const failed = await call('list', request('{}'));
  expect(failed.status).toBe(503);
  expect(await failed.text()).toBe('{"code":"CANDIDATE_TOPIC_FAILED"}');
});
