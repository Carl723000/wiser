import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspacePack } from '@/lib/spatial-workspace-contract';
import { loadLocalSpatialWorkspace } from '@/lib/spatial-workspace-local';
import Page from './[locale]/data-foundation/spatial-workspace/page';
import Source from './[locale]/data-foundation/spatial-workspace/source/page';
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: '127.0.0.1:3410' })),
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
  SpatialWorkspaceShell: ({
    initialRecordId,
  }: {
    initialRecordId: string | null;
  }) => <div>{initialRecordId ?? 'ready'}</div>,
}));
const load = vi.mocked(loadLocalSpatialWorkspace);
const pack = {
  sources: [
    {
      id: 'report',
      versionId: 'v1',
      title: 'Fixed original',
      provider: 'Publisher',
      originalSha256: 'a'.repeat(64),
      evidenceUrl: 'https://example.org/report',
      rights: { note: 'public' },
    },
  ],
  records: [
    {
      id: 'r1',
      sourceId: 'report',
      versionId: 'v1',
      objectLabel: 'River',
      metric: 'category',
      value: 'Ⅲ',
      time: { start: '2023-04' },
      evidence: [{ locator: 'table:1/row:14', text: 'Original passage' }],
    },
  ],
} as unknown as WorkspacePack;
beforeEach(() => load.mockReset());
it('keeps a missing or invalid local batch explicit and never fills it from a fixture', async () => {
  for (const state of ['disabled', 'unavailable', 'invalid'] as const) {
    load.mockResolvedValue({ state, pack: null });
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ locale: 'zh-CN' }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('/data-foundation/explore');
    expect(html).not.toContain('ready');
  }
});
it('forwards the requested record only after the local pack passes the boundary', async () => {
  load.mockResolvedValue({ state: 'ready', pack });
  expect(
    renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ locale: 'en' }),
        searchParams: Promise.resolve({ record: 'r1' }),
      }),
    ),
  ).toContain('r1');
  await expect(
    Page({
      params: Promise.resolve({ locale: 'xx' }),
      searchParams: Promise.resolve({}),
    }),
  ).rejects.toThrow('NOT_FOUND');
});
it('opens the exact source version and returns to the selected record without disclosing local paths', async () => {
  load.mockResolvedValue({ state: 'ready', pack });
  const html = renderToStaticMarkup(
    await Source({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve({ source: 'report', version: 'v1' }),
    }),
  );
  expect(html).toContain('table:1/row:14');
  expect(html).toContain('Original passage');
  expect(html).toContain('record=r1');
  expect(html).not.toContain('/Users/');
  await expect(
    Source({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve({ source: 'report', version: 'wrong' }),
    }),
  ).rejects.toThrow('NOT_FOUND');
});
it('identifies the retained raster hash scope and labels its license as a license', async () => {
  const raster = structuredClone(pack);
  raster.sources[0].kind = 'raster';
  raster.sources[0].coverageNote =
    'TCI retained crop, one scene and four products.';
  raster.sources[0].evidenceUrl = 'https://example.org/license';
  load.mockResolvedValue({ state: 'ready', pack: raster });
  const html = renderToStaticMarkup(
    await Source({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve({ source: 'report', version: 'v1' }),
    }),
  );
  expect(html).toContain('Retained original hash (TCI crop)');
  expect(html).toContain('TCI retained crop, one scene and four products.');
  expect(html).toContain('Read source license');
  expect(html).not.toContain('Open published original');
});
