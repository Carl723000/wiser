import { afterEach, expect, it, vi } from 'vitest';
const { externalMetadata, getDal } = vi.hoisted(() => ({
  externalMetadata: vi.fn(),
  getDal: vi.fn(),
}));
vi.mock('./data-foundation-dal.server', () => ({
  getDataFoundationDal: getDal,
  DataFoundationApiError: class extends Error {
    constructor(
      readonly kind: string,
      readonly status: number,
      readonly code?: string,
    ) {
      super('private provider token');
    }
  },
}));
import { DataFoundationApiError } from './data-foundation-dal.server';
import { POST } from '../app/api/data-foundation/external-metadata/route';
const input = {
  sourceId: '10000000-0000-4000-8000-000000000001',
  fromYear: 2020,
  toYear: 2021,
  offset: 0,
  limit: 10,
};
const request = (
  body: BodyInit | undefined = JSON.stringify(input),
  origin = 'http://localhost',
  signal?: AbortSignal,
) =>
  new Request('http://localhost/api/data-foundation/external-metadata', {
    method: 'POST',
    headers: { host: 'localhost', origin, 'content-type': 'application/json' },
    body,
    signal,
  });
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
it('rejects cross-origin and malformed inputs before resolving an identity', async () => {
  for (const [req, status] of [
    [request('{}', 'https://foreign.example'), 403],
    [request('{'), 422],
    [request(new Uint8Array([255])), 422],
    [request(JSON.stringify({ ...input, token: 'private' })), 422],
    [request(' '.repeat(4097)), 413],
    [
      new Request('http://localhost/api/data-foundation/external-metadata', {
        method: 'POST',
      }),
      422,
    ],
  ] as const) {
    const result = await POST(req);
    expect(result.status).toBe(status);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
  }
  expect(getDal).not.toHaveBeenCalled();
});
it('forwards only the validated metadata query and request cancellation', async () => {
  getDal.mockResolvedValue({ externalMetadata });
  const page = {
    sourceId: input.sourceId,
    status: 'EMPTY',
    items: [],
    total: 0,
    checkedAt: '2026-09-20T10:00:00Z',
    timePrecision: 'year',
  };
  externalMetadata.mockResolvedValue(page);
  const req = request();
  const result = await POST(req);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(page);
  expect(externalMetadata).toHaveBeenCalledWith(input, req.signal);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
});
it.each([
  [403, 'EXTERNAL_AUTHORIZATION_EXPIRED', 'EXTERNAL_AUTHORIZATION_EXPIRED'],
  [503, 'EXTERNAL_SOURCE_UNCONFIGURED', 'EXTERNAL_SOURCE_UNCONFIGURED'],
  [401, undefined, 'AUTHENTICATION_REQUIRED'],
  [403, 'private-token', 'FORBIDDEN'],
  [500, 'EXTERNAL_SOURCE_UNCONFIGURED', 'EXTERNAL_METADATA_FAILED'],
] as const)(
  'sanitizes %i errors and preserves only matching source states',
  async (status, code, expected) => {
    getDal.mockResolvedValue({ externalMetadata });
    externalMetadata.mockRejectedValue(
      new DataFoundationApiError('unavailable', status, code as never),
    );
    const result = await POST(request());
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ code: expected });
    expect(result.headers.get('cache-control')).toBe('private, no-store');
  },
);
it('does not expose unexpected server errors', async () => {
  getDal.mockRejectedValue(new Error('private provider token'));
  const result = await POST(request());
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ code: 'EXTERNAL_METADATA_FAILED' });
});
it('cancels an unfinished request body without invoking the DAL', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'));
    },
    cancel,
  });
  const req = new Request(
    'http://localhost/api/data-foundation/external-metadata',
    {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit,
  );
  const pending = POST(req);
  controller.abort();
  const result = await pending;
  expect(result.status).toBe(499);
  expect(cancel).toHaveBeenCalled();
  expect(getDal).not.toHaveBeenCalled();
});
it('bounds an unfinished request body independently of client cancellation', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'));
    },
    cancel,
  });
  const req = new Request(
    'http://localhost/api/data-foundation/external-metadata',
    { method: 'POST', body, duplex: 'half' } as RequestInit,
  );
  const pending = POST(req);
  await vi.advanceTimersByTimeAsync(5001);
  const result = await pending;
  expect(result.status).toBe(408);
  expect(cancel).toHaveBeenCalled();
  expect(getDal).not.toHaveBeenCalled();
});
