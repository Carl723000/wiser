import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as DataFoundationDalModule from '@/lib/data-foundation-dal.server';
import type { VerifiedSessionClient } from '@/lib/supabase/verified-session';

const mocks = vi.hoisted(() => ({
  factory: vi.fn(),
  config: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  createWiserServerSupabaseClient: mocks.factory,
}));
vi.mock('@/lib/data-foundation-dal.server', async (original) => ({
  ...(await original<typeof DataFoundationDalModule>()),
  loadDataFoundationWebConfig: mocks.config,
}));
import { GET, HEAD } from './route';

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: 'a1000000-0000-4000-8000-000000000001',
  processingBatchId: 'a1000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const assetId = 'a1000000-0000-4000-8000-000000000003';
const inactiveReference = {
  ...reference,
  ingestionId: 'a1000000-0000-4000-8000-000000000007',
  processingBatchId: 'a1000000-0000-4000-8000-000000000008',
};
const requestScope = new AsyncLocalStorage<string>();
type Owner = 'v1' | 'v2';
interface Reading {
  key: string;
  owner: Owner;
  ownerId: string;
  token: string;
  client: VerifiedSessionClient;
  factoryScopes: string[];
  claimChecks: number;
  sessionChecks: number;
  opens: number;
  gets: number;
  revoked: boolean;
  cancelled: boolean;
  signal?: AbortSignal | null;
}
const readings = new Map<string, Reading>();

function manifest(reading: Reading) {
  const view = {
    kind: 'ingestion-candidate-view' as const,
    savedView: {
      kind: 'ingestion-candidate-view' as const,
      viewId: reading.ownerId,
      title: 'Synthetic fixed materials',
      visibility: 'private',
      createdAt: '2026-10-04T00:00:00Z',
      revokedAt: null,
    },
    references: [reference, inactiveReference],
    viewSpec: { page: { kind: 'assets', reference, first: 50 } },
    request: {
      capabilityId: 'data.ingestion.candidate.get',
      input: { ...reference, first: 50 },
    },
  };
  if (reading.owner === 'v1') return view;
  return {
    status: 'READABLE',
    specVersion: 2,
    savedView: { ...view.savedView, specVersion: 2 },
    references: view.references,
    viewSpec: {
      schemaVersion: 2,
      ...view.viewSpec,
      period: {
        windowMode: 'month',
        timeRole: 'REPORT_PERIOD',
        from: null,
        to: null,
        displayUnit: 'month',
        includeUndated: true,
      },
      topic: {
        question: 'Synthetic source inspection',
        regionIds: ['inspection-region'],
        needIds: ['inspection-need'],
        recordPins: [],
      },
      rulePins: ['projection', 'readiness', 'requirement', 'impact'].map(
        (kind) => ({
          kind,
          ruleId: `inspection-${kind}`,
          version: 'inspection/1',
        }),
      ),
      dependencyPins: [
        {
          kind: 'asset',
          reference,
          assetId,
          sourceHash: 'b'.repeat(64),
          parserVersion: 'inspection/1',
        },
      ],
      relationPins: [],
    },
    request: view.request,
  };
}

function reading(key: string, owner: Owner, suffix: '6' | '9' = '6') {
  const claims = {
    sub:
      suffix === '6'
        ? 'a1000000-0000-4000-8000-000000000004'
        : 'a1000000-0000-4000-8000-000000000005',
    session_id: `a1000000-0000-4000-8000-00000000000${suffix}`,
    role: 'authenticated',
    exp: 4102444800,
  };
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'RS256' })}.${encode(claims)}.synthetic`;
  const value: Reading = {
    key,
    owner,
    ownerId: `a1000000-0000-4000-8000-00000000000${suffix}`,
    token,
    client: {
      auth: {
        getClaims: () => {
          value.claimChecks += 1;
          return Promise.resolve({ data: { claims }, error: null });
        },
        getSession: () => {
          value.sessionChecks += 1;
          return Promise.resolve({
            data: { session: { access_token: token } },
            error: null,
          });
        },
      },
    },
    factoryScopes: [],
    claimChecks: 0,
    sessionChecks: 0,
    opens: 0,
    gets: 0,
    revoked: false,
    cancelled: false,
  };
  readings.set(key, value);
  return value;
}

async function open(reading: Reading, method: 'GET' | 'HEAD' = 'GET') {
  const query = new URLSearchParams({
    reviewHash: reference.reviewHash,
    [reading.owner === 'v1' ? 'savedViewId' : 'savedTopicId']: reading.ownerId,
  });
  return await requestScope.run(reading.key, () =>
    (method === 'HEAD' ? HEAD : GET)(
      new Request(`http://localhost/original?${query}`, { method }),
      {
        params: Promise.resolve({
          ingestionId: reference.ingestionId,
          processingBatchId: reference.processingBatchId,
          assetId,
        }),
      },
    ),
  );
}

beforeEach(() => {
  readings.clear();
  mocks.factory.mockReset();
  mocks.config.mockReturnValue({
    apiOrigin: 'http://synthetic-api:3001',
    tenantId: 'b1000000-0000-4000-8000-000000000001',
    projectId: 'b1000000-0000-4000-8000-000000000002',
    purpose: 'pending-intake',
    requestTimeoutMs: 5000,
    responseLimitBytes: 32768,
  });
  mocks.factory.mockImplementation(() => {
    const key = requestScope.getStore();
    const current = key === undefined ? undefined : readings.get(key);
    if (!current)
      throw new Error('Synthetic request factory outside its scope');
    current.factoryScopes.push(key!);
    return Promise.resolve(current.client);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>((url, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      const current = [...readings.values()].find(
        (value) => authorization === `Bearer ${value.token}`,
      );
      if (!current) throw new Error('Unexpected synthetic identity');
      const path = url instanceof Request ? url.url : url.toString();
      if (path.includes('/open')) {
        expect(path).toContain(`/${current.ownerId}/open`);
        current.opens += 1;
        // A denied inactive member rejects the entire owner manifest.
        return Promise.resolve(
          current.revoked
            ? new Response(null, { status: 403 })
            : Response.json(manifest(current)),
        );
      }
      expect(path).toContain(`/assets/${assetId}/content`);
      current.gets += 1;
      current.signal = init?.signal;
      let part = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (part === 2) controller.close();
            else
              controller.enqueue(
                new TextEncoder().encode(part++ === 0 ? 'wo' : 'rld'),
              );
          },
          cancel() {
            current.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return Promise.resolve(
        new Response(init?.method === 'HEAD' ? null : body, {
          headers: { 'content-length': '5' },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['v1', 'v2'] as const)(
  'delivers %s originals after the request handler scope has returned',
  async (owner) => {
    const current = reading('A', owner);
    const response = await open(current);
    expect(requestScope.getStore()).toBeUndefined();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('world');
    expect(current.gets).toBe(1);
    expect(current.opens).toBe(4);
    expect(current.factoryScopes.length).toBeGreaterThan(4);
    expect(new Set(current.factoryScopes)).toEqual(new Set(['A']));
    expect(current.claimChecks).toBe(current.factoryScopes.length);
    expect(current.sessionChecks).toBe(current.factoryScopes.length);
  },
);

it('keeps two interleaved request bodies and their current identities separate', async () => {
  const a = reading('A', 'v1');
  const b = reading('B', 'v2', '9');
  const [ra, rb] = await Promise.all([open(a), open(b)]);
  const readerA = ra.body!.getReader();
  const readerB = rb.body!.getReader();
  expect(new TextDecoder().decode((await readerB.read()).value)).toBe('wo');
  expect(new TextDecoder().decode((await readerA.read()).value)).toBe('wo');
  expect(new TextDecoder().decode((await readerA.read()).value)).toBe('rld');
  expect(new TextDecoder().decode((await readerB.read()).value)).toBe('rld');
  expect((await readerA.read()).done).toBe(true);
  expect((await readerB.read()).done).toBe(true);
  expect(new Set(a.factoryScopes)).toEqual(new Set(['A']));
  expect(new Set(b.factoryScopes)).toEqual(new Set(['B']));
  expect(a.opens).toBe(4);
  expect(b.opens).toBe(4);
});

it.each(['v1', 'v2'] as const)(
  'withholds the next %s chunk when an inactive manifest member loses access',
  async (owner) => {
    const current = reading('A', owner);
    const response = await open(current);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('wo');
    current.revoked = true;
    await expect(reader.read()).rejects.toMatchObject({ status: 403 });
    expect(current.opens).toBe(4);
    expect(current.cancelled).toBe(true);
  },
);

it.each(['v1', 'v2'] as const)(
  'cancels the upstream %s delivery without more owner reads',
  async (owner) => {
    const current = reading('A', owner);
    const response = await open(current);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('wo');
    await reader.cancel();
    expect(current.cancelled).toBe(true);
    expect(current.signal?.aborted).toBe(true);
    expect(current.opens).toBe(3);
  },
);

it.each(['v1', 'v2'] as const)(
  'retains empty authenticated %s HEAD responses',
  async (owner) => {
    const current = reading('A', owner);
    const response = await open(current, 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('5');
    expect(await response.text()).toBe('');
    expect(current.opens).toBe(2);
  },
);
