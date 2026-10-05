import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_CAPABILITY_REGISTRY } from '@wiser/data-contracts';

vi.mock('server-only', () => ({}));

import {
  createDataFoundationDal,
  DataFoundationApiError,
  loadDataFoundationWebConfig,
  proxyDataFoundationGeoRequest,
  proxyDataFoundationAssetRequest,
  type DataFoundationAuthClient,
} from './data-foundation-dal.server';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const GEO_VERSION_ID = '55555555-5555-4555-8555-555555555555';

const operationEvent = (sequence: number, operationId = GEO_VERSION_ID) => ({
  eventId: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  operationId,
  sequence,
  operationVersion: sequence,
  eventType: 'PROGRESS_REPORTED',
  status: 'RUNNING',
  progressPercent: 10,
  occurredAt: '2026-10-05T00:00:00Z',
});
const eventResponse = (items: unknown[], cursor?: string) =>
  new Response(
    items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''),
    {
      headers: {
        'content-type': 'text/event-stream',
        ...(cursor === undefined ? {} : { 'X-Next-Cursor': cursor }),
      },
    },
  );
function eventDal(fetch: typeof globalThis.fetch) {
  return createDataFoundationDal({
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'read',
      requestTimeoutMs: 50,
      responseLimitBytes: 100_000,
    },
    createAuthClient: () => Promise.resolve(authClient([])),
    fetch,
  });
}

describe('same-operation bounded event continuation', () => {
  it('rejects an operation summary for another task before combining it with events', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({
          operationId: PROJECT_ID,
          resource: 'ingestion',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          capabilityId: 'data.ingestion.create',
          status: 'RUNNING',
          progressPercent: 10,
          version: 1,
          createdAt: '2026-10-05T00:00:00Z',
          updatedAt: '2026-10-05T00:00:00Z',
        }),
      );
    await expect(
      eventDal(fetch).operation(GEO_VERSION_ID),
    ).rejects.toMatchObject({ kind: 'contract' });
  });
  it.each([1, 2048])(
    'retains a single %i-character cursor and requests exactly one next page',
    async (length) => {
      const cursor = 'c'.repeat(length);
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(eventResponse([operationEvent(1)], cursor))
        .mockResolvedValueOnce(eventResponse([operationEvent(2)]));
      const dal = eventDal(fetch);
      const first = await dal.operationEvents(GEO_VERSION_ID);
      expect(first).toMatchObject({
        items: [{ sequence: 1 }],
        nextCursor: cursor,
      });
      const read = dal.operationEvents as unknown as (
        id: string,
        after?: string,
      ) => Promise<unknown>;
      expect(await read(GEO_VERSION_ID, cursor)).toMatchObject({
        items: [{ sequence: 2 }],
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      const url = new URL(String(fetch.mock.calls[1][0]));
      expect(url.pathname).toBe(
        `/api/data/v1/operations/${GEO_VERSION_ID}/events`,
      );
      expect(url.searchParams.get('first')).toBe('100');
      expect(url.searchParams.get('after')).toBe(cursor);
      expect(
        new Headers(fetch.mock.calls[1][1]?.headers).get('X-WISER-Project-ID'),
      ).toBe(PROJECT_ID);
    },
  );
  it.each([7, 100])(
    'ends a %i-event page only when the header is absent',
    async (count) => {
      expect(
        await eventDal(
          vi
            .fn()
            .mockResolvedValue(
              eventResponse(
                Array.from({ length: count }, (_, i) => operationEvent(i + 1)),
              ),
            ),
        ).operationEvents(GEO_VERSION_ID),
      ).toMatchObject({ items: expect.any(Array) });
    },
  );
  it.each(['', 'x'.repeat(2049), 'one,two'])(
    'rejects a malformed cursor header without rendering it',
    async (cursor) => {
      await expect(
        eventDal(
          vi.fn().mockResolvedValue(eventResponse([operationEvent(1)], cursor)),
        ).operationEvents(GEO_VERSION_ID),
      ).rejects.toMatchObject({ kind: 'contract', status: 502 });
    },
  );
  it.each([
    [operationEvent(1, PROJECT_ID)],
    [operationEvent(2), operationEvent(1)],
    [operationEvent(1), operationEvent(1)],
    Array.from({ length: 101 }, (_, i) => operationEvent(i + 1)),
  ])(
    'rejects mixed-operation, reversed, repeated or oversized pages',
    async (...items) => {
      await expect(
        eventDal(
          vi.fn().mockResolvedValue(eventResponse(items)),
        ).operationEvents(GEO_VERSION_ID),
      ).rejects.toMatchObject({ kind: 'contract', status: 502 });
    },
  );
  it('rejects an empty page with continuation and a self-loop', async () => {
    await expect(
      eventDal(
        vi.fn().mockResolvedValue(eventResponse([], 'next')),
      ).operationEvents(GEO_VERSION_ID),
    ).rejects.toMatchObject({ kind: 'contract' });
    const read = eventDal(
      vi.fn().mockResolvedValue(eventResponse([operationEvent(2)], 'same')),
    ).operationEvents as unknown as (
      id: string,
      after: string,
    ) => Promise<unknown>;
    await expect(read(GEO_VERSION_ID, 'same')).rejects.toMatchObject({
      kind: 'contract',
    });
  });
  it.each([
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not-found'],
    [400, 'invalid-request'],
    [422, 'invalid-request'],
    [503, 'unavailable'],
  ])(
    'preserves the actual continuation %i classification',
    async (status, kind) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response('private upstream text', { status: Number(status) }),
        );
      const read = eventDal(fetch).operationEvents as unknown as (
        id: string,
        after: string,
      ) => Promise<unknown>;
      await expect(read(GEO_VERSION_ID, 'cursor')).rejects.toMatchObject({
        kind,
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds an unresolved continuation request', async () => {
    const read = eventDal(vi.fn(() => new Promise<Response>(() => {})))
      .operationEvents as unknown as (
      id: string,
      after: string,
    ) => Promise<unknown>;
    await expect(read(GEO_VERSION_ID, 'cursor')).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});

it('preserves structured relation filters in the authenticated HTTP request', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ items: [], totalCount: 0 }));
  const dal = createDataFoundationDal({
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'read',
      requestTimeoutMs: 5000,
      responseLimitBytes: 32768,
    },
    createAuthClient: () => Promise.resolve(authClient([])),
    fetch,
  });
  const relatedSources = [
    { dataItemId: PROJECT_ID, versionId: GEO_VERSION_ID },
  ];
  const entityReference = {
    ...relatedSources[0],
    mappingVersion: 'source-v1',
    entityKey: 'person:1',
  };
  await dal.relations('list', {
    dataItemId: PROJECT_ID,
    versionId: GEO_VERSION_ID,
    relatedSources,
    entityReference,
  });
  const calledUrl = fetch.mock.calls[0]?.[0];
  if (typeof calledUrl !== 'string') throw Error('Expected serialized URL');
  const url = new URL(calledUrl);
  expect(JSON.parse(url.searchParams.get('relatedSources') ?? 'null')).toEqual(
    relatedSources,
  );
  expect(JSON.parse(url.searchParams.get('entityReference') ?? 'null')).toEqual(
    entityReference,
  );
});

it('streams a source preview with verified identity, range support and an inert document policy', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response('<h1>Source</h1>', {
        status: 206,
        headers: {
          'content-type': 'text/html',
          'content-range': 'bytes 0-14/30',
          'set-cookie': 'private=secret',
        },
      }),
    ),
  );
  const response = await proxyDataFoundationAssetRequest({
    request: new Request(
      'http://web.local/api/data-foundation/assets/source?mode=preview&filename=report.html',
      { headers: { range: 'bytes=0-14' } },
    ),
    versionId: GEO_VERSION_ID,
    assetId: PROJECT_ID,
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'read',
      requestTimeoutMs: 5000,
      responseLimitBytes: 32768,
    },
    createAuthClient: () => Promise.resolve(authClient([])),
    fetch,
  });
  expect(response.status).toBe(206);
  expect(await response.text()).toBe('<h1>Source</h1>');
  expect(response.headers.get('content-security-policy')).toContain('sandbox');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('content-disposition')).toContain('inline');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('range')).toBe(
    'bytes=0-14',
  );
  expect(
    new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization'),
  ).toBe(`Bearer ${accessToken()}`);
  expect((fetch.mock.calls[0][0] as URL).href).toContain(
    `/versions/${GEO_VERSION_ID}/assets/${PROJECT_ID}/content`,
  );
});

it('allows the native PDF viewer while preserving strict MIME and document restrictions', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response('<h1>Source</h1>', {
        status: 206,
        headers: {
          'content-type': 'application/pdf',
          'content-range': 'bytes 0-14/30',
          'set-cookie': 'private=secret',
        },
      }),
    ),
  );
  const response = await proxyDataFoundationAssetRequest({
    request: new Request(
      'http://web.local/api/data-foundation/assets/source?mode=preview&filename=report.pdf',
      { headers: { range: 'bytes=0-14' } },
    ),
    versionId: GEO_VERSION_ID,
    assetId: PROJECT_ID,
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'read',
      requestTimeoutMs: 5000,
      responseLimitBytes: 32768,
    },
    createAuthClient: () => Promise.resolve(authClient([])),
    fetch,
  });
  expect(response.status).toBe(206);
  expect(await response.text()).toBe('<h1>Source</h1>');
  expect(response.headers.get('content-security-policy')).not.toContain(
    'sandbox',
  );
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('content-disposition')).toContain('inline');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('range')).toBe(
    'bytes=0-14',
  );
  expect(
    new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization'),
  ).toBe(`Bearer ${accessToken()}`);
  expect((fetch.mock.calls[0][0] as URL).href).toContain(
    `/versions/${GEO_VERSION_ID}/assets/${PROJECT_ID}/content`,
  );
});

it('does not advertise discarded upstream bytes on an unsatisfiable source range', async () => {
  const response = await proxyDataFoundationAssetRequest({
    request: new Request(
      'http://web.local/api/data-foundation/assets/source?mode=download',
      { headers: { range: 'bytes=20-30' } },
    ),
    versionId: GEO_VERSION_ID,
    assetId: PROJECT_ID,
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'read',
      requestTimeoutMs: 5000,
      responseLimitBytes: 32768,
    },
    createAuthClient: () => Promise.resolve(authClient([])),
    fetch: () =>
      Promise.resolve(
        new Response('error', {
          status: 416,
          headers: { 'content-length': '5', 'content-range': 'bytes */12' },
        }),
      ),
  });
  expect(await response.text()).toBe('');
  expect(response.headers.get('content-length')).toBe('0');
});

it.each(['search', 'knowledge'] as const)(
  'continues %s with the same query and bounded cursor page',
  async (method) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [], nextCursor: 'next' }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const dal = createDataFoundationDal({
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'data-steward-console',
        requestTimeoutMs: 5000,
        responseLimitBytes: 32768,
      },
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch,
    });
    await expect(dal[method]('HydroATLAS', 'cursor-1')).resolves.toEqual({
      items: [],
      nextCursor: 'next',
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ query: 'HydroATLAS', first: 10, after: 'cursor-1' }),
    );
  },
);

function accessToken(): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: USER_ID,
    session_id: SESSION_ID,
    role: 'authenticated',
    exp: 4_102_444_800,
  })}.signature`;
}

function authClient(order: string[]): DataFoundationAuthClient {
  return {
    auth: {
      getClaims() {
        order.push('claims');
        return Promise.resolve({
          data: {
            claims: {
              sub: USER_ID,
              session_id: SESSION_ID,
              role: 'authenticated',
              exp: 4_102_444_800,
            },
          },
          error: null,
        });
      },
      getSession() {
        order.push('session');
        return Promise.resolve({
          data: { session: { access_token: accessToken() } },
          error: null,
        });
      },
    },
  };
}

function geoFeature(featureId: string) {
  return {
    featureId,
    dataItemId: PROJECT_ID,
    versionId: GEO_VERSION_ID,
    geometry: {
      type: 'Point',
      coordinates: [116.2, 39.8],
      crs: 'EPSG:4490',
    },
    properties: {},
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Data Foundation server-only HTTP DAL', () => {
  it('uses the independently approved Web purpose for default browser reads', async () => {
    const config = loadDataFoundationWebConfig({
      NODE_ENV: 'test',
      WISER_DATA_API_INTERNAL_URL: 'http://api:3001',
      WISER_DATA_TENANT_ID: TENANT_ID,
      WISER_DATA_PROJECT_ID: PROJECT_ID,
    });
    if (!config) throw new Error('Expected complete Web scope');
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ items: [] })),
    );
    const dal = createDataFoundationDal({
      config,
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });
    await dal.catalog({ first: 25 });
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-wiser-purpose'),
    ).toBe('web-console');
  });

  it('fails closed when the server API scope is incomplete', () => {
    expect(
      loadDataFoundationWebConfig({
        NODE_ENV: 'test',
        WISER_DATA_API_INTERNAL_URL: 'http://api:3001',
        WISER_DATA_TENANT_ID: TENANT_ID,
      }),
    ).toBeNull();
  });

  it('verifies Supabase claims before forwarding the raw access token', async () => {
    const order: string[] = [];
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      order.push('fetch');
      expect(init?.cache).toBe('no-store');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${accessToken()}`,
      );
      expect(new Headers(init?.headers).get('x-wiser-tenant-id')).toBe(
        TENANT_ID,
      );
      expect(new Headers(init?.headers).get('x-wiser-project-id')).toBe(
        PROJECT_ID,
      );
      expect(new Headers(init?.headers).get('x-wiser-purpose')).toBe(
        'data-steward-console',
      );
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const dal = createDataFoundationDal({
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'data-steward-console',
        requestTimeoutMs: 5_000,
        responseLimitBytes: 32_768,
      },
      createAuthClient: () => Promise.resolve(authClient(order)),
      fetch,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });

    await expect(dal.catalog({ first: 25 })).resolves.toEqual({ items: [] });
    expect(order).toEqual(['claims', 'session', 'fetch']);
  });

  it('classifies API authorization and availability failures without returning bodies', async () => {
    for (const [status, kind] of [
      [401, 'authentication'],
      [403, 'authorization'],
      [404, 'not-found'],
      [503, 'unavailable'],
    ] as const) {
      const dal = createDataFoundationDal({
        config: {
          apiOrigin: 'http://api:3001',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          purpose: 'data-steward-console',
          requestTimeoutMs: 5_000,
          responseLimitBytes: 32_768,
        },
        createAuthClient: () => Promise.resolve(authClient([])),
        fetch: () =>
          Promise.resolve(
            new Response('sensitive upstream details', { status }),
          ),
      });

      await expect(dal.catalog({ first: 25 })).rejects.toMatchObject({
        kind,
        status,
      });
      await expect(dal.catalog({ first: 25 })).rejects.not.toThrow(
        /sensitive upstream details/,
      );
    }
  });

  it('rejects oversized responses before parsing them', async () => {
    const dal = createDataFoundationDal({
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'data-steward-console',
        requestTimeoutMs: 5_000,
        responseLimitBytes: 32,
      },
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ items: [], padding: 'x'.repeat(100) }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
    });

    await expect(dal.catalog({ first: 25 })).rejects.toBeInstanceOf(
      DataFoundationApiError,
    );
    await expect(dal.catalog({ first: 25 })).rejects.toMatchObject({
      kind: 'contract',
    });
  });

  it('parses an authenticated degraded health document returned with HTTP 503', async () => {
    const dal = createDataFoundationDal({
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'data-steward-console',
        requestTimeoutMs: 5_000,
        responseLimitBytes: 32_768,
      },
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'degraded',
              authority: { database: true, objectStore: false },
              worker: false,
              projections: 'rebuildable',
            }),
            {
              status: 503,
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
    });

    await expect(dal.health()).resolves.toEqual({
      status: 'degraded',
      database: true,
      objectStore: false,
      worker: false,
      projections: 'rebuildable',
    });
  });

  it('collects every governed geo page with the same immutable query', async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') {
        throw new Error('expected the geo request body to be serialized JSON');
      }
      bodies.push(JSON.parse(init.body) as unknown);
      const page = bodies.length;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            page === 1
              ? {
                  features: [geoFeature('extent-a')],
                  nextCursor: 'cursor-1',
                }
              : { features: [geoFeature('extent-b')] },
          ),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const dal = createDataFoundationDal({
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'data-steward-console',
        requestTimeoutMs: 5_000,
        responseLimitBytes: 32_768,
      },
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch,
    });

    await expect(
      dal.geo({
        geometry: {
          type: 'Point',
          coordinates: [116.2, 39.8],
          crs: 'EPSG:4490',
        },
        versionId: GEO_VERSION_ID,
      }),
    ).resolves.toEqual({
      features: [
        {
          featureId: 'extent-a',
          dataItemId: PROJECT_ID,
          versionId: GEO_VERSION_ID,
          geometry: {
            type: 'Point',
            coordinates: [116.2, 39.8],
            crs: 'EPSG:4490',
          },
        },
        {
          featureId: 'extent-b',
          dataItemId: PROJECT_ID,
          versionId: GEO_VERSION_ID,
          geometry: {
            type: 'Point',
            coordinates: [116.2, 39.8],
            crs: 'EPSG:4490',
          },
        },
      ],
    });
    const query = {
      geometry: {
        type: 'Point',
        coordinates: [116.2, 39.8],
        crs: 'EPSG:4490',
      },
      predicates: ['INTERSECTS'],
      versionId: GEO_VERSION_ID,
      first: 100,
    };
    expect(bodies).toEqual([query, { ...query, after: 'cursor-1' }]);
    await expect(
      Promise.resolve().then(() =>
        dal.geo({
          geometry: {
            type: 'Point',
            coordinates: [116.2, 39.8],
            crs: 'EPSG:4490',
          },
          versionId: 'not-a-version',
        }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed instead of following a repeated geo cursor forever', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            features: [geoFeature('extent-loop')],
            nextCursor: 'cursor-loop',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const dal = createDataFoundationDal({
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'data-steward-console',
        requestTimeoutMs: 5_000,
        responseLimitBytes: 32_768,
      },
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch,
    });

    await expect(
      dal.geo({
        geometry: {
          type: 'Point',
          coordinates: [116.2, 39.8],
          crs: 'EPSG:4490',
        },
        versionId: GEO_VERSION_ID,
      }),
    ).rejects.toMatchObject({ kind: 'contract' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a paged geo result that cannot fit the 10,000 feature map bound', async () => {
    const features = Array.from({ length: 100 }, (_, index) =>
      geoFeature(`extent-${index}`),
    );
    let page = 0;
    const fetch = vi.fn(() => {
      page += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            features,
            nextCursor: `cursor-${page}`,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const dal = createDataFoundationDal({
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'data-steward-console',
        requestTimeoutMs: 5_000,
        responseLimitBytes: 1_000_000,
      },
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch,
    });

    await expect(
      dal.geo({
        geometry: {
          type: 'Point',
          coordinates: [116.2, 39.8],
          crs: 'EPSG:4490',
        },
        versionId: GEO_VERSION_ID,
      }),
    ).rejects.toMatchObject({ kind: 'contract' });
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(100);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(101);
  });

  it.each(['versions', 'queries', 'amap/versions', 'amap/queries'])(
    'keeps %s browser tiles same-origin with server-only credentials',
    async (kind) => {
      const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const requestedUrl =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        expect(requestedUrl).toBe(
          `http://api:3001/api/data/v1/geo/tiles/vector/${kind}/` +
            '55555555-5555-4555-8555-555555555555/3/4/2.pbf',
        );
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer ${accessToken()}`,
        );
        return Promise.resolve(
          new Response(Uint8Array.from([26, 0]), {
            headers: {
              'content-type': 'application/vnd.mapbox-vector-tile',
              'set-cookie': 'upstream-secret=must-not-cross',
            },
          }),
        );
      });
      const response = await proxyDataFoundationGeoRequest({
        request: new Request(
          `http://web.local/api/data-foundation/geo/tiles/vector/${kind}/` +
            '55555555-5555-4555-8555-555555555555/3/4/2.pbf',
        ),
        path: [
          'tiles',
          'vector',
          ...kind.split('/'),
          '55555555-5555-4555-8555-555555555555',
          '3',
          '4',
          '2.pbf',
        ],
        config: {
          apiOrigin: 'http://api:3001',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          purpose: 'data-steward-console',
          requestTimeoutMs: 5_000,
          responseLimitBytes: 32_768,
        },
        createAuthClient: () => Promise.resolve(authClient([])),
        fetch,
        now: () => new Date('2026-08-22T00:00:00.000Z'),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/vnd.mapbox-vector-tile',
      );
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.arrayBuffer()).toEqual(
        Uint8Array.from([26, 0]).buffer,
      );
    },
  );

  it('rejects arbitrary origins, traversal, and client-supplied raster sources before fetch', async () => {
    const fetch = vi.fn();
    const base = {
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'data-steward-console',
        requestTimeoutMs: 5_000,
        responseLimitBytes: 32_768,
      },
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    } as const;
    await expect(
      proxyDataFoundationGeoRequest({
        ...base,
        request: new Request('http://web.local/api/data-foundation/geo/x'),
        path: ['..', 'http://169.254.169.254/latest/meta-data'],
      }),
    ).rejects.toMatchObject({ kind: 'invalid-request' });
    await expect(
      proxyDataFoundationGeoRequest({
        ...base,
        request: new Request(
          'http://web.local/api/data-foundation/geo/tiles/raster/versions/' +
            `${USER_ID}/WebMercatorQuad/1/1/1.png?url=http://evil`,
        ),
        path: [
          'tiles',
          'raster',
          'versions',
          USER_ID,
          'WebMercatorQuad',
          '1',
          '1',
          '1.png',
        ],
      }),
    ).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('forwards saved-view mutations with a stable command key and rejects malformed view identities before HTTP', async () => {
  const order: string[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ viewId: GEO_VERSION_ID, revoked: true })),
    );
  const dal = createDataFoundationDal({
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'data-steward-console',
      requestTimeoutMs: 5000,
      responseLimitBytes: 32768,
    },
    createAuthClient: () => Promise.resolve(authClient(order)),
    fetch,
    now: () => new Date('2026-08-22T00:00:00Z'),
  });
  await expect(
    dal.explorationView('revoke', { viewId: GEO_VERSION_ID }, SESSION_ID),
  ).resolves.toEqual({ viewId: GEO_VERSION_ID, revoked: true });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    `http://api:3001/api/data/v1/explore/views/${GEO_VERSION_ID}/revoke`,
  );
  expect(
    new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Idempotency-Key'),
  ).toBe(SESSION_ID);
  expect(order).toEqual(['claims', 'session']);
  expect(fetch.mock.calls[0]?.[1]?.body).toBe('{}');
  expect(() => dal.explorationView('open', { viewId: '../secrets' })).toThrow(
    DataFoundationApiError,
  );
  expect(() =>
    dal.explorationView('revoke', { viewId: GEO_VERSION_ID }, 'invalid'),
  ).toThrow(DataFoundationApiError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('binds reconciliation reads to the requested batch and sends review preconditions with the verified session', async () => {
  const order: string[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ items: [] }));
  const dal = createDataFoundationDal({
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'data-steward-console',
      requestTimeoutMs: 5000,
      responseLimitBytes: 32768,
    },
    createAuthClient: () => Promise.resolve(authClient(order)),
    fetch,
    now: () => new Date('2026-08-22T00:00:00Z'),
  });
  await expect(
    dal.reconcile('list', { versionId: GEO_VERSION_ID }),
  ).resolves.toEqual({ items: [] });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    `http://api:3001/api/data/v1/reconciliations?versionId=${GEO_VERSION_ID}`,
  );
  expect(order).toEqual(['claims', 'session']);
  fetch.mockResolvedValue(
    Response.json({ private: 'diagnostic' }, { status: 409 }),
  );
  await expect(
    dal.reconcile(
      'review',
      {
        batchId: GEO_VERSION_ID,
        expectedVersion: 1,
        decision: 'verify',
        note: 'Checked source evidence',
      },
      SESSION_ID,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const request = fetch.mock.calls[1];
  expect(request?.[0]).toBe(
    `http://api:3001/api/data/v1/reconciliations/${GEO_VERSION_ID}/review`,
  );
  const headers = new Headers(request?.[1]?.headers);
  expect(headers.get('If-Match')).toBe('"v1"');
  expect(headers.get('Idempotency-Key')).toBe(SESSION_ID);
  expect(headers.get('Authorization')).toMatch(/^Bearer /);
  const reviewBody = request?.[1]?.body;
  if (typeof reviewBody !== 'string')
    throw new Error('Expected a JSON review body');
  expect(JSON.parse(reviewBody)).toEqual({
    expectedVersion: 1,
    decision: 'verify',
    note: 'Checked source evidence',
  });
  await expect(
    dal.reconcile('get', {
      batchId: GEO_VERSION_ID,
      groupIndex: 0,
      first: 10,
      after: 'cursor',
    }),
  ).rejects.toMatchObject({ status: 409 });
  const memberRequest = fetch.mock.calls[2]?.[0];
  if (typeof memberRequest !== 'string')
    throw new Error('Expected a serialized URL');
  const memberUrl = new URL(memberRequest);
  expect(memberUrl.pathname).toBe(
    `/api/data/v1/reconciliations/${GEO_VERSION_ID}`,
  );
  expect(Object.fromEntries(memberUrl.searchParams)).toEqual({
    first: '10',
    after: 'cursor',
    groupIndex: '0',
  });
  expect(() => dal.reconcile('get', { batchId: '../secrets' })).toThrow(
    DataFoundationApiError,
  );
  expect(() =>
    dal.reconcile('review', {
      batchId: GEO_VERSION_ID,
      expectedVersion: 1,
      decision: 'verify',
      note: 'Checked',
    }),
  ).toThrow(DataFoundationApiError);
  expect(() =>
    dal.reconcile(
      'review',
      {
        batchId: GEO_VERSION_ID,
        expectedVersion: 1,
        decision: 'verify',
        note: 'Checked',
      },
      'invalid',
    ),
  ).toThrow(DataFoundationApiError);
  expect(fetch).toHaveBeenCalledTimes(3);
});

for (const version of ['1.6.0', '1.7.0']) {
  it(`negotiates bounded project pages against advertised ${version} without changing cursor or scope`, async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>((input) => {
      if (typeof input !== 'string') throw Error('Expected URL string');
      const url = input;
      if (url.endsWith('/capabilities'))
        return Promise.resolve(
          Response.json({
            registryVersion: '1.0.0',
            capabilities: [
              {
                ...DATA_CAPABILITY_REGISTRY['data.knowledge.relations.list'],
                version,
              },
            ],
          }),
        );
      return Promise.resolve(Response.json({ items: [], totalCount: 0 }));
    });
    const dal = createDataFoundationDal({
      config: {
        apiOrigin: 'http://api:3001',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'read',
        requestTimeoutMs: 5000,
        responseLimitBytes: 1048576,
      },
      createAuthClient: () => Promise.resolve(authClient([])),
      fetch: fetcher,
    });
    await dal.relations('list', {
      queryId: PROJECT_ID,
      status: 'PENDING_REVIEW',
      pageMode: 'BOUNDED_PROJECT',
      first: 500,
      after: GEO_VERSION_ID,
    });
    const requests = fetcher.mock.calls.map((call) => {
      if (typeof call[0] !== 'string') throw Error('Expected URL');
      return new URL(call[0]);
    });
    expect(requests.some((url) => url.pathname.endsWith('/capabilities'))).toBe(
      true,
    );
    const page = requests.find((url) => url.pathname.endsWith('/relations'))!;
    expect(page.searchParams.get('first')).toBe(
      version === '1.7.0' ? '500' : '100',
    );
    expect(page.searchParams.get('pageMode')).toBe(
      version === '1.7.0' ? 'BOUNDED_PROJECT' : null,
    );
    expect(page.searchParams.get('queryId')).toBe(PROJECT_ID);
    expect(page.searchParams.get('after')).toBe(GEO_VERSION_ID);
    expect(page.searchParams.get('status')).toBe('PENDING_REVIEW');
  });
}
it('does not turn capability authorization failure into a legacy retry', async () => {
  const fetcher = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('', { status: 403 }));
  const dal = createDataFoundationDal({
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'read',
      requestTimeoutMs: 5000,
      responseLimitBytes: 1048576,
    },
    createAuthClient: () => Promise.resolve(authClient([])),
    fetch: fetcher,
  });
  await expect(
    dal.relations('list', {
      queryId: PROJECT_ID,
      pageMode: 'BOUNDED_PROJECT',
      first: 500,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(fetcher.mock.calls[0]?.[0]).toEqual(
    expect.stringContaining('/capabilities'),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const candidateReference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: PROJECT_ID,
  processingBatchId: GEO_VERSION_ID,
  reviewHash: 'a'.repeat(64),
};

const candidateViewId = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
const candidateViewMetadata = {
  kind: 'ingestion-candidate-view' as const,
  viewId: candidateViewId,
  title: 'Pending source',
  visibility: 'private',
  createdAt: '2026-10-04T00:00:00Z',
  revokedAt: null,
};
function candidateViewInput() {
  return {
    title: candidateViewMetadata.title,
    visibility: 'private',
    references: [candidateReference],
    viewSpec: {
      page: {
        kind: 'records',
        reference: candidateReference,
        assetId: USER_ID,
        first: 10,
      },
    },
  };
}
function candidateViewOpen() {
  const input = candidateViewInput();
  return {
    kind: 'ingestion-candidate-view',
    savedView: candidateViewMetadata,
    references: input.references,
    viewSpec: input.viewSpec,
    request: {
      capabilityId: 'data.ingestion.candidate.records',
      input: { ...candidateReference, assetId: USER_ID, first: 10 },
    },
  };
}
function candidateViewOutput(action: 'create' | 'list' | 'open' | 'revoke') {
  if (action === 'create') return { savedView: candidateViewMetadata };
  if (action === 'list')
    return { items: [candidateViewMetadata], nextCursor: null };
  if (action === 'open') return candidateViewOpen();
  return { viewId: candidateViewId, revoked: true };
}
const candidateAsset = {
  assetId: USER_ID,
  sourceHash: 'b'.repeat(64),
  status: 'READY',
  recordCount: 1,
  featureCount: 1,
  reason: null,
};
function candidatePage(action: 'get' | 'records' | 'geometry') {
  const common = { reference: candidateReference, nextCursor: null };
  if (action === 'get')
    return {
      ...common,
      parserVersion: 'test-v1',
      status: 'READY',
      createdAt: '2026-10-03T00:00:00Z',
      totalAssetCount: 1,
      knownRecordCount: 1,
      knownFeatureCount: 1,
      unknownAssetCount: 0,
      assets: [candidateAsset],
    };
  const record = {
    recordId: SESSION_ID,
    assetId: USER_ID,
    index: 1,
    sourceId: 'original-1',
  };
  if (action === 'records')
    return {
      ...common,
      assetId: USER_ID,
      columns: [{ key: 'value', label: 'Original value' }],
      records: [{ ...record, values: { value: 0 }, hasGeometry: true }],
    };
  return {
    ...common,
    assetId: USER_ID,
    crs: 'EPSG:4326',
    features: [
      {
        ...record,
        sourceCrs: 'EPSG:4326',
        geometry: { type: 'Point', coordinates: [116.2, 39.8] },
      },
    ],
  };
}
function candidateDal(
  fetch: typeof globalThis.fetch,
  config: { requestTimeoutMs?: number; responseLimitBytes?: number } = {},
  createAuthClient = () => Promise.resolve(authClient([])),
) {
  return createDataFoundationDal({
    config: {
      apiOrigin: 'http://api:3001',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'review',
      requestTimeoutMs: 5000,
      responseLimitBytes: 4 * 1024 * 1024,
      ...config,
    },
    createAuthClient,
    fetch,
  });
}
function ingestionDetail() {
  return {
    ingestion: {
      ingestionId: PROJECT_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      assetIds: [USER_ID],
      intendedUses: ['review'],
      requestedSecurityLevel: 'L0_PUBLIC',
      state: 'REVIEW_REQUIRED',
      version: 1,
      createdAt: '2026-10-03T00:00:00Z',
      updatedAt: '2026-10-03T00:00:00Z',
    },
    candidateReference,
  };
}

describe('fixed candidate transport', () => {
  it('retains a null candidate reference when no readable batch exists', async () => {
    const detail = { ...ingestionDetail(), candidateReference: null };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json(detail)),
    );
    await expect(
      candidateDal(fetch).ingestionDetail(PROJECT_ID),
    ).resolves.toEqual(detail);
  });
  it('compares ingestion UUID identity without rejecting a valid uppercase path', async () => {
    const detail = {
      ...ingestionDetail(),
      ingestion: {
        ...ingestionDetail().ingestion,
        ingestionId: 'abcdefab-cdef-4abc-8abc-abcdefabcdef',
      },
      candidateReference: {
        ...candidateReference,
        ingestionId: 'abcdefab-cdef-4abc-8abc-abcdefabcdef',
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json(detail)),
    );
    await expect(
      candidateDal(fetch).ingestionDetail(
        detail.ingestion.ingestionId.toUpperCase(),
      ),
    ).resolves.toEqual(detail);
  });
  it('compares candidate UUID identities without rejecting canonical lowercase replies', async () => {
    const reference = {
      ...candidateReference,
      ingestionId: 'abcdefab-cdef-4abc-8abc-abcdefabcdef',
      processingBatchId: 'bcdefabc-defa-4bcd-8bcd-bcdefabcdefa',
    };
    const assetId = 'cdefabcd-efab-4cde-8cde-cdefabcdefab';
    const page = {
      ...candidatePage('records'),
      reference,
      assetId,
      records: [],
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json(page)),
    );
    await expect(
      candidateDal(fetch).candidate('records', {
        ...reference,
        ingestionId: reference.ingestionId.toUpperCase(),
        processingBatchId: reference.processingBatchId.toUpperCase(),
        assetId: assetId.toUpperCase(),
      }),
    ).resolves.toEqual(page);
  });
  it('preserves the strict 1.2 ingestion detail and leaves the old ingestion method available', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json(ingestionDetail())),
    );
    const dal = candidateDal(fetch);
    await expect(dal.ingestionDetail(PROJECT_ID)).resolves.toEqual(
      ingestionDetail(),
    );
    await expect(dal.ingestion(PROJECT_ID)).resolves.toMatchObject({
      ingestionId: PROJECT_ID,
    });
  });
  it.each([
    { ingestion: { ...ingestionDetail().ingestion, ingestionId: USER_ID } },
    { ingestion: { ...ingestionDetail().ingestion, tenantId: USER_ID } },
    { ingestion: { ...ingestionDetail().ingestion, projectId: USER_ID } },
    { candidateReference: { ...candidateReference, ingestionId: USER_ID } },
    { candidateReference: undefined },
    { internalStorageKey: 'private/path' },
  ])(
    'rejects a mismatched or non-strict ingestion detail %j',
    async (change) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(Response.json({ ...ingestionDetail(), ...change })),
      );
      await expect(
        candidateDal(fetch).ingestionDetail(PROJECT_ID),
      ).rejects.toMatchObject({
        kind: 'contract',
        status: 502,
      });
    },
  );
  it.each(['get', 'records', 'geometry'] as const)(
    'uses the registered %s path and retains the fixed reference, pagination and server scope',
    async (action) => {
      const order: string[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(() => {
        order.push('fetch');
        return Promise.resolve(Response.json(candidatePage(action)));
      });
      const input = {
        ...candidateReference,
        ...(action === 'get' ? {} : { assetId: USER_ID }),
        first: 10,
        after: 'cursor:original/+ =',
      };
      await expect(
        candidateDal(fetch, {}, () =>
          Promise.resolve(authClient(order)),
        ).candidate(action, input),
      ).resolves.toEqual(candidatePage(action));
      expect(order).toEqual(['claims', 'session', 'fetch']);
      const url = new URL(fetch.mock.calls[0][0] as string);
      expect(url.pathname).toBe(
        `/api/data/v1/ingestions/${PROJECT_ID}/candidates/${GEO_VERSION_ID}` +
          (action === 'get' ? '' : `/${USER_ID}/${action}`),
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        kind: 'ingestion-candidate',
        reviewHash: candidateReference.reviewHash,
        first: '10',
        after: input.after,
      });
      const init = fetch.mock.calls[0][1];
      if (!init) throw Error('Expected HTTP request options');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${accessToken()}`);
      expect(headers.get('x-wiser-tenant-id')).toBe(TENANT_ID);
      expect(headers.get('x-wiser-project-id')).toBe(PROJECT_ID);
      expect(headers.get('x-wiser-purpose')).toBe('review');
      expect(init).toMatchObject({
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
      });
      expect(init.body).toBeUndefined();
    },
  );
  it.each([
    { ...candidateReference, versionId: USER_ID },
    { ...candidateReference, ingestionId: '../private' },
    { ...candidateReference, first: 201 },
    { ...candidateReference, after: '' },
    { ...candidateReference, reviewHash: 'A'.repeat(64) },
  ])(
    'rejects invalid input before session access or HTTP %j',
    async (input) => {
      const auth = vi.fn(() => Promise.resolve(authClient([])));
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        candidateDal(fetch, {}, auth).candidate('get', input),
      ).rejects.toMatchObject({ status: 422 });
      expect(auth).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['get', 'records', 'geometry'] as const)(
    'rejects a different %s review hash without fallback',
    async (action) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          Response.json({
            ...candidatePage(action),
            reference: { ...candidateReference, reviewHash: 'c'.repeat(64) },
          }),
        ),
      );
      await expect(
        candidateDal(fetch).candidate(action, {
          ...candidateReference,
          ...(action === 'get' ? {} : { assetId: USER_ID }),
        }),
      ).rejects.toMatchObject({ kind: 'contract', status: 502 });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['records', 'geometry'] as const)(
    'rejects a different %s original asset even when the page is empty',
    async (action) => {
      const page = {
        ...candidatePage(action),
        assetId: SESSION_ID,
        ...(action === 'records' ? { records: [] } : { features: [] }),
      };
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(Response.json(page)),
      );
      await expect(
        candidateDal(fetch).candidate(action, {
          ...candidateReference,
          assetId: USER_ID,
        }),
      ).rejects.toMatchObject({ status: 502 });
    },
  );
  it.each(['get', 'records', 'geometry'] as const)(
    'rejects an empty %s page with a continuation cursor',
    async (action) => {
      const key =
        action === 'get'
          ? 'assets'
          : action === 'records'
            ? 'records'
            : 'features';
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          Response.json({
            ...candidatePage(action),
            [key]: [],
            nextCursor: 'next',
          }),
        ),
      );
      await expect(
        candidateDal(fetch).candidate(action, {
          ...candidateReference,
          ...(action === 'get' ? {} : { assetId: USER_ID }),
        }),
      ).rejects.toMatchObject({ status: 502 });
    },
  );
  it('rejects pages larger than first, despite being valid under the shared output schema', async () => {
    const page = candidatePage('get');
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json({
          ...page,
          totalAssetCount: 2,
          assets: [candidateAsset, { ...candidateAsset, assetId: SESSION_ID }],
        }),
      ),
    );
    await expect(
      candidateDal(fetch).candidate('get', { ...candidateReference, first: 1 }),
    ).rejects.toMatchObject({ status: 502 });
  });
  it.each([128, 3 * 1024 * 1024])(
    'bounds streamed response bytes at the smaller candidate/config limit %i',
    async (limit) => {
      const cancel = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(limit + 1));
              },
              cancel,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
      await expect(
        candidateDal(fetch, {
          responseLimitBytes: limit === 128 ? limit : 4 * 1024 * 1024,
        }).candidate('get', candidateReference),
      ).rejects.toMatchObject({ status: 502 });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('keeps the deadline active after headers and cancels a stalled body', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(
      candidateDal(fetch, { requestTimeoutMs: 20 }).candidate(
        'get',
        candidateReference,
      ),
    ).rejects.toMatchObject({ kind: 'unavailable', status: 504 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels a streaming candidate response and never exposes its partial body', async () => {
    const cancel = vi.fn();
    const caller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('private upstream body'),
              );
              queueMicrotask(() => caller.abort());
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(
      candidateDal(fetch).candidate('get', candidateReference, caller.signal),
    ).rejects.toMatchObject({ kind: 'unavailable', status: 499 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('rejects a previously cancelled call before accessing the session', async () => {
    const auth = vi.fn(() => Promise.resolve(authClient([])));
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      candidateDal(fetch, {}, auth).candidate(
        'get',
        candidateReference,
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ status: 499 });
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a verified session and preserves authorization failure without reading raw diagnostics', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('private upstream URL', { status: 403 })),
    );
    await expect(
      candidateDal(fetch, {}, () =>
        Promise.resolve({
          auth: {
            ...authClient([]).auth,
            getClaims: () => Promise.resolve({ data: null, error: null }),
          },
        }),
      ).candidate('get', candidateReference),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      candidateDal(fetch).candidate('get', candidateReference),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Data Foundation request failed: authorization.',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([{ ingestionId: USER_ID }, { processingBatchId: USER_ID }])(
    'rejects a response from another ingestion or batch %j',
    async (change) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          Response.json({
            ...candidatePage('get'),
            reference: { ...candidateReference, ...change },
          }),
        ),
      );
      await expect(
        candidateDal(fetch).candidate('get', candidateReference),
      ).rejects.toMatchObject({ kind: 'contract', status: 502 });
    },
  );
  it.each(['get', 'records', 'geometry'] as const)(
    'rejects unknown fields in the %s output',
    async (action) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          Response.json({
            ...candidatePage(action),
            internalUrl: 'https://private.example/storage',
          }),
        ),
      );
      await expect(
        candidateDal(fetch).candidate(action, {
          ...candidateReference,
          ...(action === 'get' ? {} : { assetId: USER_ID }),
        }),
      ).rejects.toMatchObject({ kind: 'contract', status: 502 });
    },
  );
  it('retains the default first and allows a terminal empty page without a false continuation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json({
          ...candidatePage('records'),
          records: [],
          nextCursor: null,
        }),
      ),
    );
    await expect(
      candidateDal(fetch).candidate('records', {
        ...candidateReference,
        assetId: USER_ID,
      }),
    ).resolves.toMatchObject({ records: [], nextCursor: null });
    expect(
      new URL(fetch.mock.calls[0][0] as string).searchParams.get('first'),
    ).toBe('50');
  });
  it('bounds an unresolved verified-session lookup and never starts HTTP after its deadline', async () => {
    let resolveAuth!: (client: DataFoundationAuthClient) => void;
    const pendingAuth = new Promise<DataFoundationAuthClient>((resolve) => {
      resolveAuth = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const reading = candidateDal(
      fetch,
      { requestTimeoutMs: 20 },
      () => pendingAuth,
    ).candidate('get', candidateReference);
    await expect(reading).rejects.toMatchObject({ status: 504 });
    resolveAuth(authClient([]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the old DAL unavailable status on a fetch deadline', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise<Response>(() => {}),
    );
    await expect(
      candidateDal(fetch, { requestTimeoutMs: 20 }).health(),
    ).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
  });
  it('cancels a late HTTP response even when the transport ignores cancellation', async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() => pendingFetch);
    const reading = candidateDal(fetch, { requestTimeoutMs: 20 }).candidate(
      'get',
      candidateReference,
    );
    await expect(reading).rejects.toMatchObject({ status: 504 });
    const cancel = vi.fn();
    resolveFetch(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects malformed ingestion identity and a non-read candidate action before session access', async () => {
    const auth = vi.fn(() => Promise.resolve(authClient([])));
    const fetch = vi.fn<typeof globalThis.fetch>();
    const dal = candidateDal(fetch, {}, auth);
    expect(() => dal.ingestionDetail('../private')).toThrow(
      DataFoundationApiError,
    );
    await expect(
      dal.candidate('publish' as 'get', candidateReference),
    ).rejects.toMatchObject({ status: 422 });
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('fixed candidate saved-view transport', () => {
  it.each(['create', 'list', 'open', 'revoke'] as const)(
    'uses the registered %s method, path, identity and fixed server scope',
    async (action) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(Response.json(candidateViewOutput(action))),
      );
      const input =
        action === 'create'
          ? candidateViewInput()
          : action === 'list'
            ? { first: 2, after: 'cursor:one/+ =' }
            : { viewId: candidateViewId };
      const key =
        action === 'create' || action === 'revoke' ? SESSION_ID : undefined;
      await expect(
        candidateDal(fetch).candidateSavedView(action, input, key),
      ).resolves.toEqual(candidateViewOutput(action));
      const [url, init] = fetch.mock.calls[0];
      if (typeof url !== 'string' || !init)
        throw Error('Expected HTTP request');
      const parsed = new URL(url);
      const capability =
        DATA_CAPABILITY_REGISTRY[`data.ingestion.candidate.view.${action}`];
      expect(parsed.pathname).toBe(
        capability.restMapping.path.replace(':viewId', candidateViewId),
      );
      expect(init.method).toBe(capability.restMapping.method);
      expect(init.cache).toBe('no-store');
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('x-wiser-tenant-id')).toBe(
        TENANT_ID,
      );
      expect(new Headers(init.headers).get('x-wiser-project-id')).toBe(
        PROJECT_ID,
      );
      expect(new Headers(init.headers).get('x-wiser-purpose')).toBe('review');
      expect(new Headers(init.headers).get('authorization')).toBe(
        `Bearer ${accessToken()}`,
      );
      expect(new Headers(init.headers).get('idempotency-key')).toBe(
        key ?? null,
      );
      if (action === 'list') {
        expect(Object.fromEntries(parsed.searchParams)).toEqual({
          first: '2',
          after: 'cursor:one/+ =',
        });
        expect(init.body).toBeUndefined();
      } else {
        expect(parsed.search).toBe('');
        if (typeof init.body !== 'string') throw Error('Expected JSON body');
        expect(JSON.parse(init.body)).toEqual(action === 'create' ? input : {});
      }
    },
  );
  it('uses an opened fixed request in the existing three-read candidate DAL', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(candidateViewOpen()))
      .mockResolvedValueOnce(Response.json(candidatePage('records')));
    const dal = candidateDal(fetch);
    const opened = await dal.candidateSavedView('open', {
      viewId: candidateViewId,
    });
    expect(opened).toMatchObject({ kind: 'ingestion-candidate-view' });
    const request = (opened as ReturnType<typeof candidateViewOpen>).request;
    await expect(dal.candidate('records', request.input)).resolves.toEqual(
      candidatePage('records'),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['create', { ...candidateViewInput(), tenantId: USER_ID }, SESSION_ID],
    [
      'create',
      {
        ...candidateViewInput(),
        references: [{ ...candidateReference, versionId: USER_ID }],
      },
      SESSION_ID,
    ],
    ['create', { ...candidateViewInput(), references: [] }, SESSION_ID],
    [
      'create',
      {
        ...candidateViewInput(),
        viewSpec: {
          page: {
            ...candidateViewInput().viewSpec.page,
            reference: { ...candidateReference, reviewHash: 'b'.repeat(64) },
          },
        },
      },
      SESSION_ID,
    ],
    ['create', candidateViewInput(), undefined],
    ['revoke', { viewId: candidateViewId }, 'bad-key'],
    ['list', { first: 101 }, undefined],
    ['list', { queryId: PROJECT_ID }, undefined],
    ['open', { viewId: '../private' }, undefined],
    [
      'open',
      { viewId: candidateViewId, references: [candidateReference] },
      undefined,
    ],
  ] as const)(
    'rejects invalid %s input or command identity before authentication',
    async (action, input, key) => {
      const auth = vi.fn(() => Promise.resolve(authClient([])));
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        candidateDal(fetch, {}, auth).candidateSavedView(action, input, key),
      ).rejects.toMatchObject({ status: 422 });
      expect(auth).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['create', 'list', 'open', 'revoke'] as const)(
    'rejects unknown fields in strict %s output',
    async (action) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          Response.json({
            ...candidateViewOutput(action),
            internalUrl: 'https://private/storage',
          }),
        ),
      );
      const input =
        action === 'create'
          ? candidateViewInput()
          : action === 'list'
            ? {}
            : { viewId: candidateViewId };
      await expect(
        candidateDal(fetch).candidateSavedView(action, input, SESSION_ID),
      ).rejects.toMatchObject({ kind: 'contract', status: 502 });
    },
  );
  it.each(['open', 'revoke'] as const)(
    'rejects a %s result for another saved view',
    async (action) => {
      const output =
        action === 'open'
          ? {
              ...candidateViewOpen(),
              savedView: { ...candidateViewMetadata, viewId: USER_ID },
            }
          : { viewId: USER_ID, revoked: true };
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(Response.json(output)),
      );
      await expect(
        candidateDal(fetch).candidateSavedView(
          action,
          { viewId: candidateViewId },
          SESSION_ID,
        ),
      ).rejects.toMatchObject({ status: 502 });
    },
  );
  it('preserves semantic UUID identity for an uppercase saved-view path', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json(candidateViewOpen())),
    );
    await expect(
      candidateDal(fetch).candidateSavedView('open', {
        viewId: candidateViewId.toUpperCase(),
      }),
    ).resolves.toEqual(candidateViewOpen());
  });
  it.each([
    { savedView: { ...candidateViewMetadata, kind: 'exploration-view' } },
    {
      request: {
        ...candidateViewOpen().request,
        input: {
          ...candidateViewOpen().request.input,
          reviewHash: 'b'.repeat(64),
        },
      },
    },
    {
      request: {
        ...candidateViewOpen().request,
        input: { ...candidateViewOpen().request.input, assetId: SESSION_ID },
      },
    },
    { references: [] },
    {
      savedView: {
        ...candidateViewMetadata,
        revokedAt: '2026-10-04T01:00:00Z',
      },
    },
  ])(
    'rejects a non-candidate, revoked or inconsistent fixed open response %j',
    async (change) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(Response.json({ ...candidateViewOpen(), ...change })),
      );
      await expect(
        candidateDal(fetch).candidateSavedView('open', {
          viewId: candidateViewId,
        }),
      ).rejects.toMatchObject({ status: 502 });
    },
  );
  it.each([
    { items: [], nextCursor: 'next' },
    {
      items: [
        candidateViewMetadata,
        { ...candidateViewMetadata, viewId: USER_ID },
      ],
      nextCursor: null,
    },
    { items: [candidateViewMetadata, candidateViewMetadata], nextCursor: null },
    {
      items: [{ ...candidateViewMetadata, revokedAt: '2026-10-04T01:00:00Z' }],
      nextCursor: null,
    },
  ])(
    'rejects inconsistent or oversized saved-list pages %j',
    async (output) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(Response.json(output)),
      );
      await expect(
        candidateDal(fetch).candidateSavedView('list', {
          first:
            output.items.length === 2 &&
            output.items[0].viewId === output.items[1].viewId
              ? 2
              : 1,
        }),
      ).rejects.toMatchObject({ status: 502 });
    },
  );
  it('accepts an empty terminal saved-list page and sends the default page size', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ items: [], nextCursor: null })),
    );
    await expect(
      candidateDal(fetch).candidateSavedView('list', {}),
    ).resolves.toEqual({ items: [], nextCursor: null });
    const [url] = fetch.mock.calls[0];
    if (typeof url !== 'string') throw Error('Expected URL');
    expect(new URL(url).searchParams.get('first')).toBe('20');
  });
  it.each([64, 128 * 1024])(
    'bounds response bytes by the saved-view/config limit %i',
    async (limit) => {
      const cancel = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(limit + 1));
              },
              cancel,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
      await expect(
        candidateDal(fetch, {
          responseLimitBytes: limit === 64 ? limit : 4 * 1024 * 1024,
        }).candidateSavedView('list', {}),
      ).rejects.toMatchObject({ status: 502 });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('keeps the deadline active while reading a saved configuration', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(
      candidateDal(fetch, { requestTimeoutMs: 20 }).candidateSavedView('open', {
        viewId: candidateViewId,
      }),
    ).rejects.toMatchObject({ status: 504 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('passes cancellation through mutation delivery without falling back to published views', async () => {
    const caller = new AbortController();
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('private upstream body'),
              );
              queueMicrotask(() => caller.abort());
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(
      candidateDal(fetch).candidateSavedView(
        'create',
        candidateViewInput(),
        SESSION_ID,
        caller.signal,
      ),
    ).rejects.toMatchObject({ status: 499 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('requires verified session and keeps upstream denials safe and final', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('private SQL diagnostic', { status: 403 })),
    );
    await expect(
      candidateDal(fetch).candidateSavedView('open', {
        viewId: candidateViewId,
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Data Foundation request failed: authorization.',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
