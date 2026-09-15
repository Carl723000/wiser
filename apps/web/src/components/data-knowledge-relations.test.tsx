// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataKnowledgeRelations } from './data-knowledge-relations';
vi.mock('./data-foundation-graph', () => ({
  KnowledgeGraphCanvas: () => <div data-testid="business-graph" />,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
const row = {
  assertionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  dataItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  version: 1,
  mappingVersion: 'v1',
  status: 'PENDING_REVIEW',
  confidence: null,
  createdAt: '2026-09-11T00:00:00Z',
  reviews: [],
  candidate: {
    subject: {
      key: 'enterprise',
      label: 'Enterprise',
      kind: 'ENTERPRISE',
      externalId: null,
    },
    predicate: 'HAS_DECLARED_MONITORING_POINT',
    object: {
      key: 'point',
      label: 'Point',
      kind: 'MONITORING_POINT',
      externalId: null,
    },
    qualifiers: {
      measure: null,
      unit: null,
      observedAt: null,
      missing: true,
      spatialScope: null,
      limitations: [],
      reportedConclusion: null,
    },
    generation: { method: 'SOURCE_TABLE', model: null },
    evidence: [
      {
        assetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        sourceHash: 'a'.repeat(64),
        locator: 'PDF page 1, row 1',
        excerpt: null,
        polarity: 'SUPPORTS',
      },
    ],
    supersedesId: null,
  },
};

it('separates candidate counts from the approved graph and preserves review retry identity', async () => {
  const calls: RequestInit[] = [];
  let attempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      await Promise.resolve();
      if (url.endsWith('/review')) {
        calls.push(options);
        if (++attempts === 1) return new Response('{}', { status: 503 });
        return Response.json({
          assertion: { ...row, status: 'APPROVED', version: 2 },
        });
      }
      return Response.json({ items: [row], totalCount: 1 });
    }),
  );
  window.history.replaceState(
    null,
    '',
    `/zh-CN/data-foundation/catalog/${row.dataItemId}?version=${row.versionId}`,
  );
  render(
    <DataKnowledgeRelations
      locale="zh-CN"
      dataItemId={row.dataItemId}
      versionId={row.versionId}
    />,
  );
  fireEvent.change(screen.getByLabelText('审核状态'), {
    target: { value: 'PENDING_REVIEW' },
  });
  fireEvent.click(screen.getByRole('button', { name: '查看业务关系' }));
  await screen.findByText(/PDF page 1, row 1/);
  expect(screen.queryByTestId('business-graph')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: '查看待审关联图' }));
  expect(screen.getByTestId('business-graph')).toBeTruthy();
  expect(screen.getByText('当前状态的关系数：1')).toBeTruthy();
  expect(screen.getByText('当前状态的关系数：1')).toBeTruthy();
  expect(
    screen.getByRole('link', { name: '查看原件' }).getAttribute('href'),
  ).toContain(row.versionId);
  fireEvent.change(screen.getByLabelText('审核说明'), {
    target: { value: '已对照原件位置' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认通过' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '确认通过' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(new Headers(calls[0]?.headers).get('Idempotency-Key')).toEqual(
    new Headers(calls[1]?.headers).get('Idempotency-Key'),
  );
});

it('restores a version-bound relation view on direct entry and browser history without an earlier tab', async () => {
  const base = {
    dataItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
  const other = {
    dataItemId: '11111111-1111-4111-8111-111111111111',
    versionId: '22222222-2222-4222-8222-222222222222',
  };
  const view = {
    ...base,
    sources: [other],
    status: 'PENDING_REVIEW',
    preview: true,
    entity: null,
    pages: 1,
  };
  window.history.replaceState(
    { keep: 'framework' },
    '',
    '/?relations=' + encodeURIComponent(JSON.stringify(view)),
  );
  const fetcher = vi.fn((_url: string, _options: RequestInit) =>
    Promise.resolve(Response.json({ items: [], totalCount: 0 })),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<DataKnowledgeRelations locale="zh-CN" {...base} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toMatchObject({
    ...base,
    relatedSources: [other],
    status: 'PENDING_REVIEW',
  });
  expect(screen.getByLabelText<HTMLSelectElement>('审核状态').value).toBe(
    'PENDING_REVIEW',
  );
  expect(screen.getByText('有证据的业务关系').closest('details')?.open).toBe(
    true,
  );
  window.history.replaceState({ keep: 'framework' }, '', '/');
  fireEvent(window, new PopStateEvent('popstate'));
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLSelectElement>('审核状态').value).toBe(
      'APPROVED',
    ),
  );
  expect(screen.queryByText('当前状态的关系数：0')).toBeNull();
});

it('does not query or silently broaden a malformed saved relation scope', async () => {
  window.history.replaceState(null, '', '/?relations=broken');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(
    <DataKnowledgeRelations
      locale="zh-CN"
      dataItemId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      versionId="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    />,
  );
  await screen.findByRole('alert');
  expect(fetcher).not.toHaveBeenCalled();
  window.history.replaceState(null, '', '/');
});

it('accumulates saved pages and reauthorizes the same source scope instead of replacing the visible graph', async () => {
  const base = {
    dataItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
  const view = {
    ...base,
    sources: [],
    status: 'APPROVED',
    preview: false,
    entity: null,
    pages: 2,
  };
  window.history.replaceState(
    null,
    '',
    '/?relations=' + encodeURIComponent(JSON.stringify(view)),
  );
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string) as { after?: string };
    await Promise.resolve();
    return Response.json(
      body.after
        ? {
            items: [
              {
                ...row,
                assertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                status: 'APPROVED',
              },
            ],
            totalCount: 2,
          }
        : {
            items: [{ ...row, status: 'APPROVED' }],
            totalCount: 2,
            nextCursor: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  render(<DataKnowledgeRelations locale="zh-CN" {...base} />);
  await screen.findByText('当前状态的关系数：2');
  expect(screen.getAllByText(/PDF page 1, row 1/)).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toMatchObject({
    ...base,
    status: 'APPROVED',
    relatedSources: [],
    after: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    first: 100,
  });
});

it('clears a restored view when authorization is denied and never retries with a broader source scope', async () => {
  const base = {
    dataItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
  const view = {
    ...base,
    sources: [],
    status: 'PENDING_REVIEW',
    preview: true,
    entity: null,
    pages: 2,
  };
  window.history.replaceState(
    null,
    '',
    '/?relations=' + encodeURIComponent(JSON.stringify(view)),
  );
  const fetcher = vi.fn(() =>
    Promise.resolve(new Response('{}', { status: 403 })),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<DataKnowledgeRelations locale="zh-CN" {...base} />);
  await screen.findByRole('alert');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('business-graph')).toBeNull();
});

it('ignores a late denied response after history restores a newer query', async () => {
  const base = { dataItemId: row.dataItemId, versionId: row.versionId };
  const view = {
    ...base,
    sources: [],
    status: 'PENDING_REVIEW',
    preview: true,
    entity: null,
    pages: 1,
  };
  window.history.replaceState(
    null,
    '',
    '/?relations=' + encodeURIComponent(JSON.stringify(view)),
  );
  let release: (response: Response) => void = () => {
    throw Error('request not started');
  };
  const slow = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetcher = vi
    .fn()
    .mockReturnValueOnce(slow)
    .mockResolvedValueOnce(Response.json({ items: [], totalCount: 0 }));
  vi.stubGlobal('fetch', fetcher);
  render(<DataKnowledgeRelations locale="zh-CN" {...base} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  window.history.replaceState(
    null,
    '',
    '/?relations=' +
      encodeURIComponent(
        JSON.stringify({ ...view, status: 'APPROVED', preview: false }),
      ),
  );
  fireEvent(window, new PopStateEvent('popstate'));
  await screen.findByText('当前状态的关系数：0');
  await act(async () => {
    release(new Response('{}', { status: 403 }));
    await slow;
  });
  expect(screen.getByText('当前状态的关系数：0')).toBeTruthy();
});

it('filters the loaded graph and evidence together and restores conditions without widening the source request', async () => {
  const context = {
    recordNature: 'REPORTED_OBSERVATION',
    timeRole: 'OBSERVATION_TIME',
    validFrom: '2019-06-01',
    validTo: '2019-06-30',
    locationRole: 'SUBJECT_AREA',
    applicability: 'source interval',
  };
  const observed = {
    ...row,
    candidate: {
      ...row.candidate,
      subject: { ...row.candidate.subject, kind: 'OBSERVATION' },
      qualifiers: { ...row.candidate.qualifiers, context },
    },
  };
  const undated = {
    ...row,
    assertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    candidate: {
      ...row.candidate,
      subject: { ...row.candidate.subject, kind: 'PERSON', label: 'Speaker' },
    },
  };
  const view = {
    dataItemId: row.dataItemId,
    versionId: row.versionId,
    sources: [],
    status: 'PENDING_REVIEW',
    preview: true,
    entity: null,
    pages: 1,
  };
  const route = `/zh-CN/data-foundation/catalog/${row.dataItemId}?version=${row.versionId}&relations=`;
  window.history.replaceState(
    null,
    '',
    route + encodeURIComponent(JSON.stringify(view)),
  );
  const fetcher = vi.fn(() =>
    Promise.resolve(
      Response.json({ items: [observed, undated], totalCount: 2 }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <DataKnowledgeRelations
      locale="zh-CN"
      dataItemId={row.dataItemId}
      versionId={row.versionId}
    />,
  );
  await screen.findByText('当前状态的关系数：2');
  fireEvent.change(screen.getByLabelText('涉及对象类型'), {
    target: { value: 'OBSERVATION' },
  });
  fireEvent.change(screen.getByLabelText('筛选开始日期'), {
    target: { value: '2019-06-01' },
  });
  fireEvent.change(screen.getByLabelText('筛选结束日期'), {
    target: { value: '2019-06-30' },
  });
  fireEvent.click(screen.getByRole('button', { name: '应用关系筛选' }));
  expect(screen.getAllByText(/PDF page 1, row 1/)).toHaveLength(1);
  expect(screen.getByText(/筛选后关系数：1/)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const filtered = window.location.search;
  expect(
    (
      JSON.parse(new URLSearchParams(filtered).get('relations')!) as {
        filters: { kind: string };
      }
    ).filters.kind,
  ).toBe('OBSERVATION');
  fireEvent.click(screen.getByRole('button', { name: '清除关系筛选' }));
  expect(screen.getAllByText(/PDF page 1, row 1/)).toHaveLength(2);
  // Restore exact encoded state, as a copied link or browser history would.
  window.history.replaceState(
    null,
    '',
    `/zh-CN/data-foundation/catalog/${row.dataItemId}` + filtered,
  );
  fireEvent(window, new PopStateEvent('popstate'));
  await waitFor(() =>
    expect(screen.getAllByText(/PDF page 1, row 1/)).toHaveLength(1),
  );
  expect(screen.getByLabelText<HTMLSelectElement>('涉及对象类型').value).toBe(
    'OBSERVATION',
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps nonmatching loaded rows when continuing a filtered page so clearing filters restores them', async () => {
  const view = {
    dataItemId: row.dataItemId,
    versionId: row.versionId,
    sources: [],
    status: 'PENDING_REVIEW',
    preview: true,
    entity: null,
    pages: 1,
    filters: {
      kind: 'PERSON',
      timeRole: 'ALL',
      from: null,
      to: null,
      includeUndated: true,
    },
  };
  window.history.replaceState(
    null,
    '',
    `/zh-CN/data-foundation/catalog/${row.dataItemId}?version=${row.versionId}&relations=` +
      encodeURIComponent(JSON.stringify(view)),
  );
  const next = {
    ...row,
    assertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    candidate: {
      ...row.candidate,
      subject: { ...row.candidate.subject, kind: 'PERSON', label: 'Speaker' },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      await Promise.resolve();
      return Response.json(
        (JSON.parse(options.body as string) as { after?: string }).after
          ? { items: [next], totalCount: 2 }
          : {
              items: [row],
              totalCount: 2,
              nextCursor: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            },
      );
    }),
  );
  render(
    <DataKnowledgeRelations
      locale="zh-CN"
      dataItemId={row.dataItemId}
      versionId={row.versionId}
    />,
  );
  await screen.findByRole('button', { name: '继续加载关系' });
  fireEvent.click(screen.getByRole('button', { name: '继续加载关系' }));
  await screen.findByText('Speaker');
  fireEvent.click(screen.getByRole('button', { name: '清除关系筛选' }));
  expect(screen.getAllByText(/PDF page 1, row 1/)).toHaveLength(2);
});

it('links an explicit observation record to its version and retains the applied graph context', async () => {
  const recordId = '50000000-0000-4000-8000-000000000001';
  const bound = {
    ...row,
    candidate: {
      ...row.candidate,
      predicate: 'DERIVED_FROM',
      object: { ...row.candidate.object, kind: 'DOCUMENT' },
      subject: {
        key: 'band:1',
        label: '影像波段1',
        kind: 'OBSERVATION',
        externalId: 'urn:wiser:record:' + recordId,
      },
    },
  };
  const view = {
    dataItemId: row.dataItemId,
    versionId: row.versionId,
    sources: [],
    status: 'PENDING_REVIEW',
    preview: true,
    entity: null,
    pages: 1,
  };
  window.history.replaceState(
    null,
    '',
    `/zh-CN/data-foundation/catalog/${row.dataItemId}?version=${row.versionId}&relations=` +
      encodeURIComponent(JSON.stringify(view)),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(Response.json({ items: [bound], totalCount: 1 })),
    ),
  );
  render(
    <DataKnowledgeRelations
      locale="zh-CN"
      dataItemId={row.dataItemId}
      versionId={row.versionId}
    />,
  );
  const link = await screen.findByRole('link', {
    name: '查看对应记录的空间内容',
  });
  const url = new URL(link.getAttribute('href')!, 'http://localhost');
  expect(JSON.parse(url.searchParams.get('recordFocus')!)).toEqual({
    dataItemId: row.dataItemId,
    versionId: row.versionId,
    recordId,
  });
  expect(JSON.parse(url.searchParams.get('returnRelations')!)).toEqual(view);
  expect(screen.getByRole('link', { name: '查看对应记录' })).toBeTruthy();
});

it('persists an exact preceding assertion and reauthorizes it on history restoration', async () => {
  const revised = {
    ...row,
    assertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    mappingVersion: 'v2',
    candidate: { ...row.candidate, supersedesId: row.assertionId },
  };
  const get = vi.fn(() => Response.json({ assertion: row }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/get')
          ? get()
          : Response.json({ items: [row, revised], totalCount: 2 }),
      ),
    ),
  );
  const view = {
    dataItemId: row.dataItemId,
    versionId: row.versionId,
    sources: [],
    status: 'PENDING_REVIEW',
    preview: true,
    entity: null,
    pages: 1,
  };
  window.history.replaceState(
    null,
    '',
    `/zh-CN/data-foundation/catalog/${row.dataItemId}?version=${row.versionId}&relations=${encodeURIComponent(JSON.stringify(view))}`,
  );
  const { container } = render(
    <DataKnowledgeRelations
      locale="zh-CN"
      dataItemId={row.dataItemId}
      versionId={row.versionId}
    />,
  );
  await waitFor(() =>
    expect(container.querySelectorAll('article')).toHaveLength(2),
  );
  fireEvent.click(screen.getByRole('button', { name: '查看更正前的关系' }));
  await waitFor(() =>
    expect(container.querySelectorAll('article')).toHaveLength(1),
  );
  expect(
    new URLSearchParams(window.location.search).get('relations'),
  ).toContain(row.assertionId);
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(container.querySelectorAll('article')).toHaveLength(1);
});

it.each(['denied', 'foreign-version', 'wrong-id', 'changed-status'])(
  'does not replace failed history with a different relation: %s',
  async (failure) => {
    const changed =
      failure === 'foreign-version'
        ? { ...row, versionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }
        : failure === 'wrong-id'
          ? { ...row, assertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }
          : failure === 'changed-status'
            ? { ...row, status: 'APPROVED' }
            : row;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          failure === 'denied'
            ? new Response('{}', { status: 403 })
            : Response.json({ assertion: changed }),
        ),
      ),
    );
    const view = {
      dataItemId: row.dataItemId,
      versionId: row.versionId,
      sources: [],
      status: 'PENDING_REVIEW',
      preview: true,
      entity: null,
      pages: 1,
      assertionId: row.assertionId,
    };
    window.history.replaceState(
      null,
      '',
      `/zh-CN/data-foundation/catalog/${row.dataItemId}?version=${row.versionId}&relations=${encodeURIComponent(JSON.stringify(view))}`,
    );
    const { container } = render(
      <DataKnowledgeRelations
        locale="zh-CN"
        dataItemId={row.dataItemId}
        versionId={row.versionId}
      />,
    );
    await screen.findByRole('alert');
    expect(container.querySelectorAll('article')).toHaveLength(0);
  },
);
