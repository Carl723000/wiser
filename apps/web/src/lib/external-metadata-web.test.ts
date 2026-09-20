import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createDataFoundationDal } from './data-foundation-dal.server';
const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const claims = {
  sub: id,
  session_id: other,
  role: 'authenticated',
  exp: 4102444800,
};
const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test-signature`;
const auth = () =>
  Promise.resolve({
    auth: {
      getClaims: () => Promise.resolve({ data: { claims }, error: null }),
      getSession: () =>
        Promise.resolve({
          data: { session: { access_token: token } },
          error: null,
        }),
    },
  });
const input = {
  sourceId: id,
  fromYear: 2020,
  toYear: 2021,
  offset: 0,
  limit: 2,
};
const output = {
  sourceId: id,
  status: 'AVAILABLE',
  items: [{ stationCode: '001', year: 2020 }],
  total: 1,
  checkedAt: '2026-09-20T10:00:00Z',
  timePrecision: 'year',
};
const make = (
  fetch: typeof globalThis.fetch,
  timeout = 1000,
  createAuthClient = auth,
) =>
  createDataFoundationDal({
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: id,
      projectId: other,
      purpose: 'read',
      requestTimeoutMs: timeout,
      responseLimitBytes: 1024,
    },
    createAuthClient,
    fetch,
  });
afterEach(() => vi.restoreAllMocks());
it('uses the verified session, fixed endpoint, scoped headers and a metadata-only body', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json(output));
  expect(await make(fetch).externalMetadata(input)).toEqual(output);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe(
    `http://api:3001/api/data/v1/external-sources/${id}/metadata/query`,
  );
  expect(options).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
  });
  const headers = new Headers(options?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${token}`);
  expect(headers.get('x-wiser-project-id')).toBe(other);
  expect(JSON.parse(options?.body as string)).toEqual({
    fromYear: 2020,
    toYear: 2021,
    offset: 0,
    limit: 2,
  });
});
it.each([
  { ...input, token: 'injected' },
  { ...input, sourceId: '../secret' },
  { ...input, fromYear: 2022 },
  { ...input, limit: 101 },
])(
  'rejects invalid input before authentication or transport',
  async (value) => {
    const fetch = vi.fn();
    const getAuth = vi.fn(auth);
    await expect(
      make(fetch, 1000, getAuth).externalMetadata(value),
    ).rejects.toMatchObject({ status: 422 });
    expect(fetch).not.toHaveBeenCalled();
    expect(getAuth).not.toHaveBeenCalled();
  },
);
it.each([
  ['EXTERNAL_SOURCE_UNCONFIGURED', 503],
  ['EXTERNAL_SOURCE_TIMEOUT', 504],
  ['EXTERNAL_SOURCE_UNAVAILABLE', 503],
  ['EXTERNAL_AUTHORIZATION_EXPIRED', 403],
  ['EXTERNAL_SOURCE_ACCESS_DENIED', 403],
  ['EXTERNAL_METADATA_INVALID', 502],
  ['REQUEST_CANCELLED', 499],
] as const)(
  'preserves only the allowlisted %s classification',
  async (code, status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json(
          { code, message: 'private provider detail', token: 'private' },
          { status },
        ),
      );
    await expect(make(fetch).externalMetadata(input)).rejects.toMatchObject({
      status,
      code,
    });
    await make(fetch)
      .externalMetadata(input)
      .catch((error) => expect(String(error)).not.toContain('private'));
  },
);
it.each([401, 403, 500])(
  'does not trust a success or spoofed classification on status %i',
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json(
          { code: 'EXTERNAL_SOURCE_UNCONFIGURED', secret: 'private' },
          { status },
        ),
      );
    await expect(make(fetch).externalMetadata(input)).rejects.toMatchObject({
      status,
      code: undefined,
    });
  },
);
it.each([
  { ...output, sourceId: other },
  { ...output, items: [{ stationCode: '001', year: 2019 }] },
  { ...output, items: [{ stationCode: '001', year: 2020, concentration: 15 }] },
  { ...output, status: 'EMPTY' },
  { ...output, nextOffset: 3 },
  { ...output, total: 0 },
])(
  'rejects wrong-source, out-of-scope or inconsistent metadata',
  async (value) => {
    await expect(
      make(vi.fn().mockResolvedValue(Response.json(value))).externalMetadata(
        input,
      ),
    ).rejects.toMatchObject({ status: 502 });
  },
);
it('keeps an authorized empty result distinct from failure', async () => {
  const empty = { ...output, status: 'EMPTY', items: [], total: 0 };
  expect(
    await make(
      vi.fn().mockResolvedValue(Response.json(empty)),
    ).externalMetadata(input),
  ).toEqual(empty);
});
it('rejects an expired session before calling the API', async () => {
  const fetch = vi.fn();
  const getAuth = () =>
    Promise.resolve({
      auth: {
        getClaims: () =>
          Promise.resolve({
            data: { claims: { ...claims, exp: 1 } },
            error: null,
          }),
        getSession: () =>
          Promise.resolve({
            data: { session: { access_token: token } },
            error: null,
          }),
      },
    });
  await expect(
    make(fetch, 1000, getAuth).externalMetadata(input),
  ).rejects.toMatchObject({ status: 401 });
  expect(fetch).not.toHaveBeenCalled();
});
it('cancels an in-flight read and ignores a transport that returns late', async () => {
  const controller = new AbortController();
  let resolve!: (r: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const result = make(fetch).externalMetadata(input, controller.signal);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  controller.abort();
  await expect(result).rejects.toMatchObject({
    status: 499,
    code: 'REQUEST_CANCELLED',
  });
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  resolve(Response.json(output));
});
it('bounds a response body that never finishes and cancels its stream', async () => {
  const cancel = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{'));
        },
        cancel,
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  await expect(make(fetch, 30).externalMetadata(input)).rejects.toMatchObject({
    status: 504,
    code: 'EXTERNAL_SOURCE_TIMEOUT',
  });
  expect(cancel).toHaveBeenCalled();
});
it('rejects oversized error details without exposing them', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json(
      {
        code: 'EXTERNAL_SOURCE_UNCONFIGURED',
        message: 'private'.repeat(500),
      },
      { status: 503 },
    ),
  );
  await expect(make(fetch).externalMetadata(input)).rejects.toMatchObject({
    status: 502,
  });
});
