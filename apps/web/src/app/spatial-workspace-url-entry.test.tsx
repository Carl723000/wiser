import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspacePack } from '@/lib/spatial-workspace-contract';
import { loadLocalSpatialWorkspace } from '@/lib/spatial-workspace-local';
import {
  decodeWorkspaceReadingUrl,
  encodeWorkspaceReadingUrl,
  type WorkspaceReadingUrlState,
} from '@/lib/spatial-workspace-url-state';
import Page from './[locale]/data-foundation/spatial-workspace/page';
import SourcePage from './[locale]/data-foundation/spatial-workspace/source/page';

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: '127.0.0.1:3421' })),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/spatial-workspace-local', () => ({
  loadLocalSpatialWorkspace: vi.fn(),
}));
vi.mock('@/components/spatial-workspace-shell', () => ({
  SpatialWorkspaceShell: (props: {
    initialReadingState?: WorkspaceReadingUrlState;
  }) => <output>{JSON.stringify(props.initialReadingState ?? null)}</output>,
}));
const load = vi.mocked(loadLocalSpatialWorkspace);

function fixture(): WorkspacePack {
  // Deterministic synthetic construction exercising the REAL navigation lane;
  // this is neither an acquired source nor professional approval.
  const material = {
    id: 'fixture-report',
    versionId: 'fixture-v1',
    title: 'Private fixture source',
    provider: 'Fixture publisher',
    kind: 'report' as const,
    originalSha256: 'a'.repeat(64),
    evidenceUrl: 'https://example.org/fixture',
    processingVersion: 'fixture-parser-1',
    track: 'REAL' as const,
    regionIds: ['chaobai' as const],
    needIds: ['K5-001', 'K5-002'],
    duplicateOf: null,
    rights: {
      public: false,
      displayAllowed: true,
      redistributionAllowed: false,
      note: 'Fixture permission',
    },
    status: {
      original: 'saved',
      parsed: 'ready',
      checked: 'unknown',
      professionalReview: 'pending',
      space: 'reference',
      use: 'unknown',
    },
  };
  const record = {
    id: 'fixture-r1',
    sourceId: material.id,
    versionId: material.versionId,
    processingVersion: 'fixture-row-1',
    track: 'REAL' as const,
    objectId: 'fixture-object-1',
    objectLabel: 'Private April object',
    kind: 'observation' as const,
    regionIds: ['chaobai' as const],
    needIds: ['K5-001'],
    time: {
      start: '2023-04',
      end: '2023-04',
      precision: 'month' as const,
      role: 'publication' as const,
    },
    metric: '原类别',
    value: 'Ⅲ',
    unit: null,
    reviewStatus: 'pending' as const,
    missingReasons: [],
    evidence: [
      {
        locator: 'fixture-table:1/row:1',
        text: 'Private April evidence',
        url: null,
      },
    ],
    positions: [],
  };
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-04T00:00:00Z',
    processingVersion: 'fixture-pack-1',
    sources: [material],
    records: [
      record,
      {
        ...record,
        id: 'fixture-r2',
        objectId: 'fixture-object-2',
        objectLabel: 'Private June object',
        time: { ...record.time, start: '2023-06', end: '2023-06' },
        evidence: [
          {
            locator: 'fixture-table:1/row:2',
            text: 'Private June evidence',
            url: null,
          },
        ],
      },
    ],
    regions: ['bth', 'chaobai', 'beiyun'].map((id) => ({
      id: id as 'bth' | 'chaobai' | 'beiyun',
      name: 'Fixture region',
      aliases: [],
      type: 'navigation extent',
      bounds: [113, 36, 120, 43],
    })),
    topicPackages: [],
    rasterReports: [],
  };
}
const state: WorkspaceReadingUrlState = {
  track: 'REAL',
  regionId: 'chaobai',
  needId: 'K5-001',
  dateRole: 'PUBLICATION',
  monthWindow: { start: '2023-04', end: '2023-04' },
  tab: 'readiness',
  pane: 'results',
  source: {
    sourceId: 'fixture-report',
    versionId: 'fixture-v1',
    sha256: 'a'.repeat(64),
    processingVersion: 'fixture-parser-1',
  },
  selection: {
    recordId: 'fixture-r1',
    processingVersion: 'fixture-row-1',
    position: null,
  },
};
function query(pack = fixture(), value = state) {
  const encoded = encodeWorkspaceReadingUrl('en', value, { pack });
  if (encoded.status !== 'valid') throw new Error('Invalid test construction');
  return new URL(encoded.href, 'https://wiser.example.test').searchParams;
}
function search(params: URLSearchParams): Record<string, string | string[]> {
  const value: Record<string, string | string[]> = {};
  for (const key of params.keys()) {
    const items = params.getAll(key);
    value[key] = items.length === 1 ? items[0] : items;
  }
  return value;
}
async function pageHtml(params: URLSearchParams) {
  return renderToStaticMarkup(
    await Page({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve(search(params) as { record?: string }),
    }),
  );
}
async function sourceHtml(params: URLSearchParams) {
  return renderToStaticMarkup(
    await SourcePage({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve(
        search(params) as { source?: string; version?: string },
      ),
    }),
  );
}
beforeEach(() => {
  load.mockReset();
  load.mockResolvedValue({ state: 'ready', pack: fixture() });
});

it('passes all fixed reading choices together instead of only a record ID', async () => {
  const html = await pageHtml(query());
  expect(html).toContain('PUBLICATION');
  expect(html).toContain('readiness');
  expect(html).toContain('results');
  expect(html).toContain('fixture-parser-1');
  expect(html).toContain('fixture-row-1');
  expect(html).not.toContain('Private April evidence');
});
it.each([
  ['region', 'unknown-region'],
  ['need', 'K5-002'],
  ['track', 'SYNTHETIC'],
  ['recordRule', 'changed-rule'],
  ['sourceHash', 'b'.repeat(64)],
  ['monthStart', '2023-05'],
  ['token', 'not-a-valid-parameter'],
])(
  'keeps invalid %s closed rather than restoring a default or the record',
  async (key, value) => {
    const params = query();
    params.set(key, value);
    const html = await pageHtml(params);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('fixture-r1');
    expect(html).not.toContain(value);
  },
);
it('rejects repeated query choices from Next search parameters', async () => {
  const params = query();
  params.append('region', 'chaobai');
  const html = await pageHtml(params);
  expect(html).toContain('role="alert"');
  expect(html).not.toContain('fixture-r1');
});
it('keeps an old bare record link incomplete while preserving a truly bare default entry', async () => {
  expect(await pageHtml(new URLSearchParams('record=fixture-r1'))).toContain(
    'role="alert"',
  );
  expect(await pageHtml(new URLSearchParams())).not.toContain('role="alert"');
});
it('lists only records in the fixed source reading scope and returns with the same pin', async () => {
  const html = await sourceHtml(query());
  expect(html).toContain('Private April evidence');
  expect(html).not.toContain('Private June evidence');
  expect(html).toContain('sourceHash=');
  expect(html).toContain('recordRule=fixture-row-1');
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) =>
    match[1].replaceAll('&amp;', '&'),
  );
  const recordLink = links.find((href) => href.includes('record=fixture-r1'));
  expect(recordLink).toBeTruthy();
  const decoded = decodeWorkspaceReadingUrl(
    new URL(recordLink!, 'https://wiser.example.test').searchParams,
    { pack: fixture() },
  );
  expect(decoded.status).toBe('valid');
  if (decoded.status !== 'valid') throw new Error('Invalid return link');
  expect(decoded.state.regionId).toBe('chaobai');
  expect(decoded.state.needId).toBe('K5-001');
  expect(decoded.state.dateRole).toBe('PUBLICATION');
  expect(decoded.state.monthWindow).toEqual(state.monthWindow);
  expect(decoded.state.source).toEqual(state.source);
  expect(decoded.state.selection).toEqual(state.selection);
});
it.each(['withdrawn', 'unavailable', 'ambiguous', 'legacy'])(
  'does not display a %s source or its original text',
  async (condition) => {
    const pack = fixture();
    const params = query();
    if (condition === 'withdrawn')
      pack.sources[0].rights.displayAllowed = false;
    if (condition === 'ambiguous') pack.sources.push({ ...pack.sources[0] });
    if (condition === 'legacy') {
      params.delete('sourceHash');
      params.delete('sourceRule');
    }
    load.mockResolvedValue({
      state: condition === 'unavailable' ? 'disabled' : 'ready',
      pack,
    });
    const html = await sourceHtml(params);
    expect(html).toMatch(/role="(?:alert|status)"/);
    expect(html).not.toContain('Private fixture source');
    expect(html).not.toContain('Private April evidence');
  },
);
