// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { CustomLayerInterface } from 'maplibre-gl';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import type {
  WorkspaceMapFeatures,
  WorkspaceSelection,
} from '@/lib/spatial-workspace-view';
import type { WorkspaceRasterReport } from '@/lib/spatial-workspace-contract';
import { getDictionary } from '@/lib/i18n';
import { SpatialWorkspaceMap } from './spatial-workspace-map';

const probe = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  source: null as unknown,
  custom: null as CustomLayerInterface | null,
  images: [] as { id: string; url: string; coordinates: number[][] }[],
  query: vi.fn(() => []),
  stop: vi.fn(),
  jumpTo: vi.fn(),
}));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  MercatorCoordinate: {
    fromLngLat: ([lng, lat]: number[], height = 0) => ({
      x: lng / 180,
      y: lat / 90,
      z: height / 10000,
    }),
  },
}));
vi.mock('react-map-gl/maplibre', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef<
      unknown,
      Record<string, unknown> & { children?: ReactNode }
    >((props, ref) => {
      probe.props = props;
      useImperativeHandle(ref, () => ({
        getMap: () => ({
          stop: probe.stop,
          jumpTo: probe.jumpTo,
          addLayer: (layer: CustomLayerInterface) => {
            probe.custom = layer;
          },
          getLayer: () => null,
          removeLayer: vi.fn(),
          triggerRepaint: vi.fn(),
          getCanvas: () => ({ clientWidth: 800, clientHeight: 460 }),
          project: ([lng, lat]: number[]) => ({
            x: (lng / 180 + 1) * 400,
            y: (1 - lat / 90) * 230,
          }),
        }),
        queryRenderedFeatures: probe.query,
        unproject: ({ x, y }: { x: number; y: number }) => ({ lng: x, lat: y }),
      }));
      return <div data-testid="native-map">{props.children as ReactNode}</div>;
    }),
    Source: (props: {
      children?: ReactNode;
      data?: unknown;
      id: string;
      type?: string;
      url?: string;
      coordinates?: number[][];
    }) => {
      if (props.id === 'workspace-records') probe.source = props.data;
      if (props.type === 'image' && props.url && props.coordinates)
        probe.images.push({
          id: props.id,
          url: props.url,
          coordinates: props.coordinates,
        });
      return <div>{props.children}</div>;
    },
    Layer: () => null,
  };
});
const features: WorkspaceMapFeatures = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'original-polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [116, 39],
            [117, 39],
            [117, 40],
            [116, 39],
          ],
        ],
      },
      properties: {
        sourceId: 'source',
        versionId: 'v1',
        recordId: 'r1',
        positionId: 'p1',
        label: '原面',
        kind: 'policy',
        role: 'applicable-area',
      },
    },
    {
      type: 'Feature',
      id: 'original-line',
      geometry: {
        type: 'LineString',
        coordinates: [
          [116, 39],
          [117, 40],
        ],
      },
      properties: {
        sourceId: 'source',
        versionId: 'v1',
        recordId: 'r2',
        positionId: 'p2',
        label: '原线',
        kind: 'observation',
        role: 'reference',
      },
    },
  ],
};
const copy = getDictionary('zh-CN').dataFoundation.spatialWorkspace;
const camera = {
  longitude: 116.5,
  latitude: 39.5,
  zoom: 7,
  pitch: 50,
  bearing: 35,
};
const props = {
  features,
  camera,
  mode: '3d' as const,
  selection: null,
  copy,
  onCamera: vi.fn(),
  onSelect: vi.fn(),
  webGLAvailable: true,
};
beforeEach(() => {
  probe.custom = null;
  probe.images = [];
  probe.query.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('passes original geometry and the common geographic pitch/bearing to MapLibre', () => {
  render(<SpatialWorkspaceMap {...props} />);
  expect(probe.source).toEqual(features);
  expect(probe.props.pitch).toBe(50);
  expect(probe.props.bearing).toBe(35);
  expect(probe.props.dragRotate).toBe(true);
  expect(probe.props.mapStyle).not.toHaveProperty('glyphs');
  expect(JSON.stringify(probe.props.mapStyle)).not.toMatch(/https?:/);
});

it('does not accept stale non-user resize camera events after a programmatic camera change', () => {
  render(<SpatialWorkspaceMap {...props} />);
  const old = { ...camera, longitude: 113 };
  const move = probe.props.onMove as (event: unknown) => void;
  act(() => move({ viewState: old }));
  expect(props.onCamera).not.toHaveBeenCalled();
  act(() =>
    move({ viewState: old, originalEvent: new MouseEvent('mousemove') }),
  );
  expect(props.onCamera).toHaveBeenCalledExactlyOnceWith(old);
});

it('stops a gesture before applying an external camera and ignores its reflected user camera', () => {
  const { rerender } = render(<SpatialWorkspaceMap {...props} />);
  act(() => (probe.props.onLoad as () => void)());
  probe.stop.mockClear();
  probe.jumpTo.mockClear();
  const user = { ...camera, longitude: 113 };
  act(() =>
    (probe.props.onMove as (event: unknown) => void)({
      viewState: user,
      originalEvent: new MouseEvent('mousemove'),
    }),
  );
  rerender(<SpatialWorkspaceMap {...props} camera={user} />);
  expect(probe.stop).not.toHaveBeenCalled();
  const external = { ...camera, longitude: 117 };
  rerender(<SpatialWorkspaceMap {...props} camera={external} />);
  expect(probe.stop).toHaveBeenCalledOnce();
  expect(probe.jumpTo).toHaveBeenCalledExactlyOnceWith(external);
});

it('stops a hidden map and does not accept its remaining gesture callbacks', () => {
  const { rerender } = render(<SpatialWorkspaceMap {...props} />);
  act(() => (probe.props.onLoad as () => void)());
  probe.stop.mockClear();
  rerender(<SpatialWorkspaceMap {...{ ...props, active: false }} />);
  expect(probe.stop).toHaveBeenCalledOnce();
  act(() =>
    (probe.props.onMove as (event: unknown) => void)({
      viewState: { ...camera, longitude: 113 },
      originalEvent: new MouseEvent('mousemove'),
    }),
  );
  expect(props.onCamera).not.toHaveBeenCalled();
});

it('uses the public MapLibre 3D projection matrix for evidenced category stems', () => {
  const { container } = render(<SpatialWorkspaceMap {...props} />);
  act(() => (probe.props.onLoad as () => void)());
  expect(probe.custom?.renderingMode).toBe('3d');
  act(() =>
    probe.custom?.render(
      {} as WebGL2RenderingContext,
      {
        defaultProjectionData: {
          mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      } as Parameters<CustomLayerInterface['render']>[1],
    ),
  );
  const anchor = container.querySelector('[data-ground-anchor-error]');
  expect(anchor).toBeTruthy();
  expect(Number(anchor!.getAttribute('data-ground-anchor-error'))).toBeLessThan(
    0.01,
  );
  expect(container.innerHTML).not.toMatch(/perspective\(|rotateX\(|rotateY\(/);
  expect(screen.getByText(copy.categoryHeightHint)).toBeTruthy();
});

it('exposes both exact source-position hits rather than guessing one from its name', () => {
  render(<SpatialWorkspaceMap {...props} />);
  act(() =>
    (probe.props.onClick as (event: unknown) => void)({
      point: { x: 100, y: 100 },
      features: features.features,
    }),
  );
  expect(props.onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /原线/ }));
  expect(props.onSelect).toHaveBeenLastCalledWith({
    recordId: 'r2',
    positionId: 'p2',
  });
});

it('retains an actual selectable planar geometry view without WebGL', () => {
  const { container } = render(
    <SpatialWorkspaceMap {...props} webGLAvailable={false} />,
  );
  expect(screen.queryByTestId('native-map')).toBeNull();
  expect(screen.getByText(copy.noWebgl)).toBeTruthy();
  expect(
    container.querySelector('[data-planar-geometry="original-polygon"] path'),
  ).toBeTruthy();
  const geometry = screen.getByRole('button', { name: /原面/ });
  fireEvent.keyDown(geometry, { key: 'Enter' });
  expect(props.onSelect).toHaveBeenLastCalledWith({
    recordId: 'r1',
    positionId: 'p1',
  });
});

const exactPositionCases: {
  name: string;
  selection: WorkspaceSelection;
  selectedPosition: string | null;
}[] = [
  {
    name: 'the first position',
    selection: { recordId: 'shared-record', positionId: 'p1' },
    selectedPosition: 'p1',
  },
  {
    name: 'the second position',
    selection: { recordId: 'shared-record', positionId: 'p2' },
    selectedPosition: 'p2',
  },
  {
    name: 'a record without a position',
    selection: { recordId: 'shared-record', positionId: null },
    selectedPosition: null,
  },
  {
    name: 'an unavailable position',
    selection: { recordId: 'shared-record', positionId: 'missing' },
    selectedPosition: null,
  },
  {
    name: 'another record with the same position ID',
    selection: { recordId: 'other-record', positionId: 'p1' },
    selectedPosition: null,
  },
  { name: 'no selection', selection: null, selectedPosition: null },
];
it.each(exactPositionCases)(
  'highlights only the exact planar position for $name',
  ({
    selection,
    selectedPosition,
  }: {
    selection: WorkspaceSelection;
    selectedPosition: string | null;
  }) => {
    const sameRecordFeatures: WorkspaceMapFeatures = {
      ...features,
      features: features.features.map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          recordId: 'shared-record',
          kind: 'observation',
        },
      })),
    };
    const original = JSON.stringify(sameRecordFeatures);
    const { container, rerender } = render(
      <SpatialWorkspaceMap
        {...props}
        features={sameRecordFeatures}
        selection={selection}
        webGLAvailable={false}
      />,
    );
    const previousColors = sameRecordFeatures.features.map((feature) =>
      [
        ...container.querySelectorAll(
          `[data-planar-geometry="${feature.id}"] path`,
        ),
      ].map((path) => path.getAttribute('stroke')),
    );
    for (const feature of sameRecordFeatures.features) {
      const paths = container.querySelectorAll(
        `[data-planar-geometry="${feature.id}"] path`,
      );
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths)
        expect(path.getAttribute('stroke-width')).toBe(
          feature.properties.positionId === selectedPosition ? '4' : '2',
        );
    }
    fireEvent.keyDown(screen.getByRole('button', { name: /原线/ }), {
      key: 'Enter',
    });
    expect(props.onSelect).toHaveBeenLastCalledWith({
      recordId: 'shared-record',
      positionId: 'p2',
    });
    rerender(
      <SpatialWorkspaceMap
        {...props}
        features={sameRecordFeatures}
        selection={null}
        webGLAvailable={false}
      />,
    );
    for (const path of container.querySelectorAll(
      '[data-planar-geometry] path',
    ))
      expect(path.getAttribute('stroke-width')).toBe('2');
    for (const [
      featureIndex,
      feature,
    ] of sameRecordFeatures.features.entries()) {
      const paths = container.querySelectorAll(
        `[data-planar-geometry="${feature.id}"] path`,
      );
      for (const [pathIndex, path] of paths.entries()) {
        const prior = previousColors[featureIndex]?.[pathIndex];
        if (feature.properties.positionId === selectedPosition)
          expect(prior).not.toBe(path.getAttribute('stroke'));
        else expect(prior).toBe(path.getAttribute('stroke'));
      }
    }
    expect(JSON.stringify(sameRecordFeatures)).toBe(original);
  },
);

it('renders accessible SVG titles as a single text child without server warnings', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  renderToStaticMarkup(
    <SpatialWorkspaceMap {...props} webGLAvailable={false} />,
  );
  expect(errors.mock.calls.flat().join(' ')).not.toMatch(
    /title.*children|children.*title/,
  );
  errors.mockRestore();
});

it('hydrates the same SVG paths across last-bit projection differences without changing source geometry', async () => {
  const original = JSON.stringify(features);
  const host = document.createElement('div');
  host.innerHTML = renderToString(
    <SpatialWorkspaceMap {...props} webGLAvailable={false} />,
  );
  const serverPaths = [...host.querySelectorAll('path')].map((path) =>
    path.getAttribute('d'),
  );
  document.body.appendChild(host);
  const nativeLog = Math.log;
  const projection = vi
    .spyOn(Math, 'log')
    .mockImplementation((value) => nativeLog(value) + 1e-14 * (value - 1));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(
        host,
        <SpatialWorkspaceMap {...props} webGLAvailable={false} />,
      );
      await Promise.resolve();
    });
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(
      /hydrat|didn't match/i,
    );
    expect(
      [...host.querySelectorAll('path')].map((path) => path.getAttribute('d')),
    ).toEqual(serverPaths);
    expect(JSON.stringify(features)).toBe(original);
  } finally {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    host.remove();
    projection.mockRestore();
    errors.mockRestore();
  }
});

it('unloads a failed canvas and leaves the record positions selectable for retry', () => {
  render(<SpatialWorkspaceMap {...props} />);
  act(() => (probe.props.onError as () => void)());
  expect(screen.queryByTestId('native-map')).toBeNull();
  expect(screen.getByText(copy.renderFailed)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /原线/ }));
  expect(props.onSelect).toHaveBeenLastCalledWith({
    recordId: 'r2',
    positionId: 'p2',
  });
  fireEvent.click(screen.getByRole('button', { name: copy.retryMap }));
  expect(screen.getByTestId('native-map')).toBeTruthy();
});

it('places retained imagery at its four WGS84 corners without loading a public image service', () => {
  const raster: WorkspaceRasterReport = {
    id: 'retained-window',
    sourceId: 'sentinel',
    versionId: 'fixed-window',
    sceneId: 'one-scene',
    acquiredAt: '2026-08-24',
    regionIds: ['yongding'],
    title: '真实窗口',
    products: [
      {
        band: 'TCI',
        width: 512,
        height: 512,
        channels: 3,
        dtype: 'uint8',
        sha256: 'c'.repeat(64),
        hashMatches: true,
        readable: true,
        nativeCrs: 'EPSG:32650',
        resolution: [10, 10],
        noData: [0],
        scales: [1],
        offsets: [0],
        stats: { min: 0, max: 255, validPixels: 100, noDataPixels: 0 },
        classFrequency: null,
        thumbnailUrl: '/spatial-workspace-media/tci-wgs84.png',
      },
    ],
    wgs84Bounds: [115.5, 40.2, 115.8, 40.5],
    footprint: null,
    qualityLayerPresent: true,
    oneSceneOnly: true,
    controlPointVerified: false,
    rights: {
      displayAllowed: true,
      redistributionAllowed: true,
      note: 'Copernicus',
    },
    limitations: ['单景，未控制点核验'],
  };
  const { rerender } = render(
    <SpatialWorkspaceMap {...props} rasterReports={[raster]} />,
  );
  expect(
    probe.images.some(
      (image) =>
        image.url === '/spatial-workspace-media/tci-wgs84.png' &&
        JSON.stringify(image.coordinates) ===
          JSON.stringify([
            [115.5, 40.5],
            [115.8, 40.5],
            [115.8, 40.2],
            [115.5, 40.2],
          ]),
    ),
  ).toBe(true);
  probe.images = [];
  rerender(
    <SpatialWorkspaceMap
      {...props}
      rasterReports={[
        { ...raster, rights: { ...raster.rights, displayAllowed: false } },
      ]}
    />,
  );
  expect(probe.images).toHaveLength(0);
  probe.images = [];
  rerender(
    <SpatialWorkspaceMap
      {...props}
      rasterReports={[
        {
          ...raster,
          products: [
            {
              ...raster.products[0],
              thumbnailUrl: 'https://public-server.example/hidden-image.png',
            },
          ],
        },
      ]}
    />,
  );
  expect(probe.images).toHaveLength(0);
});
