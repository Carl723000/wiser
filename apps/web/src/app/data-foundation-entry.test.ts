import type { ComponentProps, ReactElement } from 'react';
import type { DataExplorer } from '../components/data-explorer';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
  ExplorationQueryInput,
  ExplorationResult,
} from '@wiser/data-contracts';
const explore = vi.hoisted(() =>
  vi
    .fn<(input: ExplorationQueryInput) => Promise<ExplorationResult | null>>()
    .mockResolvedValue(null),
);
vi.mock('../components/data-explorer', () => ({ DataExplorer: () => null }));
vi.mock('../lib/data-foundation-dal.server', () => ({
  getDataFoundationDal: () => Promise.resolve({ explore }),
  DataFoundationApiError: class extends Error {
    constructor(
      readonly kind: string,
      readonly status: number,
    ) {
      super(kind);
    }
  },
}));
vi.mock('../lib/data-foundation-page.server', () => ({
  handleDataPageError: vi.fn(),
  dataFoundationMetadata: vi.fn(),
}));
import ExplorePage from './[locale]/data-foundation/explore/page';

function entryProps(page: ReactElement) {
  return page.props as ComponentProps<typeof DataExplorer>;
}
beforeEach(() => explore.mockClear());
const dataItem = '11111111-1111-4111-8111-111111111111';
const version = '22222222-2222-4222-8222-222222222222';
it('starts all exploration views from the exact version selected in a resource link', async () => {
  await ExplorePage({
    params: Promise.resolve({ locale: 'en' }),
    searchParams: Promise.resolve({ dataItem, version, view: 'graph' }),
  });
  expect(explore).toHaveBeenCalledWith({
    spec: { versions: [{ dataItemId: dataItem, versionId: version }] },
    view: 'resources',
    first: 25,
  });
});
it.each([
  { dataItem },
  { version },
  { dataItem, version: 'wrong' },
  { dataItem: [dataItem], version },
])(
  'does not widen a malformed version link into a query of all data: %j',
  async (searchParams) => {
    await ExplorePage({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve(searchParams),
    });
    expect(explore).not.toHaveBeenCalled();
  },
);

it('opens the normal homepage on the complete authorized mixed-state project graph', async () => {
  const { default: HomePage } = await import('./[locale]/data-foundation/page');
  const page = await HomePage({
    params: Promise.resolve({ locale: 'zh-CN' }),
    searchParams: Promise.resolve({}),
  });
  expect(explore).toHaveBeenCalledWith({
    spec: {
      scope: 'project',
      businessQuery: {
        schemaVersion: 2,
        status: 'APPROVED_AND_PENDING',
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
    view: 'resources',
    first: 25,
  });
  expect(entryProps(page).initialView).toBe('graph');
});
it('uses the same project graph for an unfiltered exploration entry, while explicit search remains resource search', async () => {
  const page = await ExplorePage({
    params: Promise.resolve({ locale: 'en' }),
    searchParams: Promise.resolve({}),
  });
  expect(explore.mock.calls[0][0].spec?.scope).toBe('project');
  expect(entryProps(page).initialView).toBe('graph');
  explore.mockClear();
  const searched = await ExplorePage({
    params: Promise.resolve({ locale: 'en' }),
    searchParams: Promise.resolve({ q: 'Yongding' }),
  });
  expect(explore).toHaveBeenCalledWith({
    spec: { text: 'Yongding' },
    view: 'resources',
    first: 25,
  });
  expect(entryProps(searched).initialView).toBe('resources');
});
it('resumes a home query without creating another project membership', async () => {
  const { default: HomePage } = await import('./[locale]/data-foundation/page');
  await HomePage({
    params: Promise.resolve({ locale: 'zh-CN' }),
    searchParams: Promise.resolve({ query: dataItem, view: 'map' }),
  });
  expect(explore).toHaveBeenCalledWith({
    queryId: dataItem,
    view: 'resources',
    first: 25,
  });
});
it('never substitutes a project panorama when its query fails', async () => {
  explore.mockRejectedValueOnce(new Error('Unavailable'));
  const page = await ExplorePage({
    params: Promise.resolve({ locale: 'en' }),
    searchParams: Promise.resolve({}),
  });
  expect(explore).toHaveBeenCalledTimes(1);
  expect(entryProps(page).initialResult).toBeNull();
  expect(entryProps(page).initialFailure).toBe('unavailable');
});

it.each([{ q: '' }, { q: '  ', quality: '' }, { quality: '  ' }])(
  'treats empty resource filters as an unfiltered entry: %j',
  async (searchParams) => {
    const page = await ExplorePage({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve(searchParams),
    });
    expect(explore).toHaveBeenCalledTimes(1);
    expect(explore.mock.calls[0][0].spec?.scope).toBe('project');
    expect(entryProps(page).initialView).toBe('graph');
  },
);
it.each([{ q: ['one', 'two'] }, { q: 'x'.repeat(513) }])(
  'does not silently discard an invalid resource search',
  async (searchParams) => {
    const page = await ExplorePage({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve(searchParams),
    });
    expect(explore).not.toHaveBeenCalled();
    expect(entryProps(page).initialFailure).toBe('expired');
  },
);
