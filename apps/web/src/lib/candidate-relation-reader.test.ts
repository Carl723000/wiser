import { afterEach, expect, it, vi } from 'vitest';
import {
  readCandidateRelation,
  parseCandidateRelationOutput,
} from './candidate-relation-reader';
const id = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
const other = { ...reference, ingestionId: id(8) };
const relation = () => ({
  revision: {
    revisionId: id(4),
    relationId: id(5),
    lineageId: id(6),
    revision: 1,
    supersedesId: null,
    reference,
    mappingVersion: 'source/1',
    ruleVersion: 'relation/1',
    content: {
      subject: {
        key: 'a',
        label: 'Source object A',
        kind: 'EXTERNAL_ENTITY',
        externalId: null,
      },
      predicate: 'FLOWS_TO',
      object: {
        key: 'b',
        label: 'Source object B',
        kind: 'EXTERNAL_ENTITY',
        externalId: null,
      },
      qualifiers: {
        measure: null,
        unit: null,
        observedAt: null,
        missing: false,
        spatialScope: null,
        limitations: [],
        reportedConclusion: null,
        reportedLimit: null,
        reportedValue: null,
        context: {
          recordNature: 'SOURCE_RELATION',
          timeRole: 'PUBLICATION_TIME',
          validFrom: null,
          validTo: null,
          locationRole: 'REFERENCE_LOCATION',
          applicability: 'Background',
        },
      },
      generation: { method: 'SOURCE_FIELDS', model: null },
      evidence: [
        {
          reference,
          assetId: id(3),
          sourceHash: 'b'.repeat(64),
          locator: 'row:1',
          excerpt: null,
          polarity: 'SUPPORTS',
        },
      ],
    },
  },
  decisionVersion: 0,
  state: 'PENDING_REVIEW',
  createdAt: '2026-10-09T00:00:00Z',
});
const pin = {
  references: [reference],
  relationId: id(5),
  revision: 1,
  decisionVersion: 0,
};
const list = {
  references: [reference, other],
  first: 2,
  after: 'opaque+/cursor=',
};
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
it('posts one finite source page, preserving opaque cursor, evidence and decision state', async () => {
  const output = { relations: [relation()], nextCursor: 'another:opaque' };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json(output));
  expect(await readCandidateRelation('list', list, signal(), fetch)).toEqual(
    output,
  );
  expect(fetch).toHaveBeenCalledOnce();
  const [path, init] = fetch.mock.calls[0];
  expect(path).toBe('/api/data-foundation/candidate-relations/list');
  expect(init).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
  });
  expect(JSON.parse(init!.body as string)).toEqual(list);
});
it('gets the exact content and decision pin without promoting pending review', async () => {
  const output = { relation: relation() };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json(output));
  expect(await readCandidateRelation('get', pin, signal(), fetch)).toEqual(
    output,
  );
});
it.each(['relationId', 'revision', 'decisionVersion'] as const)(
  'rejects changed get %s',
  (key) => {
    const changed = relation();
    if (key === 'decisionVersion') changed.decisionVersion = 1;
    else if (key === 'revision') changed.revision.revision = 2;
    else changed.revision.relationId = id(9);
    expect(() =>
      parseCandidateRelationOutput('get', pin, { relation: changed }),
    ).toThrow();
  },
);
it.each(['primary', 'evidence'])(
  'rejects an out-of-manifest %s source',
  (target) => {
    const changed = relation();
    if (target === 'primary') changed.revision.reference = other;
    else changed.revision.content.evidence[0].reference = other;
    expect(() =>
      parseCandidateRelationOutput('get', pin, { relation: changed }),
    ).toThrow();
  },
);
it.each([
  'duplicate',
  'too-many',
  'empty-cursor',
  'loop-cursor',
  'extra-field',
])('rejects invalid list %s', (variant) => {
  const output: Record<string, unknown> = {
    relations: [relation()],
    nextCursor: null,
  };
  const request = {
    references: [reference],
    first: variant === 'duplicate' ? 2 : 1,
    after: 'same',
  };
  if (variant === 'duplicate' || variant === 'too-many')
    output.relations = [
      relation(),
      variant === 'duplicate'
        ? relation()
        : {
            ...relation(),
            revision: { ...relation().revision, relationId: id(9) },
          },
    ];
  if (variant === 'empty-cursor') {
    output.relations = [];
    output.nextCursor = 'next';
  }
  if (variant === 'loop-cursor') output.nextCursor = 'same';
  if (variant === 'extra-field') output.authority = 'approved';
  expect(() => parseCandidateRelationOutput('list', request, output)).toThrow();
});
it.each([401, 403, 404, 409, 410, 413, 415, 422, 500])(
  'classifies %i without exposing body or empty-list fallback',
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('private diagnostics', { status }));
    await expect(
      readCandidateRelation('list', list, signal(), fetch),
    ).rejects.toMatchObject({
      kind: [401, 403].includes(status)
        ? 'denied'
        : [404, 409, 410].includes(status)
          ? 'stale'
          : [413, 415, 422].includes(status)
            ? 'invalid'
            : 'unavailable',
    });
  },
);
it.each([
  { references: [] },
  { ...list, targetScope: { role: 'admin' } },
  { ...list, references: Array(101).fill(reference) },
])('rejects unsafe input before HTTP', async (input) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    readCandidateRelation('list', input, signal(), fetch),
  ).rejects.toMatchObject({ kind: 'invalid' });
  expect(fetch).not.toHaveBeenCalled();
});
it('does not admit a write action at runtime', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    // @ts-expect-error Runtime defense for a non-TypeScript caller.
    readCandidateRelation('review', pin, signal(), fetch),
  ).rejects.toMatchObject({ kind: 'invalid' });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['mime', 'utf8', 'length', 'stream'])(
  'bounds and validates response %s',
  async (kind) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          kind === 'stream'
            ? new Uint8Array(1048577)
            : kind === 'utf8'
              ? new Uint8Array([255])
              : new TextEncoder().encode('{}'),
        );
      },
      cancel,
    });
    const response = new Response(body, {
      headers: {
        'content-type': kind === 'mime' ? 'text/html' : 'application/json',
        ...(kind === 'length' ? { 'content-length': '1048577' } : {}),
      },
    });
    if (kind === 'utf8') {
      /* Invalid UTF-8 is rejected before waiting for more. */
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(
      readCandidateRelation('list', list, signal(), fetch),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(cancel).toHaveBeenCalled();
  },
);
it('cancels a pre-aborted request without fetching', async () => {
  const abort = new AbortController();
  abort.abort();
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    readCandidateRelation('list', list, abort.signal, fetch),
  ).rejects.toMatchObject({ kind: 'cancelled' });
  expect(fetch).not.toHaveBeenCalled();
});
it('cancels a stalled response and cannot return its late content', async () => {
  const cancel = vi.fn();
  const abort = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  const pending = readCandidateRelation('list', list, abort.signal, fetch);
  const assertion = expect(pending).rejects.toMatchObject({
    kind: 'cancelled',
  });
  await Promise.resolve();
  abort.abort();
  await assertion;
  expect(cancel).toHaveBeenCalled();
});
it('bounds a fetch that ignores its abort signal and cancels a late response', async () => {
  vi.useFakeTimers();
  let release!: (r: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = readCandidateRelation('list', list, signal(), fetch);
  const assertion = expect(pending).rejects.toMatchObject({
    kind: 'unavailable',
  });
  await vi.advanceTimersByTimeAsync(15000);
  await assertion;
  const cancel = vi.fn();
  release(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalled();
});
it('bounds a stalled response body', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  const assertion = expect(
    readCandidateRelation('list', list, signal(), fetch),
  ).rejects.toMatchObject({ kind: 'unavailable' });
  await vi.advanceTimersByTimeAsync(15000);
  await assertion;
  expect(cancel).toHaveBeenCalled();
});
