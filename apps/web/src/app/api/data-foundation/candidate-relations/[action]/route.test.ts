import { afterEach, expect, it, vi } from 'vitest';
const { getDal, get, list } = vi.hoisted(() => ({
  getDal: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@/lib/data-foundation-dal.server', () => ({
  getDataFoundationDal: getDal,
  DataFoundationApiError: class extends Error {
    status = 403;
  },
}));
import { DataFoundationApiError } from '@/lib/data-foundation-dal.server';
import { POST } from './route';
const id = '40000000-0000-4000-8000-000000000001';
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id,
  processingBatchId: id,
  reviewHash: 'a'.repeat(64),
};
const input = { references: [reference], first: 25, after: 'opaque+/cursor=' };
function req(
  body: BodyInit = JSON.stringify(input),
  origin = 'http://localhost',
  signal?: AbortSignal,
) {
  return new Request(
    'http://localhost/api/data-foundation/candidate-relations/list',
    {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin,
        'content-type': 'application/json',
      },
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      signal,
    },
  );
}
const call = (request: Request, action = 'list') =>
  POST(request, { params: Promise.resolve({ action }) });
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
it('forwards one finite manifest and opaque cursor with no-store and cancellation', async () => {
  getDal.mockResolvedValue({
    candidateRelationGet: get,
    candidateRelationList: list,
  });
  list.mockResolvedValue({ relations: [], nextCursor: null });
  const request = req();
  const result = await call(request);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ relations: [], nextCursor: null });
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(list).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  expect(get).not.toHaveBeenCalled();
});
it('dispatches get with exact fixed pin and preserves a denied response', async () => {
  getDal.mockResolvedValue({
    candidateRelationGet: get,
    candidateRelationList: list,
  });
  get.mockRejectedValue(new DataFoundationApiError('authorization', 403));
  const pin = {
    references: [reference],
    relationId: id,
    revision: 2,
    decisionVersion: 3,
  };
  const response = await call(req(JSON.stringify(pin)), 'get');
  expect(response.status).toBe(403);
  expect(get).toHaveBeenCalledWith(pin, expect.any(AbortSignal));
  expect(await response.text()).toBe('{"code":"CANDIDATE_RELATION_FAILED"}');
  expect(list).not.toHaveBeenCalled();
});
it.each(['create', 'review', 'withdraw', 'rebind', 'unknown'])(
  'does not expose %s',
  async (action) => {
    expect((await call(req(), action)).status).toBe(404);
    expect(getDal).not.toHaveBeenCalled();
  },
);
it.each([
  ['{', 422],
  [JSON.stringify({ ...input, role: 'admin' }), 422],
  ['x'.repeat(65537), 413],
] as const)(
  'rejects malformed or oversized input before authority acquisition',
  async (body, status) => {
    expect((await call(req(body))).status).toBe(status);
    expect(getDal).not.toHaveBeenCalled();
  },
);
it('rejects cross-origin and non-JSON requests', async () => {
  expect((await call(req(undefined, 'https://foreign.example'))).status).toBe(
    403,
  );
  const request = req();
  request.headers.set('content-type', 'text/plain');
  expect((await call(request)).status).toBe(415);
  expect(getDal).not.toHaveBeenCalled();
});
it('rejects invalid DAL output without returning it', async () => {
  getDal.mockResolvedValue({ candidateRelationList: list });
  list.mockResolvedValue({
    relations: [],
    nextCursor: 'dangling',
    private: 'hidden',
  });
  const result = await call(req());
  expect(result.status).toBe(502);
  expect(await result.text()).toBe('{"code":"CANDIDATE_RELATION_FAILED"}');
});
it('bounds a stalled input body before session acquisition', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const pending = call(req(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(30000);
  expect((await pending).status).toBe(504);
  expect(cancel).toHaveBeenCalled();
  expect(getDal).not.toHaveBeenCalled();
});
it('bounds session acquisition even if it ignores cancellation', async () => {
  vi.useFakeTimers();
  getDal.mockImplementation(() => new Promise(() => {}));
  const pending = call(req());
  await vi.advanceTimersByTimeAsync(30000);
  expect((await pending).status).toBe(504);
  expect(list).not.toHaveBeenCalled();
});
it('propagates cancellation to a stalled DAL and drops late output', async () => {
  getDal.mockResolvedValue({ candidateRelationList: list });
  const entered = Promise.withResolvers<void>();
  list.mockImplementation(() => {
    entered.resolve();
    return new Promise(() => {});
  });
  const abort = new AbortController();
  const pending = call(req(undefined, undefined, abort.signal));
  await entered.promise;
  abort.abort();
  expect((await pending).status).toBe(499);
  const forwarded = list.mock.calls[0]?.[1] as AbortSignal;
  expect(forwarded.aborted).toBe(true);
});
