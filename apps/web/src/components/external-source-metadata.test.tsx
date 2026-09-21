// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExternalSourceMetadata } from './external-source-metadata';
const sourceId = '10000000-0000-4000-8000-000000000001';
const page = {
  sourceId,
  status: 'AVAILABLE',
  items: [{ stationCode: '001', year: 2020, province: 'Example' }],
  total: 2,
  nextOffset: 1,
  checkedAt: '2026-09-20T10:00:00Z',
  timePrecision: 'year',
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('clears metadata when the source changes or the page becomes hidden', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(Response.json(page))),
  );
  const { rerender } = render(
    <ExternalSourceMetadata sourceId={sourceId} locale="zh-CN" />,
  );
  await query();
  expect(await screen.findByText('001')).toBeTruthy();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(screen.queryByText('001')).toBeNull();
  vi.restoreAllMocks();
  await userEvent.click(screen.getByRole('button', { name: '查询站点目录' }));
  expect(await screen.findByText('001')).toBeTruthy();
  rerender(
    <ExternalSourceMetadata
      sourceId="10000000-0000-4000-8000-000000000002"
      locale="zh-CN"
    />,
  );
  expect(screen.queryByText('001')).toBeNull();
});
it('retains the applied years for continuation and clears results when editing', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() =>
      Promise.resolve(
        Response.json({ ...page, nextOffset: undefined, total: 1 }),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  render(<ExternalSourceMetadata sourceId={sourceId} locale="zh-CN" />);
  const user = await query();
  expect(await screen.findByText('001')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
  await user.clear(screen.getByLabelText('起始年份'));
  expect(screen.queryByText('001')).toBeNull();
  await user.click(screen.getByRole('button', { name: '查询站点目录' }));
  expect(screen.getByText('请填写有效的起止年份。')).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});
async function query() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('起始年份'), '2020');
  await user.type(screen.getByLabelText('结束年份'), '2021');
  await user.click(screen.getByRole('button', { name: '查询站点目录' }));
  return user;
}
it('does not fetch on opening; a deliberate query returns metadata and denial clears the prior page', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(page))
    .mockResolvedValueOnce(
      Response.json(
        { code: 'EXTERNAL_AUTHORIZATION_EXPIRED' },
        { status: 403 },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  render(<ExternalSourceMetadata sourceId={sourceId} locale="zh-CN" />);
  expect(fetch).not.toHaveBeenCalled();
  const user = await query();
  expect(await screen.findByText('001')).toBeTruthy();
  expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
    sourceId,
    fromYear: 2020,
    toYear: 2021,
    offset: 0,
    limit: 25,
  });
  expect(fetch.mock.calls[0][0]).toBe('/api/data-foundation/external-metadata');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  expect(
    await screen.findByText('来源授权已过期，请联系项目管理员。'),
  ).toBeTruthy();
  expect(screen.queryByText('001')).toBeNull();
});
it.each([
  [503, 'EXTERNAL_SOURCE_UNCONFIGURED', '此来源尚未开通在线查询。'],
  [403, 'FORBIDDEN', '当前账号没有此来源的访问权限。'],
  [504, 'EXTERNAL_SOURCE_TIMEOUT', '来源响应超时，请稍后重试。'],
  [401, 'AUTHENTICATION_REQUIRED', '登录已失效，请重新登录后查询。'],
])('shows a distinct safe state for %s/%s', async (status, code, message) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ code, message: 'private token' }, { status }),
      ),
  );
  render(<ExternalSourceMetadata sourceId={sourceId} locale="zh-CN" />);
  await query();
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.queryByText(/private token/)).toBeNull();
});
it('keeps empty results distinct from failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        ...page,
        status: 'EMPTY',
        items: [],
        total: 0,
        nextOffset: undefined,
      }),
    ),
  );
  render(<ExternalSourceMetadata sourceId={sourceId} locale="zh-CN" />);
  await query();
  expect(
    await screen.findByText('此年度范围内没有可访问的站点记录。'),
  ).toBeTruthy();
});
it('ignores a cancelled response even when the transport ignores abort', async () => {
  let resolve!: (r: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<ExternalSourceMetadata sourceId={sourceId} locale="zh-CN" />);
  const user = await query();
  await user.click(screen.getByRole('button', { name: '取消查询' }));
  resolve(Response.json(page));
  await vi.waitFor(() =>
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true),
  );
  expect(screen.queryByText('001')).toBeNull();
});
it('rejects unexpected fields instead of rendering restricted values', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        ...page,
        items: [{ stationCode: '001', year: 2020, concentration: 123 }],
      }),
    ),
  );
  render(<ExternalSourceMetadata sourceId={sourceId} locale="zh-CN" />);
  await query();
  expect(
    await screen.findByText('暂时无法读取此来源，请稍后重试。'),
  ).toBeTruthy();
  expect(screen.queryByText('001')).toBeNull();
});
