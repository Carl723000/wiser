// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { getDictionary } from '@/lib/i18n';
import type {
  WorkspacePack,
  WorkspaceRasterReport,
} from '@/lib/spatial-workspace-contract';
import { SpatialRasterInspection } from './spatial-raster-inspection';
const report: WorkspaceRasterReport = {
  id: 'scene1',
  sourceId: 'sentinel',
  versionId: 'v1',
  sceneId: 'one-scene',
  acquiredAt: '2026-08-24T03:05:19Z',
  regionIds: ['yongding'],
  title: '公开影像',
  products: [
    {
      band: 'B03',
      width: 1080,
      height: 1292,
      channels: 1,
      dtype: 'uint16',
      sha256: 'a'.repeat(64),
      hashMatches: true,
      readable: true,
      nativeCrs: 'EPSG:32650',
      resolution: [20, 20],
      noData: [null],
      scales: [1],
      offsets: [0],
      stats: { min: 0, max: 5000, validPixels: 1395360, noDataPixels: 0 },
      classFrequency: null,
      thumbnailUrl: '/spatial-workspace-media/b03-wgs84.png',
    },
  ],
  wgs84Bounds: [115, 40, 116, 41],
  footprint: null,
  qualityLayerPresent: true,
  oneSceneOnly: true,
  controlPointVerified: false,
  rights: {
    displayAllowed: true,
    redistributionAllowed: true,
    note: 'Modified Copernicus public data',
  },
  limitations: ['Not water quality inversion'],
  pixelProbes: [
    {
      id: 'r10-c20',
      row: 10,
      column: 20,
      coordinates: [115.5, 40.5],
      rawValues: { B03: [1857], B8A: [4150], SCL: [4], TCI: [75, 89, 61] },
      sclLabel: '植被',
    },
  ],
};
const pack = { rasterReports: [report] } as WorkspacePack;
afterEach(cleanup);
it('distinguishes an undeclared NoData tag from the zero missing-pixel count in the file mask', () => {
  render(
    <SpatialRasterInspection
      pack={pack}
      copy={getDictionary('zh-CN').dataFoundation.spatialManagement}
    />,
  );
  expect(screen.getByText('未声明')).toBeTruthy();
  expect(
    screen.getByRole('columnheader', { name: '文件掩膜缺失像元' }),
  ).toBeTruthy();
  expect(screen.getByText('NoData 标签')).toBeTruthy();
  expect(screen.getByText('0', { selector: 'td' })).toBeTruthy();
});
it('shows one scene with real native dimensions and selects a checked pixel without inventing reflectance', () => {
  render(
    <SpatialRasterInspection
      pack={pack}
      copy={getDictionary('zh-CN').dataFoundation.spatialManagement}
    />,
  );
  expect(screen.getByText('1080 × 1292 · 1')).toBeTruthy();
  expect(screen.getByRole('img').getAttribute('src')).toBe(
    '/spatial-workspace-media/b03-wgs84.png',
  );
  fireEvent.change(screen.getByLabelText('预检像元'), {
    target: { value: 'r10-c20' },
  });
  expect(screen.getByTestId('pixel-values').textContent).toContain('1857');
  expect(screen.getByTestId('pixel-values').textContent).toContain(
    '75, 89, 61',
  );
  expect(screen.getByText('植被')).toBeTruthy();
});
it('keeps unavailable reports and products explicit without creating a scene', () => {
  render(
    <SpatialRasterInspection
      pack={{ rasterReports: [] } as unknown as WorkspacePack}
      copy={getDictionary('en').dataFoundation.spatialManagement}
    />,
  );
  expect(screen.getByText('This batch has no inspection report.')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
});
