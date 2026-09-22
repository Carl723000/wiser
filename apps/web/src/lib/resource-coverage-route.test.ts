import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const { explore, getDal } = vi.hoisted(() => ({
  explore: vi.fn(),
  getDal: vi.fn(),
}));
vi.mock('./data-foundation-dal.server', () => ({
  getDataFoundationDal: getDal,
  DataFoundationApiError: class extends Error {
    constructor(
      readonly kind: string,
      readonly status: number,
    ) {
      super(kind);
    }
  },
}));
import { GET } from '../app/api/platform/resources/route';
import { DataFoundationApiError } from './data-foundation-dal.server';
const tenantId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const queryId = '33333333-3333-4333-8333-333333333333';
const base = `http://wiser.test/api/platform/resources?tenantId=${tenantId}&projectId=${projectId}`;
afterEach(() => vi.resetAllMocks());
it('uses the selected scope with the current caller and preserves server totals beyond the page', async () => {
  getDal.mockResolvedValue({ explore });
  const result = {
    queryId,
    resources: [{ name: 'one visible resource' }],
    totalCount: 155,
    summary: { resourceCount: 155 },
  };
  explore.mockResolvedValue(result);
  const response = await GET(new Request(base + '&text=水质&records=READY'));
  expect(response.status).toBe(200);
  expect(getDal).toHaveBeenCalledWith({ tenantId, projectId });
  expect(explore).toHaveBeenCalledWith({
    view: 'resources',
    first: 20,
    spec: { text: '水质', readiness: { records: ['READY'] } },
  });
  expect(await response.json()).toEqual(result);
  expect(response.headers.get('cache-control')).toContain('no-store');
});
it('continues a fixed result set without reconstructing its membership from the visible page', async () => {
  getDal.mockResolvedValue({ explore });
  explore.mockResolvedValue({ resources: [] });
  await GET(new Request(base + `&queryId=${queryId}&after=cursor-20`));
  expect(explore).toHaveBeenCalledWith({
    view: 'resources',
    first: 20,
    queryId,
    after: 'cursor-20',
  });
});
it('rejects impersonation, malformed context, conflicting filters and duplicate parameters before any data call', async () => {
  for (const suffix of [
    '&actorId=' + queryId,
    '&token=x',
    '&projectId=' + projectId,
    '&first=10000',
    '&records=made-up',
    '&after=x',
    `&queryId=${queryId}&text=private`,
  ]) {
    expect((await GET(new Request(base + suffix))).status).toBe(400);
  }
  expect(
    (
      await GET(
        new Request('http://wiser.test/api/platform/resources?projectId=x'),
      )
    ).status,
  ).toBe(400);
  expect(getDal).not.toHaveBeenCalled();
});
it('does not return stale resources or backend error details after revoked access', async () => {
  getDal.mockResolvedValue({ explore });
  explore.mockRejectedValue(new DataFoundationApiError('authorization', 403));
  const response = await GET(new Request(base));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    code: 'RESOURCE_COVERAGE_UNAVAILABLE',
  });
  expect(response.headers.get('cache-control')).toContain('no-store');
});
