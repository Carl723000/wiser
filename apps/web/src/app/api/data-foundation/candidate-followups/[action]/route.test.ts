import { afterEach, expect, it, vi } from 'vitest';
const { followup, getDal } = vi.hoisted(() => ({
  followup: vi.fn(),
  getDal: vi.fn(),
}));
vi.mock('@/lib/data-foundation-dal.server', () => ({
  getDataFoundationDal: getDal,
  DataFoundationApiError: class extends Error {},
}));
import { POST } from './route';
const id = '11111111-1111-4111-8111-111111111111';
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id,
  processingBatchId: id,
  reviewHash: 'a'.repeat(64),
};
const source = {
  reference,
  assetId: id,
  sourceHash: 'b'.repeat(64),
  locator: `asset:${id}`,
};
const inputs = {
  create: {
    type: 'GAP',
    source,
    ruleId: 'missing-source',
    ruleVersion: '1',
    reason: 'Missing source',
  },
  get: { followupId: id },
  list: { ...reference, first: 25 },
  act: { followupId: id, expectedVersion: 1, action: 'CLAIM', note: 'Claim' },
  review: {
    followupId: id,
    expectedVersion: 1,
    decision: 'RETURN',
    note: 'Recheck',
  },
};
function req(
  input: unknown,
  origin = 'http://localhost',
  key: string | null = id,
) {
  return new Request(
    'http://localhost/api/data-foundation/candidate-followups/create',
    {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin,
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(input),
    },
  );
}
const call = (action: string, request: Request) =>
  POST(request, { params: Promise.resolve({ action }) });
afterEach(() => vi.resetAllMocks());
it.each(Object.entries(inputs))(
  'forwards exact %s input, idempotency and cancellation',
  async (action, input) => {
    getDal.mockResolvedValue({ candidateFollowup: followup });
    followup.mockResolvedValue({ items: [], nextCursor: null });
    const request = req(input);
    expect((await call(action, request)).status).toBe(200);
    expect(followup).toHaveBeenCalledWith(
      action,
      input,
      ['create', 'act', 'review'].includes(action) ? id : undefined,
      request.signal,
    );
  },
);
it.each([
  ['create', { ...inputs.create, targetScope: { role: 'admin' } }, 422],
  ['act', { ...inputs.act, targetActorType: 'human' }, 422],
  ['unknown', {}, 404],
  ['get', {}, 422],
])(
  'rejects unadmitted %s input before identity acquisition',
  async (action, input, status) => {
    expect((await call(String(action), req(input))).status).toBe(status);
    expect(getDal).not.toHaveBeenCalled();
  },
);
it('rejects cross-origin and missing command idempotency before the DAL', async () => {
  expect(
    (await call('create', req(inputs.create, 'https://foreign.example')))
      .status,
  ).toBe(403);
  expect(
    (await call('create', req(inputs.create, 'http://localhost', null))).status,
  ).toBe(422);
  expect(getDal).not.toHaveBeenCalled();
});
it('bounds streamed input before parsing or identity acquisition', async () => {
  const request = new Request(
    'http://localhost/api/data-foundation/candidate-followups/list',
    {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost' },
      body: 'x'.repeat(131073),
    },
  );
  const output = await call('list', request);
  expect(output.status).toBe(413);
  expect(output.headers.get('cache-control')).toBe('private, no-store');
  expect(getDal).not.toHaveBeenCalled();
});
