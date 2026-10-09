import { afterEach, expect, it, vi } from 'vitest';
import {
  candidateMapFeatures,
  candidateOriginalUrl,
  readCandidatePage,
  readCandidateSavedView,
} from './ingestion-candidate-reader';

const ref = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const assetId = '10000000-0000-4000-8000-000000000003';
const recordId = '10000000-0000-4000-8000-000000000004';
const viewId = '10000000-0000-4000-8000-000000000005';
const page = {
  reference: ref,
  parserVersion: 'synthetic-fixture-v1',
  status: 'PARTIAL' as const,
  createdAt: '2026-10-03T00:00:00Z',
  totalAssetCount: 2,
  knownRecordCount: 3,
  knownFeatureCount: 1,
  unknownAssetCount: 1,
  assets: [
    {
      assetId,
      sourceHash: 'b'.repeat(64),
      status: 'READY',
      recordCount: 3,
      featureCount: 1,
      reason: null,
    },
  ],
  nextCursor: 'server-cursor',
};
function requestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string')
    throw new Error('Expected a JSON string request');
  return JSON.parse(init.body) as unknown;
}
const reply = (value: unknown) => Response.json(value);
afterEach(() => vi.restoreAllMocks());
it('reads the fixed current page through the same-origin BFF without a token or scope supplied by the browser', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply(page));
  const signal = new AbortController().signal;
  const value = await readCandidatePage(
    'get',
    { ...ref, first: 1 },
    signal,
    fetch,
  );
  expect(value).toEqual(page);
  expect(fetch).toHaveBeenCalledWith(
    '/api/data-foundation/candidates/get',
    expect.objectContaining({ method: 'POST', cache: 'no-store', signal }),
  );
  const init = fetch.mock.calls[0]?.[1];
  expect(requestBody(init)).toEqual({ ...ref, first: 1 });
  expect(init?.headers).toEqual({ 'content-type': 'application/json' });
});
it.each([
  { ...page, reference: { ...ref, reviewHash: 'c'.repeat(64) } },
  { ...page, reference: { ...ref, processingBatchId: assetId } },
  {
    ...page,
    assets: [...page.assets, { ...page.assets[0], assetId: recordId }],
  },
  { ...page, nextCursor: '' },
])(
  'rejects a foreign fixed reference or page that exceeds the requested envelope',
  async (value) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(reply(value));
    await expect(
      readCandidatePage(
        'get',
        { ...ref, first: 1 },
        new AbortController().signal,
        fetch,
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
  },
);
it('preserves null, zero, empty text, nested values and original locators without interpreting the values', async () => {
  const records = {
    reference: ref,
    assetId,
    columns: [
      { key: 'value', label: 'Value' },
      { key: 'extra', label: 'Extra' },
    ],
    records: [
      {
        recordId,
        assetId,
        index: 1,
        sourceId: 'table:1/row:1',
        hasGeometry: false,
        values: { value: 0, extra: { tags: ['', null, false] } },
      },
    ],
    nextCursor: null,
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(reply(records));
  expect(
    await readCandidatePage(
      'records',
      { ...ref, assetId, first: 50 },
      new AbortController().signal,
      fetch,
    ),
  ).toEqual(records);
});
it('rejects a record page belonging to another asset', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    reply({
      reference: ref,
      assetId: recordId,
      columns: [],
      records: [],
      nextCursor: null,
    }),
  );
  await expect(
    readCandidatePage(
      'records',
      { ...ref, assetId },
      new AbortController().signal,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'invalid' });
});
it.each([
  [401, 'denied'],
  [403, 'denied'],
  [404, 'stale'],
  [409, 'stale'],
  [410, 'stale'],
  [422, 'invalid'],
  [503, 'unavailable'],
] as const)(
  'classifies %s without returning raw server messages',
  async (status, kind) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('private upstream detail', { status }));
    await expect(
      readCandidatePage('get', ref, new AbortController().signal, fetch),
    ).rejects.toMatchObject({
      kind,
      message: 'Candidate content is unavailable',
    });
  },
);
it('rejects invalid browser input before fetching', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    readCandidatePage(
      'get',
      { ...ref, versionId: assetId },
      new AbortController().signal,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'invalid' });
  expect(fetch).not.toHaveBeenCalled();
});
it('discards a response that arrives after cancellation', async () => {
  const abort = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
    abort.abort();
    return Promise.resolve(reply(page));
  });
  await expect(
    readCandidatePage('get', ref, abort.signal, fetch),
  ).rejects.toMatchObject({ kind: 'cancelled' });
});
it('cancels a stalled response promptly and releases the read lock', async () => {
  const abort = new AbortController();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'));
    },
    cancel,
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    );
  const request = readCandidatePage('get', ref, abort.signal, fetch);
  await vi.waitFor(() => expect(body.locked).toBe(true));
  abort.abort();
  await expect(
    Promise.race([
      request,
      new Promise<null>((r) => setTimeout(() => r(null), 50)),
    ]),
  ).rejects.toMatchObject({ kind: 'cancelled' });
  expect(cancel).toHaveBeenCalled();
  expect(body.locked).toBe(false);
});
it('rejects oversized streamed JSON without waiting for stream cancellation', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(3 * 1024 * 1024 + 1));
    },
    cancel,
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    );
  await expect(
    Promise.race([
      readCandidatePage('get', ref, new AbortController().signal, fetch),
      new Promise<null>((r) => setTimeout(() => r(null), 50)),
    ]),
  ).rejects.toMatchObject({ kind: 'invalid' });
  expect(cancel).toHaveBeenCalled();
  expect(body.locked).toBe(false);
});
it('builds an original download URL from candidate identity without inventing a published version', () => {
  const url = candidateOriginalUrl(ref, assetId, 'zh-CN');
  expect(url).toBe(
    `/api/data-foundation/candidate-assets/${ref.ingestionId}/${ref.processingBatchId}/${assetId}?reviewHash=${ref.reviewHash}&locale=zh-CN`,
  );
  expect(url).not.toContain('versions/');
});
it('binds a saved-context original to the canonical persisted view as well as the fixed candidate and asset', () => {
  const savedViewId = 'ABCDEF12-3456-4000-8000-000000000009';
  expect(candidateOriginalUrl(ref, assetId, 'en', savedViewId)).toBe(
    `/api/data-foundation/candidate-assets/${ref.ingestionId}/${ref.processingBatchId}/${assetId}?reviewHash=${ref.reviewHash}&locale=en&savedViewId=${savedViewId.toLowerCase()}`,
  );
});
it('binds a topic original to its canonical owner without the legacy view path', () => {
  const topicId = 'ABCDEF12-3456-4000-8000-000000000009';
  const url = candidateOriginalUrl(ref, assetId, 'en', undefined, topicId);
  expect(url).toContain(`&savedTopicId=${topicId.toLowerCase()}`);
  expect(url).not.toContain('savedViewId');
  expect(() =>
    candidateOriginalUrl(ref, assetId, 'en', topicId, topicId),
  ).toThrow();
  expect(() =>
    candidateOriginalUrl(ref, assetId, 'en', undefined, ''),
  ).toThrow();
});
it.each(['', 'not-a-view-id'])(
  'rejects invalid saved-context view %s instead of silently making a single-candidate original link',
  (savedViewId) => {
    expect(() =>
      candidateOriginalUrl(ref, assetId, 'en', savedViewId),
    ).toThrow();
  },
);
it('flattens only the render geometry while preserving one record identity, original collection and three dimensional coordinates', () => {
  const geometry = {
    type: 'GeometryCollection' as const,
    geometries: [
      { type: 'Point', coordinates: [116, 40, 9] },
      {
        type: 'LineString',
        coordinates: [
          [116, 40],
          [117, 40],
        ],
      },
    ],
  };
  const source = {
    reference: ref,
    assetId,
    crs: 'EPSG:4326' as const,
    features: [
      {
        recordId,
        assetId,
        index: 1,
        sourceId: 'row:1',
        sourceCrs: 'EPSG:4326',
        geometry,
      },
    ],
    nextCursor: null,
  };
  const snapshot = structuredClone(source);
  const map = candidateMapFeatures(source);
  expect(map.features).toHaveLength(2);
  expect(map.features[0]).toMatchObject({
    geometry: { type: 'Point', coordinates: [116, 40, 9] },
    properties: { recordId, assetId, sourceId: 'row:1' },
  });
  expect(JSON.stringify(map)).not.toMatch(
    /versionId|dataItemId|sampling|reference/,
  );
  expect(source).toEqual(snapshot);
});

it('saves only a typed fixed reference and page anchor, forwarding a mutation key to the existing BFF', async () => {
  const savedView = {
    kind: 'ingestion-candidate-view',
    viewId,
    title: 'Synthetic candidate view',
    visibility: 'private',
    createdAt: '2026-10-03T00:00:00Z',
    revokedAt: null,
  };
  const input = {
    title: savedView.title,
    references: [ref],
    visibility: 'private',
    viewSpec: {
      page: {
        kind: 'records',
        reference: ref,
        assetId,
        first: 50,
        afterRecordId: recordId,
      },
    },
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ savedView }));
  expect(
    await readCandidateSavedView(
      'create',
      input,
      new AbortController().signal,
      viewId,
      fetch,
    ),
  ).toEqual({ savedView });
  expect(fetch).toHaveBeenCalledWith(
    '/api/data-foundation/candidate-saved-views/create',
    expect.objectContaining({
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': viewId,
      },
      cache: 'no-store',
    }),
  );
  expect(requestBody(fetch.mock.calls[0]?.[1])).toEqual(input);
});
it('rejects a revoked or wrong saved view on reopen', async () => {
  const savedView = {
    kind: 'ingestion-candidate-view',
    viewId: assetId,
    title: 'Synthetic view',
    visibility: 'private',
    createdAt: '2026-10-03T00:00:00Z',
    revokedAt: null,
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      kind: 'ingestion-candidate-view',
      savedView,
      references: [ref],
      viewSpec: { page: { kind: 'assets', reference: ref, first: 50 } },
      request: {
        capabilityId: 'data.ingestion.candidate.get',
        input: { ...ref, first: 50 },
      },
    }),
  );
  await expect(
    readCandidateSavedView(
      'open',
      { viewId },
      new AbortController().signal,
      undefined,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'invalid' });
});

it('rejects a correctly identified saved view whose server response already marks it revoked', async () => {
  const savedView = {
    kind: 'ingestion-candidate-view',
    viewId,
    title: 'Synthetic view',
    visibility: 'private',
    createdAt: '2026-10-03T00:00:00Z',
    revokedAt: '2026-10-04T00:00:00Z',
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      kind: 'ingestion-candidate-view',
      savedView,
      references: [ref],
      viewSpec: { page: { kind: 'assets', reference: ref, first: 50 } },
      request: {
        capabilityId: 'data.ingestion.candidate.get',
        input: { ...ref, first: 50 },
      },
    }),
  );
  await expect(
    readCandidateSavedView(
      'open',
      { viewId },
      new AbortController().signal,
      undefined,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'invalid' });
});

it('rejects an empty material page claiming a continuation', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      reply({ ...page, assets: [], nextCursor: 'phantom-next' }),
    );
  await expect(
    readCandidatePage('get', ref, new AbortController().signal, fetch),
  ).rejects.toMatchObject({ kind: 'invalid' });
});
