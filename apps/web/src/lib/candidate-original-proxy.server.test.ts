import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  proxyCandidateOriginal,
  type CandidateOriginalProxyOptions,
} from './candidate-original-proxy.server';
import type { VerifiedSessionClient } from './supabase/verified-session';

const ingestionId = 'a1000000-0000-4000-8000-000000000001';
const processingBatchId = 'a1000000-0000-4000-8000-000000000002';
const assetId = 'a1000000-0000-4000-8000-000000000003';
const claims = {
  sub: 'a1000000-0000-4000-8000-000000000004',
  session_id: 'a1000000-0000-4000-8000-000000000005',
  role: 'authenticated',
  exp: 4102444800,
};
const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
const auth: VerifiedSessionClient = {
  auth: {
    getClaims: () => Promise.resolve({ data: { claims }, error: null }),
    getSession: () =>
      Promise.resolve({
        data: { session: { access_token: token } },
        error: null,
      }),
  },
};
const original = (
  body: BodyInit | null = 'world',
  status = 200,
  headers: HeadersInit = {},
) =>
  new Response(body, {
    status,
    headers: { 'content-length': '5', 'content-type': 'text/html', ...headers },
  });
function options(
  fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(original())),
  query = 'reviewHash=' + 'a'.repeat(64),
  init: RequestInit = {},
): CandidateOriginalProxyOptions {
  return {
    request: new Request(
      'http://localhost/api/data-foundation/candidate-assets/' +
        ingestionId +
        '/' +
        processingBatchId +
        '/' +
        assetId +
        '?' +
        query,
      init,
    ),
    ingestionId,
    processingBatchId,
    assetId,
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: 'b1000000-0000-4000-8000-000000000001',
      projectId: 'b1000000-0000-4000-8000-000000000002',
      purpose: 'pending-intake',
      requestTimeoutMs: 5000,
      responseLimitBytes: 32768,
    },
    createAuthClient: () => Promise.resolve(auth),
    fetch,
  };
}
afterEach(() => vi.restoreAllMocks());
it('uses the frozen candidate path and verified server scope without exposing storage or active content', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      original('world', 200, {
        'set-cookie': 'private=secret',
        location: 'http://storage/private',
      }),
    ),
  );
  const result = await proxyCandidateOriginal(options(fetch));
  expect(result.status).toBe(200);
  expect(await result.text()).toBe('world');
  expect(result.headers.get('content-disposition')).toBe('attachment');
  expect(result.headers.get('content-type')).toBe('application/octet-stream');
  expect(result.headers.get('content-security-policy')).toContain('sandbox');
  expect(result.headers.get('cache-control')).toContain('no-store');
  expect(result.headers.get('location')).toBeNull();
  expect(result.headers.get('set-cookie')).toBeNull();
  const [url, init] = fetch.mock.calls[0];
  expect(url instanceof Request ? url.url : url.toString()).toContain(
    `/ingestions/${ingestionId}/candidates/${processingBatchId}/assets/${assetId}/content?reviewHash=${'a'.repeat(64)}`,
  );
  const sent = new Headers(init?.headers);
  expect(sent.get('authorization')).toBe('Bearer ' + token);
  expect(sent.get('x-wiser-purpose')).toBe('pending-intake');
  expect(init?.cache).toBe('no-store');
  expect(init?.redirect).toBe('error');
});
it.each([
  '',
  'reviewHash=bad',
  'reviewHash=' + 'a'.repeat(64) + '&reviewHash=' + 'a'.repeat(64),
  'reviewHash=' + 'a'.repeat(64) + '&versionId=' + assetId,
])(
  'rejects invalid or published selection before authentication: %s',
  async (query) => {
    const input = options(undefined, query);
    const createAuthClient = vi.fn(input.createAuthClient);
    await expect(
      proxyCandidateOriginal({ ...input, createAuthClient }),
    ).rejects.toMatchObject({ status: 422 });
    expect(createAuthClient).not.toHaveBeenCalled();
    expect(input.fetch).not.toHaveBeenCalled();
  },
);
it('checks identity again after fetching and cancels a body on revoked session', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const input = options(vi.fn(() => Promise.resolve(original(body))));
  const createAuthClient = vi
    .fn(input.createAuthClient)
    .mockResolvedValueOnce(auth)
    .mockResolvedValueOnce({
      auth: {
        ...auth.auth,
        getClaims: () => Promise.resolve({ data: null, error: 'revoked' }),
      },
    });
  await expect(
    proxyCandidateOriginal({ ...input, createAuthClient }),
  ).rejects.toMatchObject({ status: 401 });
  expect(cancelled).toBe(true);
});
it('keeps HEAD and unsatisfiable ranges empty and forwards a validated single range', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      original('or', 206, {
        'content-length': '2',
        'content-range': 'bytes 1-2/5',
      }),
    )
    .mockResolvedValueOnce(original(null))
    .mockResolvedValueOnce(
      original('private error', 416, {
        'content-length': '13',
        'content-range': 'bytes */5',
      }),
    );
  const ranged = await proxyCandidateOriginal(
    options(fetch, undefined, { headers: { range: 'bytes=1-2' } }),
  );
  expect(await ranged.text()).toBe('or');
  expect(ranged.headers.get('content-range')).toBe('bytes 1-2/5');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('range')).toBe(
    'bytes=1-2',
  );
  const head = await proxyCandidateOriginal(
    options(fetch, undefined, { method: 'HEAD' }),
  );
  expect(await head.text()).toBe('');
  expect(head.headers.get('content-length')).toBe('5');
  const empty = await proxyCandidateOriginal(
    options(fetch, undefined, { headers: { range: 'bytes=9-' } }),
  );
  expect(await empty.text()).toBe('');
  expect(empty.headers.get('content-length')).toBe('0');
});
const invalidResponseHeaders: ReadonlyArray<Record<string, string>> = [
  { 'content-length': '33554433' },
  { 'content-length': '0' },
  { 'content-length': 'NaN' },
  { 'content-length': '2', 'content-range': 'bytes 1-3/5' },
];
it.each(invalidResponseHeaders)(
  'rejects invalid lengths and range claims: %j',
  async (headers) => {
    const status = headers['content-range'] ? 206 : 200;
    await expect(
      proxyCandidateOriginal(
        options(vi.fn(() => Promise.resolve(original('or', status, headers)))),
      ),
    ).rejects.toMatchObject({ status: 502 });
  },
);
it('does not disclose failed upstream diagnostics', async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(new Response('private credentials', { status: 403 })),
  );
  const reading = proxyCandidateOriginal(options(fetch));
  await expect(reading).rejects.toMatchObject({ status: 403 });
  await expect(reading).rejects.not.toThrow('private');
});
it('cancels delivery when the reader leaves without retaining the original', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new TextEncoder().encode('w'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await proxyCandidateOriginal(
    options(vi.fn(() => Promise.resolve(original(body)))),
  );
  await response.body!.cancel();
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});
it('rejects a caller that has already cancelled without fetching', async () => {
  const controller = new AbortController();
  controller.abort();
  const input = options(undefined, undefined, { signal: controller.signal });
  await expect(proxyCandidateOriginal(input)).rejects.toMatchObject({
    status: 499,
  });
  expect(input.fetch).not.toHaveBeenCalled();
});

it('does not drain the original until the caller requests bytes', async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('world'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await proxyCandidateOriginal(
    options(vi.fn(() => Promise.resolve(original(body)))),
  );
  expect(pulls).toBe(0);
  expect(await response.text()).toBe('world');
  expect(pulls).toBe(1);
});

it('rejects a truncated or oversized stream rather than reporting a successful original', async () => {
  for (const value of ['wor', 'world!']) {
    const response = await proxyCandidateOriginal(
      options(vi.fn(() => Promise.resolve(original(value)))),
    );
    await expect(response.text()).rejects.toMatchObject({ status: 502 });
  }
});

it('returns a safe failure even if upstream body cancellation never settles', async () => {
  const body = new ReadableStream<Uint8Array>({
    cancel: () => new Promise(() => undefined),
  });
  await expect(
    proxyCandidateOriginal(
      options(
        vi.fn(() => Promise.resolve(new Response(body, { status: 403 }))),
      ),
    ),
  ).rejects.toMatchObject({ status: 403 });
}, 1_000);

it('cancels and refuses a late upstream response after the caller aborts', async () => {
  const controller = new AbortController();
  let resolve: (response: Response) => void = () => undefined;
  const fetching = new Promise<Response>((done) => {
    resolve = done;
  });
  const input = options(
    vi.fn(() => fetching),
    undefined,
    { signal: controller.signal },
  );
  const reading = proxyCandidateOriginal(input);
  while (!vi.isMockFunction(input.fetch) || input.fetch.mock.calls.length === 0)
    await Promise.resolve();
  controller.abort();
  await expect(reading).rejects.toMatchObject({ status: 499 });
  let cancelled = false;
  resolve(
    original(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await Promise.resolve();
  expect(cancelled).toBe(true);
});

it.each(['bytes=1-2', 'bytes=-2', null])(
  'rejects a range response for different requested bytes: %s',
  async (range) => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        original('wo', 206, {
          'content-length': '2',
          'content-range': 'bytes 0-1/5',
        }),
      ),
    );
    await expect(
      proxyCandidateOriginal(
        options(fetch, undefined, { headers: range === null ? {} : { range } }),
      ),
    ).rejects.toMatchObject({ status: 502 });
  },
);

it('rejects an unsatisfiable claim for a valid range', async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(original('private', 416, { 'content-range': 'bytes */5' })),
  );
  await expect(
    proxyCandidateOriginal(
      options(fetch, undefined, { headers: { range: 'bytes=1-2' } }),
    ),
  ).rejects.toMatchObject({ status: 502 });
});

it.each([
  ['bytes=3-', 'bytes 3-4/5', 'ld'],
  ['bytes=3-100', 'bytes 3-4/5', 'ld'],
  ['bytes=-2', 'bytes 3-4/5', 'ld'],
  ['bytes=-100', 'bytes 0-4/5', 'world'],
])(
  'preserves a valid requested interval: %s',
  async (range, contentRange, body) => {
    const response = await proxyCandidateOriginal(
      options(
        vi.fn(() =>
          Promise.resolve(
            original(body, 206, {
              'content-length': String(body.length),
              'content-range': contentRange,
            }),
          ),
        ),
        undefined,
        { headers: { range } },
      ),
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
  },
);
