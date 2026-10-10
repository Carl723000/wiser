import { expect, it, vi } from 'vitest';
import { readCandidateConversionProvenance } from './ingestion-candidate-reader';
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const preparedAssetId = '10000000-0000-4000-8000-000000000003';
const input = { ...reference, preparedAssetId };
const output = { reference, preparedAssetId, check: null };
it('reads server conversion provenance without browser authority claims', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json(output));
  const signal = new AbortController().signal;
  await expect(
    readCandidateConversionProvenance(input, signal, fetch),
  ).resolves.toEqual(output);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe(
    '/api/data-foundation/candidate-provenance',
  );
  const init = fetch.mock.calls[0]?.[1];
  expect(init).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request');
  const body: unknown = JSON.parse(init.body);
  expect(body).toEqual(input);
});
it.each([
  { ...output, reference: { ...reference, reviewHash: 'b'.repeat(64) } },
  { ...output, preparedAssetId: reference.ingestionId },
  { ...output, check: { state: 'VERIFIED_EQUIVALENT' } },
])(
  'rejects provenance outside the fixed member and trusted schema',
  async (value) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(value));
    await expect(
      readCandidateConversionProvenance(
        input,
        new AbortController().signal,
        fetch,
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
  },
);
it.each([
  [401, 'denied'],
  [403, 'denied'],
  [404, 'stale'],
  [409, 'stale'],
  [410, 'stale'],
  [413, 'invalid'],
  [422, 'invalid'],
  [503, 'unavailable'],
] as const)(
  'preserves safe failure category for status %s',
  async (status, kind) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ privateDiagnostic: 'not exposed' }, { status }),
      );
    await expect(
      readCandidateConversionProvenance(
        input,
        new AbortController().signal,
        fetch,
      ),
    ).rejects.toMatchObject({ kind });
  },
);
it('rejects client-supplied verification before making a request', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(
    readCandidateConversionProvenance(
      { ...input, verified: true },
      new AbortController().signal,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'invalid' });
  expect(fetch).not.toHaveBeenCalled();
});
it('discards a successful late response after cancellation', async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
    controller.abort();
    return Promise.resolve(Response.json(output));
  });
  await expect(
    readCandidateConversionProvenance(input, controller.signal, fetch),
  ).rejects.toMatchObject({ kind: 'cancelled' });
});
it('bounds the streamed response even without a content length', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(' '.repeat(3 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(
    readCandidateConversionProvenance(
      input,
      new AbortController().signal,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'invalid' });
});
