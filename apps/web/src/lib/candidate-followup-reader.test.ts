import { expect, it, vi } from 'vitest';
import { readCandidateFollowup } from './candidate-followup-reader';
const id = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id,
  processingBatchId: id,
  reviewHash: 'a'.repeat(64),
};
const signal = () => new AbortController().signal;
it('reads exactly one authorized source page with no browser identity or scope', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ items: [], nextCursor: null }));
  expect(
    await readCandidateFollowup(
      'list',
      { ...reference, first: 25 },
      signal(),
      undefined,
      fetch,
    ),
  ).toEqual({ items: [], nextCursor: null });
  expect(fetch).toHaveBeenCalledWith(
    '/api/data-foundation/candidate-followups/list',
    expect.objectContaining({ cache: 'no-store', method: 'POST' }),
  );
  const init = fetch.mock.calls[0]?.[1];
  if (!init || typeof init.body !== 'string')
    throw new Error('Expected a serialized request body');
  expect(init.headers).toEqual({ 'content-type': 'application/json' });
  expect(JSON.parse(init.body)).not.toHaveProperty('targetScope');
});
it.each([401, 403, 404, 409, 410, 422, 503])(
  'classifies %s without exposing server details',
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('private details', { status }));
    await expect(
      readCandidateFollowup(
        'get',
        { followupId: id },
        signal(),
        undefined,
        fetch,
      ),
    ).rejects.toMatchObject({
      kind: [401, 403].includes(status)
        ? 'denied'
        : [404, 409, 410].includes(status)
          ? 'stale'
          : status === 422
            ? 'invalid'
            : 'unavailable',
    });
  },
);
it('rejects client authority and missing idempotency before fetching', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    readCandidateFollowup(
      'act',
      {
        followupId: id,
        expectedVersion: 1,
        action: 'HANDOFF',
        targetActorId: id,
        targetScope: { role: 'admin' },
        note: 'Handoff',
      },
      signal(),
      id,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'invalid' });
  await expect(
    readCandidateFollowup(
      'review',
      {
        followupId: id,
        expectedVersion: 1,
        decision: 'RETURN',
        note: 'Return',
      },
      signal(),
      undefined,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'invalid' });
  expect(fetch).not.toHaveBeenCalled();
});
it('bounds the response and closes a cancelled late result', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response('x'.repeat(2097153), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(
    readCandidateFollowup('list', reference, signal(), undefined, fetch),
  ).rejects.toMatchObject({ kind: 'invalid' });
  const controller = new AbortController();
  fetch.mockImplementation(() => {
    controller.abort();
    return Promise.resolve(Response.json({ items: [], nextCursor: null }));
  });
  await expect(
    readCandidateFollowup(
      'list',
      reference,
      controller.signal,
      undefined,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'cancelled' });
});

it('classifies a network rejection as unavailable without exposing its details', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new TypeError('private connection detail'));
  await expect(
    readCandidateFollowup(
      'get',
      { followupId: id },
      signal(),
      undefined,
      fetch,
    ),
  ).rejects.toMatchObject({
    kind: 'unavailable',
    message: 'Candidate content is unavailable',
  });
});
