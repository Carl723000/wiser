// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
        reference: foreign,
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
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        items: [row, bound()],
        totalCount: 3,
        nextCursor: 'next',
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
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({
    queryId,
    status: 'PENDING_REVIEW',
    after: 'next',
  });
  expect(screen.getByText(/1 条已绑定记录/)).toBeTruthy();
});
it('does not expose partial pages when a later page is denied', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ items: [bound()], totalCount: 2, nextCursor: 'next' }),
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
