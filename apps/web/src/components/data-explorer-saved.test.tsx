// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataExplorerSaved } from './data-explorer-saved';
import { ExplorationViewSpecSchema } from '@wiser/data-contracts';
const id = '10000000-0000-4000-8000-000000000001';
const viewId = '20000000-0000-4000-8000-000000000001';
const spec = ExplorationViewSpecSchema.parse({
  activeView: 'resources',
  requests: { resources: { queryId: id, view: 'resources', first: 25 } },
});
const savedView = {
  viewId,
  title: 'River review',
  visibility: 'private',
  createdAt: new Date().toISOString(),
  revokedAt: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('keeps mutation retries idempotent, creates a durable private link and revokes it', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ items: [] }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ savedView }))
    .mockResolvedValueOnce(Response.json({ viewId, revoked: true }));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(<DataExplorerSaved locale="en" queryId={id} capture={() => spec} />);
  expect(fetch).not.toHaveBeenCalled();
  await user.click(screen.getByText('Save, share and export'));
  await user.type(screen.getByLabelText('View name'), 'River review');
  await user.click(screen.getByRole('button', { name: 'Save view' }));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button', { name: 'Save view' }));
  const link = await screen.findByRole('link', { name: 'River review' });
  expect(link.getAttribute('href')).toBe(
    `/en/data-foundation/explore?saved=${viewId}`,
  );
  const attempts = fetch.mock.calls.filter(
    ([url]) => url === '/api/data-foundation/explore/views/create',
  );
  expect(attempts).toHaveLength(2);
  expect(new Headers(attempts[0]?.[1]?.headers).get('Idempotency-Key')).toBe(
    new Headers(attempts[1]?.[1]?.headers).get('Idempotency-Key'),
  );
  const body = attempts[1]?.[1]?.body;
  expect(typeof body === 'string' ? JSON.parse(body) : null).toMatchObject({
    visibility: 'private',
    viewSpec: spec,
  });
  await user.click(screen.getByRole('button', { name: 'Copy link' }));
  await screen.findByText('Link copied.');
  await user.click(screen.getByRole('button', { name: 'Revoke link' }));
  await screen.findByText('View link revoked.');
  expect(screen.queryByRole('link', { name: 'River review' })).toBeNull();
});
it('refuses to save an unfinished view without sending its stale data', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(
    <DataExplorerSaved locale="zh-CN" queryId={id} capture={() => null} />,
  );
  await user.click(screen.getByText('保存、分享与导出'));
  await user.type(screen.getByLabelText('视图名称'), '待完成');
  await user.click(screen.getByRole('button', { name: '保存视图' }));
  await screen.findByRole('alert');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('exports one bounded result page and labels incomplete coverage with its actual unit', async () => {
  const result = {
    queryId: id,
    spec: {},
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    view: 'resources',
    resources: [],
    totalCount: 100,
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ items: [] }))
    .mockResolvedValueOnce(
      Response.json({
        request: spec.requests.resources,
        result,
        exportedAt: new Date().toISOString(),
        coverage: {
          unit: 'resources',
          returnedCount: 0,
          totalCount: 100,
          complete: false,
        },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  const create = vi.fn(() => 'blob:test');
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const user = userEvent.setup();
  render(<DataExplorerSaved locale="en" queryId={id} capture={() => spec} />);
  await user.click(screen.getByText('Save, share and export'));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Export current page (JSON)',
      }).disabled,
    ).toBe(false),
  );
  await user.click(
    screen.getByRole('button', { name: 'Export current page (JSON)' }),
  );
  await screen.findByText('Exported 0 / 100 · resources · Partial result');
  expect(create).toHaveBeenCalledTimes(1);
});
it('does not report an empty saved-view list when the first read is forbidden', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(<DataExplorerSaved locale="en" queryId={id} capture={() => spec} />);
  await user.click(screen.getByText('Save, share and export'));
  await screen.findByRole('alert');
  expect(
    screen.queryByText(
      'No saved views yet. Save your current view to return later.',
    ),
  ).toBeNull();
  expect(screen.queryByRole('link', { name: 'River review' })).toBeNull();
});
it('withdraws the previous saved views and selected link when a later list read is forbidden', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ items: [savedView] }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(
    <DataExplorerSaved locale="zh-CN" queryId={id} capture={() => spec} />,
  );
  const summary = screen.getByText('保存、分享与导出');
  await user.click(summary);
  await screen.findByRole('link', { name: 'River review' });
  await user.click(screen.getByRole('button', { name: '视图链接' }));
  expect(screen.getByLabelText('视图链接').getAttribute('value')).toContain(
    viewId,
  );
  await user.click(summary);
  await user.click(summary);
  await screen.findByRole('alert');
  expect(screen.queryByRole('link', { name: 'River review' })).toBeNull();
  expect(screen.queryByLabelText('视图链接')).toBeNull();
  expect(screen.queryByRole('button', { name: '撤销链接' })).toBeNull();
  expect(
    screen.queryByText('还没有保存的视图。保存当前视图，便于稍后继续。'),
  ).toBeNull();
});
it('shows a genuinely empty successful list and recovers after a failed retry', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ items: [] }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ items: [savedView] }));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(<DataExplorerSaved locale="en" queryId={id} capture={() => spec} />);
  const summary = screen.getByText('Save, share and export');
  await user.click(summary);
  await screen.findByText(
    'No saved views yet. Save your current view to return later.',
  );
  expect(screen.queryByRole('alert')).toBeNull();
  await user.click(summary);
  await user.click(summary);
  await screen.findByRole('alert');
  expect(
    screen.queryByText(
      'No saved views yet. Save your current view to return later.',
    ),
  ).toBeNull();
  await user.click(summary);
  await user.click(summary);
  await screen.findByRole('link', { name: 'River review' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(
    screen.queryByText(
      'No saved views yet. Save your current view to return later.',
    ),
  ).toBeNull();
});
it.each(['rejects', 'resolves'] as const)(
  'keeps the current save result when an earlier cancelled list later %s',
  async (outcome) => {
    let resolveList!: (response: Response) => void;
    let rejectList!: (error: Error) => void;
    const earlierList = new Promise<Response>((resolve, reject) => {
      resolveList = resolve;
      rejectList = reject;
    });
    const currentView = { ...savedView, title: 'Current saved view' };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(earlierList)
      .mockResolvedValueOnce(Response.json({ items: [] }))
      .mockResolvedValueOnce(Response.json({ savedView: currentView }));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    render(<DataExplorerSaved locale="en" queryId={id} capture={() => spec} />);
    const summary = screen.getByText('Save, share and export');
    await user.click(summary);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const earlierSignal = fetch.mock.calls[0]?.[1]?.signal;
    await user.click(summary);
    await user.click(summary);
    await screen.findByText(
      'No saved views yet. Save your current view to return later.',
    );
    expect(earlierSignal?.aborted).toBe(true);
    await user.type(screen.getByLabelText('View name'), 'Current saved view');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    await screen.findByText('View saved.');
    await act(async () => {
      if (outcome === 'rejects') rejectList(new Error('Late list failure'));
      else resolveList(Response.json({ items: [savedView] }));
      await earlierList.catch(() => undefined);
    });
    expect(
      screen.getByRole('link', { name: 'Current saved view' }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'River review' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('View saved.')).toBeTruthy();
  },
);
