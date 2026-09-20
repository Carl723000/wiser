import { beforeEach, expect, it, vi } from 'vitest';
const explore = vi.hoisted(() => vi.fn().mockResolvedValue(null));
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
  expect(page.props.initialView).toBe('graph');
});
it('uses the same project graph for an unfiltered exploration entry, while explicit search remains resource search', async () => {
  const page = await ExplorePage({
    params: Promise.resolve({ locale: 'en' }),
    searchParams: Promise.resolve({}),
  });
  expect(explore.mock.calls[0][0].spec.scope).toBe('project');
  expect(page.props.initialView).toBe('graph');
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
  expect(searched.props.initialView).toBe('resources');
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
  expect(page.props.initialResult).toBeNull();
  expect(page.props.initialFailure).toBe('unavailable');
});
