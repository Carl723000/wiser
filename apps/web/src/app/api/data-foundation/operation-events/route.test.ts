import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), events: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/data-foundation-dal.server', () => ({
  getDataFoundationDal: mocks.get,
  DataFoundationApiError: class extends Error {
    constructor(
      readonly kind: string,
      readonly status: number,
    ) {
      super('Safe error');
    }
  },
}));
import { POST } from './route';
import { DataFoundationApiError } from '@/lib/data-foundation-dal.server';
const operationId = '10000000-0000-4000-8000-000000000001';
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://web.local/api/data-foundation/operation-events', {
    method: 'POST',
    headers: { host: 'web.local', origin: 'http://web.local', ...headers },
    body: JSON.stringify(body),
  });
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
it('verifies each new same-origin request and passes one fixed operation page without a cursor URL', async () => {
  mocks.get.mockResolvedValue({ operationEvents: mocks.events });
  mocks.events.mockResolvedValue({ items: [], nextCursor: 'opaque' });
  for (const after of [undefined, 'private-cursor']) {
    const response = await POST(
      request({ operationId, ...(after ? { after } : {}) }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.events).toHaveBeenLastCalledWith(
      operationId,
      after,
      expect.any(AbortSignal),
    );
  }
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(mocks.events).toHaveBeenCalledTimes(2);
});
it.each<Record<string, string>>([
  { origin: 'https://other.test' },
  { 'sec-fetch-site': 'cross-site' },
])(
  'rejects cross-origin calls before identity/data lookup',
  async (headers) => {
    expect((await POST(request({ operationId }, headers))).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  [],
  {},
  { operationId: 'invalid' },
  { operationId, after: '' },
  { operationId, after: 'x'.repeat(2049) },
  { operationId, after: ['one', 'two'] },
  { operationId, tenantId: operationId },
  { operationId, first: 200 },
])('rejects malformed requests without touching authority', async (body) => {
  expect((await POST(request(body))).status).toBe(422);
  expect(mocks.get).not.toHaveBeenCalled();
});
it.each([401, 403, 404, 400, 422, 503])(
  'preserves continuation %i with a safe failure body',
  async (status) => {
    mocks.get.mockResolvedValue({ operationEvents: mocks.events });
    mocks.events.mockRejectedValue(
      new DataFoundationApiError('unavailable', status),
    );
    const response = await POST(
      request({ operationId, after: 'private-cursor' }),
    );
    expect(response.status).toBe(status);
    expect(await response.text()).not.toMatch(/private-cursor|Safe error/);
  },
);
it('caps the request body before DAL lookup', async () => {
  expect(
    (await POST(request({ operationId, after: 'x'.repeat(20_000) }))).status,
  ).toBe(413);
  expect(mocks.get).not.toHaveBeenCalled();
});
it('times out a stalled request body and cancels it without DAL lookup', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const result = POST(
    new Request('http://web.local/api/data-foundation/operation-events', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit),
  );
  await vi.advanceTimersByTimeAsync(10_001);
  expect((await result).status).toBe(504);
  expect(cancel).toHaveBeenCalled();
  expect(mocks.get).not.toHaveBeenCalled();
});
it('propagates cancellation to a started DAL request and ignores its late result', async () => {
  const controller = new AbortController();
  let resolve!: (value: unknown) => void;
  mocks.get.mockResolvedValue({ operationEvents: mocks.events });
  mocks.events.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const base = request({ operationId });
  const result = POST(new Request(base, { signal: controller.signal }));
  await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledTimes(1));
  controller.abort();
  expect((await result).status).toBe(499);
  expect(mocks.events.mock.calls[0][2].aborted).toBe(true);
  resolve({ items: [] });
});
