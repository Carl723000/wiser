// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ExplorationResultSchema } from '@wiser/data-contracts';
import { DataExplorer } from './data-explorer';
import type { DataExplorerReadiness } from './data-explorer-readiness';
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));
vi.mock('./data-explorer-readiness', () => ({
  DataExplorerReadiness: ({
    onFilter,
  }: ComponentProps<typeof DataExplorerReadiness>) => (
    <button onClick={() => onFilter('records', 'READY')}>
      Filter ready sources
    </button>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps the original membership when narrowing a project through readiness statistics', async () => {
  const id = '10000000-0000-4000-8000-000000000001';
  const initial = ExplorationResultSchema.parse({
    queryId: id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    spec: {
      scope: 'project',
      businessQuery: {
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
      },
    },
    summary: {
      resourceCount: 0,
      analyzedResourceCount: 0,
      indexedRecordCount: 0,
      indexedFeatureCount: 0,
      records: [],
      spatial: [],
    },
    membership: { complete: true, versionCount: 0, assertionCount: 0 },
    view: 'resources',
    totalCount: 0,
    resources: [],
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(initial));
  vi.stubGlobal('fetch', fetcher);
  render(
    <DataExplorer
      locale="en"
      initialResult={initial}
      initialFailure={null}
      initialText=""
      initialView="statistics"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Filter ready sources' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  const body = fetcher.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw Error('Expected request body');
  expect(JSON.parse(body)).toMatchObject({
    baseQueryId: id,
    spec: { scope: 'project', readiness: { records: ['READY'] } },
  });
});
