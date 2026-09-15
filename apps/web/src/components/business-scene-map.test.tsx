// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { BusinessSceneMap } from './business-scene-map';
import { defaultSceneView } from '@/lib/business-scene-view';
import type { BusinessScene } from '@/lib/business-scene';
const probe = vi.hoisted(() => ({
  load: null as null | (() => void),
  fit: vi.fn(),
  move: null as null | (() => void),
}));
vi.mock('maplibre-gl', () => ({ setWorkerUrl: vi.fn() }));
vi.mock('./amap-basemap', () => ({ AmapBasemap: () => null }));
vi.mock('react-map-gl/maplibre', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef<
      unknown,
      { children?: ReactNode; onLoad: () => void; onMoveEnd: () => void }
    >((p, ref) => {
      probe.load = p.onLoad;
      probe.move = p.onMoveEnd;
      useImperativeHandle(ref, () => ({
        fitBounds: probe.fit,
        getZoom: () => 8,
        getCenter: () => ({ lng: 115, lat: 40 }),
        project: () => ({ x: 100, y: 100 }),
        jumpTo: vi.fn(),
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
      }));
      return <div>{p.children}</div>;
    }),
    Source: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Layer: () => null,
  };
});
const id = '10000000-0000-4000-8000-000000000001';
const record = {
  recordId: id,
  featureId: id,
  dataItemId: id,
  versionId: id,
  analysisId: id,
  assetId: id,
  sourceId: null,
  index: 1,
  values: {},
};
const page = {
  queryId: id,
  spec: {},
  view: 'map',
  resources: [],
  totalCount: 1,
  createdAt: '2026-09-15T00:00:00Z',
  expiresAt: '2026-09-15T00:30:00Z',
  features: [
    {
      type: 'Feature',
      id,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [115, 40],
            [116, 40],
            [116, 41],
            [115, 40],
          ],
        ],
      },
      properties: record,
    },
  ],
};
const scene: BusinessScene = {
  nodes: [
    {
      id: 'bound',
      label: '影像覆盖范围',
      kind: 'DOCUMENT',
      group: 'spatial',
      classificationBasis: null,
      record,
      periods: [],
    },
    {
      id: 'unlocated',
      label: '同名地点',
      kind: 'PLACE',
      group: 'PLACE',
      classificationBasis: null,
      record: null,
      periods: [],
    },
  ],
  edges: [],
};
const props = {
  scene,
  queryId: id,
  locale: 'zh-CN' as const,
  onInvalidated: vi.fn(),
  width: 1000,
  settings: { ...defaultSceneView, form: 'space' as const },
  onSettings: vi.fn(),
  focus: { nodes: new Set<string>(), edges: new Set<string>() },
  onSelect: vi.fn(),
  onEdge: vi.fn(),
  selectedId: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('uses the full scoped map and only binds exact records while retaining unlocated nodes', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json(page));
  vi.stubGlobal('fetch', fetch);
  render(<BusinessSceneMap {...props} />);
  act(() => probe.load?.());
  await waitFor(() =>
    expect(
      screen.getByTestId('business-spatial-scene').dataset.anchorCount,
    ).toBe('1'),
  );
  const root = screen.getByTestId('business-spatial-scene');
  expect(root.querySelectorAll('[data-node-id]')).toHaveLength(2);
  expect(
    root
      .querySelector('[data-node-id="unlocated"]')
      ?.getAttribute('data-anchored'),
  ).toBe('false');
  expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
    queryId: id,
    view: 'map',
    first: 200,
  });
  act(() => probe.move?.());
  expect(props.onSettings).toHaveBeenCalledWith(
    expect.objectContaining({ mapLon: 115, mapLat: 40, mapZoom: 8 }),
  );
  fireEvent.click(root.querySelector('[data-node-id="bound"]')!);
  expect(props.onSelect).toHaveBeenCalledWith('bound');
});
it('rejects a changed query response and never shows its geometry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        ...page,
        queryId: '20000000-0000-4000-8000-000000000001',
      }),
    ),
  );
  render(<BusinessSceneMap {...props} />);
  await screen.findByRole('alert');
  expect(screen.getByTestId('business-spatial-scene').dataset.anchorCount).toBe(
    '0',
  );
});
it('invalidates denial and retries a transient failure without retaining prior geometry', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('', { status: 403 }))
    .mockResolvedValueOnce(
      Response.json({ ...page, totalCount: 0, features: [] }),
    );
  vi.stubGlobal('fetch', fetch);
  render(<BusinessSceneMap {...props} />);
  await screen.findByRole('alert');
  expect(props.onInvalidated).toHaveBeenCalledWith(id, 403);
  fireEvent.click(screen.getByRole('button', { name: '重新读取位置依据' }));
  await screen.findByText(
    '当前范围没有可绑定的位置几何，可继续查看未定位资料。',
  );
  expect(screen.getByTestId('business-spatial-scene').dataset.anchorCount).toBe(
    '0',
  );
});
it('aborts pending location requests on unmount', () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    }),
  );
  const view = render(<BusinessSceneMap {...props} />);
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
