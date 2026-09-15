// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BusinessQuerySchema,
  type RelationAssertion,
} from '@wiser/data-contracts';
import { DataExplorerBusiness } from './data-explorer-business';
import { relationNodeIdentity } from '@/lib/relation-graph';
const nav = vi.hoisted(() => ({
  search: new URLSearchParams('saved=case'),
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.search,
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => '/zh-CN/data-foundation/explore',
}));
vi.mock('./data-foundation-graph', () => ({
  KnowledgeGraphCanvas: ({
    result,
  }: {
    result: { nodes: { entityId: string; label: string }[] };
  }) => (
    <ul aria-label="test graph">
      {result.nodes.map((n) => (
        <li key={n.entityId}>{n.label}</li>
      ))}
    </ul>
  ),
}));
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
const scope = BusinessQuerySchema.parse({
  schemaVersion: 1,
  status: 'PENDING_REVIEW',
  revisionMode: 'current',
  filters: {
    kind: 'ALL',
    timeRole: 'ALL',
    from: null,
    to: null,
    includeUndated: true,
  },
});
const props = {
  queryId: 'query',
  scope,
  locale: 'zh-CN' as const,
  onInvalidated: vi.fn(),
  onApply: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.search = new URLSearchParams('saved=case');
  nav.replace.mockReset();
});
it('preserves the saved query while selecting a category and restores selection from URL changes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ items: [row], totalCount: 1 })),
  );
  const view = render(<DataExplorerBusiness {...props} />);
  const policy = await screen.findByRole('button', {
    name: '政策',
  });
  fireEvent.click(policy);
  expect(nav.replace).toHaveBeenCalledWith(
    '/zh-CN/data-foundation/explore?saved=case&businessKind=POLICY',
    { scroll: false },
  );
  nav.search = new URLSearchParams('saved=case&businessKind=POLICY');
  view.rerender(<DataExplorerBusiness {...props} />);
  expect(
    screen.getByRole('button', { name: '政策' }).getAttribute('aria-pressed'),
  ).toBe('true');
  nav.search = new URLSearchParams('saved=case');
  view.rerender(<DataExplorerBusiness {...props} />);
  expect(
    screen.getByRole('button', { name: '政策' }).getAttribute('aria-pressed'),
  ).toBe('false');
  expect(
    screen
      .getByRole('button', { name: '多类对象总览' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
});
it('keeps original evidence available without expanding every excerpt by default', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ items: [row], totalCount: 1 })),
  );
  render(<DataExplorerBusiness {...props} />);
  const evidence = await screen.findByText(/展开原文依据/);
  expect(evidence.closest('details')?.open).toBe(false);
  fireEvent.click(evidence);
  expect(evidence.closest('details')?.open).toBe(true);
  expect(screen.getByText('原文内容')).toBeTruthy();
});

it('distinguishes names by their own document and follows the referenced source without changing the saved query', async () => {
  const policy: RelationAssertion = {
    ...row,
    candidate: {
      ...row.candidate,
      subject: {
        ...row.candidate.subject,
        kind: 'DOCUMENT',
        label: '永定河保护条例',
      },
    },
  };
  const research: RelationAssertion = {
    ...policy,
    assertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    dataItemId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    versionId: '11111111-1111-4111-8111-111111111111',
    candidate: {
      ...policy.candidate,
      subject: { ...policy.candidate.subject, label: '永定河生态研究' },
    },
  };
  const bridge: RelationAssertion = {
    ...row,
    assertionId: '22222222-2222-4222-8222-222222222222',
    candidate: {
      ...row.candidate,
      subject: row.candidate.object,
      object: {
        ...row.candidate.object,
        reference: {
          dataItemId: research.dataItemId,
          versionId: research.versionId,
          mappingVersion: research.mappingVersion,
          entityKey: research.candidate.object.key,
        },
      },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ items: [policy, research, bridge], totalCount: 3 }),
      ),
  );
  const view = render(<DataExplorerBusiness {...props} />);
  fireEvent.click(await screen.findByText(/按对象查找/));
  expect(
    screen.getByRole('button', {
      name: /河段 · 永定河 来源资料：永定河保护条例/,
    }),
  ).toBeTruthy();
  const target = screen.getByRole('button', {
    name: /河段 · 永定河 来源资料：永定河生态研究/,
  });
  fireEvent.click(target);
  const identity = relationNodeIdentity(bridge, bridge.candidate.object);
  const expected = new URLSearchParams({
    saved: 'case',
    businessEntity: identity,
  });
  expect(nav.replace).toHaveBeenLastCalledWith(
    '/zh-CN/data-foundation/explore?' + expected.toString(),
    { scroll: false },
  );
  nav.search = expected;
  view.rerender(<DataExplorerBusiness {...props} />);
  const selected = screen.getByRole('region', { name: '当前对象' });
  expect(
    within(selected)
      .getByRole('link', { name: '永定河生态研究' })
      .getAttribute('href'),
  ).toBe(
    `/zh-CN/data-foundation/catalog/${research.dataItemId}?version=${research.versionId}`,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps same-source duplicates distinct and labels missing document titles without inventing one', async () => {
  const revised = {
    ...row,
    assertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    mappingVersion: 'v2',
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ items: [revised, row], totalCount: 2 }),
      ),
  );
  render(<DataExplorerBusiness {...props} />);
  fireEvent.click(await screen.findByText(/按对象查找/));
  expect(
    screen.getByRole('button', { name: '河段 · 永定河 来源资料：1 · 对象 1' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: '河段 · 永定河 来源资料：1 · 对象 2' }),
  ).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps expanded observations after a saved view remount and restores overview explicitly', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ items: [row], totalCount: 1 })),
      ),
  );
  const first = render(<DataExplorerBusiness {...props} />);
  fireEvent.click(
    await screen.findByRole('button', { name: '展开全部观测关系' }),
  );
  expect(nav.replace).toHaveBeenLastCalledWith(
    '/zh-CN/data-foundation/explore?saved=case&businessMode=all',
    { scroll: false },
  );
  first.unmount();
  nav.search = new URLSearchParams('saved=case&businessMode=all');
  render(<DataExplorerBusiness {...props} queryId="reopened-query" />);
  expect(
    (
      await screen.findByRole('button', { name: '展开全部观测关系' })
    ).getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '多类对象总览' }));
  expect(nav.replace).toHaveBeenLastCalledWith(
    '/zh-CN/data-foundation/explore?saved=case',
    { scroll: false },
  );
});

it('treats an unknown graph mode as overview without widening the business scope', async () => {
  nav.search = new URLSearchParams('saved=case&businessMode=unexpected');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ items: [row], totalCount: 1 })),
  );
  render(<DataExplorerBusiness {...props} />);
  expect(
    (await screen.findByRole('button', { name: '多类对象总览' })).getAttribute(
      'aria-pressed',
    ),
  ).toBe('true');
  expect(
    screen
      .getByRole('button', { name: '展开全部观测关系' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
});

it('limits reading to six real relations while keeping all objects searchable and the page in the URL', async () => {
  // The parent tab updates native history before Next's search snapshot changes.
  window.history.replaceState(
    null,
    '',
    '/zh-CN/data-foundation/explore?query=query&view=graph',
  );
  const history = vi.spyOn(window.history, 'replaceState');
  const items = Array.from({ length: 14 }, (_, i) => ({
    ...row,
    assertionId: `${(i + 1).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    candidate: {
      ...row.candidate,
      subject: {
        ...row.candidate.subject,
        key: `policy-${i}`,
        label: `政策 ${i}`,
      },
    },
  }));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ items, totalCount: items.length })),
  );
  const rendered = render(<DataExplorerBusiness {...props} />);
  await screen.findByRole('button', { name: '分组阅读' });
  expect(screen.getAllByRole('article')).toHaveLength(6);
  expect(
    within(screen.getByRole('list', { name: 'test graph' })).getAllByRole(
      'listitem',
    ),
  ).toHaveLength(7);
  const search = screen.getByText('按对象查找 (15)').closest('details')!;
  expect(within(search).getAllByRole('button')).toHaveLength(15);
  fireEvent.click(screen.getAllByRole('button', { name: '下一组' })[0]);
  expect(history).toHaveBeenLastCalledWith(
    null,
    '',
    '/zh-CN/data-foundation/explore?query=query&view=graph&businessPage=2',
  );
  nav.search = new URLSearchParams('saved=case&businessPage=3');
  rendered.rerender(<DataExplorerBusiness {...props} />);
  expect(screen.getAllByRole('article')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '全景网络' }));
  expect(history).toHaveBeenLastCalledWith(
    null,
    '',
    '/zh-CN/data-foundation/explore?query=query&view=graph&businessPresentation=network',
  );
  history.mockRestore();
});
