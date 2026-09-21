// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataRecordRelations } from './data-record-relations';
import { readRelationView } from '@/lib/relation-navigation';
import { RelationListInputSchema } from '@wiser/data-contracts';
import type { RecordFocus } from '@/lib/exploration-record-focus';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

const record: RecordFocus = {
  dataItemId: row.dataItemId,
  versionId: row.versionId,
  recordId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};
const bound = {
  ...row,
  status: 'APPROVED',
  candidate: {
    ...row.candidate,
    subject: {
      key: 'record',
      label: '真实波段2',
      kind: 'OBSERVATION',
      externalId: 'urn:wiser:record:' + record.recordId,
    },
    predicate: 'OBSERVES_ENTITY',
    object: { key: 'lake', label: '官厅水库', kind: 'PLACE', externalId: null },
  },
};
it('finds exact version-bound record nodes beyond the first page and builds a focused graph link', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        items: [],
        totalCount: 101,
        nextCursor: row.assertionId,
      }),
    )
    .mockResolvedValueOnce(Response.json({ items: [bound], totalCount: 101 }));
  vi.stubGlobal('fetch', request);
  render(
    <DataRecordRelations locale="zh-CN" record={record} returnGraph={null} />,
  );
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  await screen.findByText('尚有关系未检查，请继续查找。');
  expect(
    screen.queryByText('当前范围内未找到这条记录的明确业务绑定。'),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '继续查找' }));
  const link = await screen.findByRole('link', { name: '真实波段2' });
  const view = readRelationView(
    new URL(link.getAttribute('href')!, 'http://localhost').search,
    record,
  )!;
  expect(JSON.parse(view.entity!)).toEqual([
    record.dataItemId,
    record.versionId,
    'v1',
    'record',
  ]);
  expect(view.status).toBe('APPROVED');
  expect(requestInput(request.mock.calls[1][1]).after).toBe(row.assertionId);
});
it('does not treat a same-label or wrong-record node as a binding', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [
          {
            ...bound,
            candidate: {
              ...bound.candidate,
              subject: { ...bound.candidate.subject, externalId: null },
            },
          },
        ],
        totalCount: 1,
      }),
    ),
  );
  render(
    <DataRecordRelations locale="zh-CN" record={record} returnGraph={null} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  await screen.findByText('当前范围内未找到这条记录的明确业务绑定。');
  expect(screen.queryByRole('link', { name: '真实波段2' })).toBeNull();
});
it('rejects out-of-scope or wrong-status response without showing evidence', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [{ ...bound, status: 'PENDING_REVIEW' }],
        totalCount: 1,
      }),
    ),
  );
  render(
    <DataRecordRelations locale="zh-CN" record={record} returnGraph={null} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('link', { name: '真实波段2' })).toBeNull();
});
it('clears previously displayed bindings on failed continuation', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        items: [bound],
        totalCount: 101,
        nextCursor: row.assertionId,
      }),
    )
    .mockResolvedValueOnce(Response.json({}, { status: 403 }));
  vi.stubGlobal('fetch', request);
  render(
    <DataRecordRelations locale="zh-CN" record={record} returnGraph={null} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  await screen.findByRole('link', { name: '真实波段2' });
  fireEvent.click(screen.getByRole('button', { name: '继续查找' }));
  await screen.findByRole('alert');
  await waitFor(() =>
    expect(screen.queryByRole('link', { name: '真实波段2' })).toBeNull(),
  );
});

it('rejects source substitution and clears bindings when the record changes', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ items: [bound], totalCount: 1 }))
    .mockResolvedValueOnce(
      Response.json({
        items: [
          { ...bound, versionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
        ],
        totalCount: 1,
      }),
    );
  vi.stubGlobal('fetch', request);
  const ui = render(
    <DataRecordRelations locale="zh-CN" record={record} returnGraph={null} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  await screen.findByRole('link', { name: '真实波段2' });
  ui.rerender(
    <DataRecordRelations
      locale="zh-CN"
      record={{ ...record, recordId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }}
      returnGraph={null}
    />,
  );
  expect(screen.queryByRole('link', { name: '真实波段2' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  await screen.findByRole('alert');
});
it('retains an authorized case scope and explicit pending selection in the graph link', async () => {
  const view = {
    dataItemId: row.dataItemId,
    versionId: row.versionId,
    sources: [
      {
        dataItemId: '11111111-1111-4111-8111-111111111111',
        versionId: '22222222-2222-4222-8222-222222222222',
      },
    ],
    status: 'PENDING_REVIEW',
    preview: true,
    entity: null,
    pages: 3,
  };
  const href =
    '/zh-CN/data-foundation/catalog/' +
    view.dataItemId +
    '?versionId=' +
    view.versionId +
    '&relations=' +
    encodeURIComponent(JSON.stringify(view));
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      items: [{ ...bound, status: 'PENDING_REVIEW' }],
      totalCount: 1,
    }),
  );
  vi.stubGlobal('fetch', request);
  render(
    <DataRecordRelations locale="zh-CN" record={record} returnGraph={href} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  const link = await screen.findByRole('link', { name: '真实波段2' });
  const result = readRelationView(
    new URL(link.getAttribute('href')!, 'http://localhost').search,
    record,
  )!;
  expect(result.sources).toEqual(view.sources);
  expect(result.preview).toBe(true);
  expect(requestInput(request.mock.calls[0][1]).relatedSources).toEqual(
    view.sources,
  );
});

function requestInput(init: RequestInit | undefined) {
  if (typeof init?.body !== 'string') throw Error('Expected JSON body');
  const input: unknown = JSON.parse(init.body);
  return RelationListInputSchema.parse(input);
}

it('keeps the persisted business scope and review status for a non-observation record across pages', async () => {
  const queryId = '11111111-1111-4111-8111-111111111111';
  const businessRow = {
    ...bound,
    status: 'PENDING_REVIEW',
    candidate: {
      ...bound.candidate,
      subject: { ...bound.candidate.subject, kind: 'DOCUMENT' },
    },
  };
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        items: [row],
        totalCount: 2,
        nextCursor: row.assertionId,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        items: [
          {
            ...businessRow,
            assertionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          },
        ],
        totalCount: 2,
      }),
    );
  vi.stubGlobal('fetch', request);
  render(
    <DataRecordRelations
      locale="zh-CN"
      record={record}
      returnGraph={null}
      business={{ queryId, status: 'PENDING_REVIEW' }}
    />,
  );
  expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true);
  expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe(
    'PENDING_REVIEW',
  );
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  const link = await screen.findByRole('link', { name: '真实波段2' });
  const url = new URL(link.getAttribute('href')!, 'http://localhost');
  expect(url.searchParams.get('query')).toBe(queryId);
  expect(url.searchParams.get('view')).toBe('graph');
  expect(url.searchParams.has('businessEntity')).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
  for (const [, options] of request.mock.calls) {
    const input = requestInput(options);
    expect(input.queryId).toBe(queryId);
    expect(input.status).toBe('PENDING_REVIEW');
    expect(input.dataItemId).toBeUndefined();
  }
});

it('follows a record in a mixed query while rejecting states outside its review scope', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      items: [
        bound,
        {
          ...bound,
          assertionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          status: 'PENDING_REVIEW',
        },
      ],
      totalCount: 2,
    }),
  );
  vi.stubGlobal('fetch', request);
  render(
    <DataRecordRelations
      locale="zh-CN"
      record={record}
      returnGraph={null}
      business={{
        queryId: '11111111-1111-4111-8111-111111111111',
        status: 'APPROVED_AND_PENDING',
      }}
    />,
  );
  expect(screen.getByRole('option', { name: '已审与待审' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查找此记录的业务关系' }));
  expect(await screen.findByRole('link', { name: '真实波段2' })).toBeTruthy();
  expect(requestInput(request.mock.calls[0][1]).status).toBe(
    'APPROVED_AND_PENDING',
  );
});

it.each(['REJECTED', 'CORRECTION_REQUIRED'])(
  'rejects %s in a mixed record scope',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ items: [{ ...bound, status }], totalCount: 1 }),
        ),
    );
    render(
      <DataRecordRelations
        locale="zh-CN"
        record={record}
        returnGraph={null}
        business={{
          queryId: '11111111-1111-4111-8111-111111111111',
          status: 'APPROVED_AND_PENDING',
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: '查找此记录的业务关系' }),
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '真实波段2' })).toBeNull();
  },
);
