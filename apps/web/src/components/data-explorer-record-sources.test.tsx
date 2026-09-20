// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RelationAssertion } from '@wiser/data-contracts';
import { DataExplorerRecordSources } from './data-explorer-record-sources';
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
      key: 'policy',
      label: '真实政策',
      kind: 'POLICY',
      externalId: null,
    },
    predicate: 'ABOUT_ENTITY',
    object: {
      key: 'river',
      label: '永定河',
      kind: 'RIVER_REACH',
      externalId: null,
    },
    qualifiers: {
      measure: null,
      reportedValue: null,
      reportedLimit: null,
      unit: null,
      observedAt: null,
      missing: true,
      spatialScope: null,
      limitations: [],
      reportedConclusion: null,
    },
    generation: { method: 'MANUAL', model: null },
    evidence: [
      {
        assetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        sourceHash: 'a'.repeat(64),
        locator: 'page:1',
        excerpt: '原文内容',
        polarity: 'SUPPORTS',
      },
    ],
    supersedesId: null,
  },
} satisfies RelationAssertion;

const queryId = '11111111-1111-4111-8111-111111111111';
const recordId = '22222222-2222-4222-8222-222222222222';
const foreign = {
  dataItemId: '33333333-3333-4333-8333-333333333333',
  versionId: '44444444-4444-4444-8444-444444444444',
};
function bound(assertionId = row.assertionId): RelationAssertion {
  return {
    ...row,
    assertionId,
    candidate: {
      ...row.candidate,
      subject: {
        ...row.candidate.subject,
        kind: 'OBSERVATION',
        label: '六月水质原表',
        externalId: `urn:wiser:record:${recordId}`,
        reference: { ...foreign, mappingVersion: 'v1', entityKey: 'sample' },
      },
    },
  };
}
const props = {
  locale: 'zh-CN' as const,
  queryId,
  status: 'PENDING_REVIEW' as const,
  versionId: row.versionId,
  onInvalidated: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('collects all scoped pages, deduplicates record bindings and preserves referenced source identity in links', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        items: [row, bound('77777777-7777-4777-8777-777777777777')],
        totalCount: 3,
        nextCursor: '66666666-6666-4666-8666-666666666666',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        items: [bound('55555555-5555-4555-8555-555555555555')],
        totalCount: 3,
      }),
    );
  vi.stubGlobal('fetch', fetch);
  render(<DataExplorerRecordSources {...props} />);
  const link = await screen.findByRole('link', { name: '六月水质原表' });
  const url = new URL(link.getAttribute('href')!, 'http://local');
  expect(url.searchParams.get('query')).toBe(queryId);
  expect(url.searchParams.get('view')).toBe('records');
  expect(JSON.parse(url.searchParams.get('recordFocus')!)).toEqual({
    ...foreign,
    recordId,
  });
  expect(screen.getAllByRole('link', { name: '六月水质原表' })).toHaveLength(1);
  const requestBody = fetch.mock.calls[1][1]?.body;
  if (typeof requestBody !== 'string') throw Error('Expected JSON request');
  expect(JSON.parse(requestBody)).toMatchObject({
    queryId,
    status: 'PENDING_REVIEW',
    after: '66666666-6666-4666-8666-666666666666',
  });
  expect(screen.getByText(/1 条已绑定记录/)).toBeTruthy();
});
it('does not expose partial pages when a later page is denied', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          items: [bound()],
          totalCount: 2,
          nextCursor: '66666666-6666-4666-8666-666666666666',
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 403 })),
  );
  render(<DataExplorerRecordSources {...props} />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('link', { name: '六月水质原表' })).toBeNull();
  expect(props.onInvalidated).toHaveBeenCalledWith(queryId, 403);
});
it('keeps name-only relations out of the record directory and links back to the same business query', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ items: [row], totalCount: 1 })),
  );
  render(<DataExplorerRecordSources {...props} />);
  expect(await screen.findByText(/当前条件下尚无明确绑定的记录/)).toBeTruthy();
  expect(
    screen
      .getByRole('link', { name: '返回业务图查看原文证据' })
      .getAttribute('href'),
  ).toContain(`query=${queryId}&view=graph`);
});
it('lets the user find a matching record by name', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ items: [bound()], totalCount: 1 })),
  );
  render(<DataExplorerRecordSources {...props} />);
  await screen.findByRole('link', { name: '六月水质原表' });
  fireEvent.change(screen.getByLabelText('查找关联记录'), {
    target: { value: '不存在' },
  });
  expect(screen.queryByRole('link', { name: '六月水质原表' })).toBeNull();
  fireEvent.change(screen.getByLabelText('查找关联记录'), {
    target: { value: '六月' },
  });
  expect(screen.getByRole('link', { name: '六月水质原表' })).toBeTruthy();
});

it('reads a complete server membership above the legacy 2000 relation bound', async () => {
  const items = Array.from({ length: 2033 }, (_, index) =>
    bound(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`),
  );
  let offset = 0;
  const fetch = vi.fn().mockImplementation(() => {
    const page = items.slice(offset, offset + 100);
    offset += page.length;
    return Promise.resolve(
      Response.json({
        items: page,
        totalCount: items.length,
        ...(offset < items.length
          ? { nextCursor: page.at(-1)!.assertionId }
          : {}),
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  render(
    <DataExplorerRecordSources
      {...props}
      {...{
        membership: {
          complete: true,
          versionCount: 1,
          assertionCount: items.length,
        },
      }}
    />,
  );
  expect(
    await screen.findByRole('link', { name: '六月水质原表' }),
  ).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(21);
});
it('rejects totals outside the server membership before following a cursor', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      items: [bound()],
      totalCount: 2,
      nextCursor: '66666666-6666-4666-8666-666666666666',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <DataExplorerRecordSources
      {...props}
      {...{
        membership: { complete: true, versionCount: 1, assertionCount: 1 },
      }}
    />,
  );
  await screen.findByRole('alert');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects an empty continuation instead of chasing more pages', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      items: [],
      totalCount: 2,
      nextCursor: '66666666-6666-4666-8666-666666666666',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<DataExplorerRecordSources {...props} />);
  await screen.findByRole('alert');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['response', 'body'])(
  'does not follow a late %s from a replaced query',
  async (stage) => {
    let finish!: (value: unknown) => void;
    const delayed = new Promise((resolve) => {
      finish = resolve;
    });
    const part = {
      items: [bound()],
      totalCount: 2,
      nextCursor: '66666666-6666-4666-8666-666666666666',
    };
    const json = vi.fn(() => delayed);
    const fetch = vi
      .fn()
      .mockImplementationOnce(() =>
        stage === 'response' ? delayed : Promise.resolve({ ok: true, json }),
      )
      .mockResolvedValue(Response.json({ items: [], totalCount: 0 }));
    vi.stubGlobal('fetch', fetch);
    const rendered = render(<DataExplorerRecordSources {...props} />);
    await act(async () => {
      await Promise.resolve();
    });
    rendered.rerender(
      <DataExplorerRecordSources
        {...props}
        queryId="55555555-5555-4555-8555-555555555555"
      />,
    );
    await screen.findByText(/当前条件下尚无明确绑定的记录/);
    await act(async () => {
      finish(stage === 'response' ? Response.json(part) : part);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(props.onInvalidated).not.toHaveBeenCalled();
  },
);
