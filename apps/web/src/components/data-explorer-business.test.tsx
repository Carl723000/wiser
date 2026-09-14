// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BusinessQuerySchema,
  type RelationAssertion,
} from '@wiser/data-contracts';
import { DataExplorerBusiness } from './data-explorer-business';
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
