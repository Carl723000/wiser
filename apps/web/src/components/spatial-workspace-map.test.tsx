// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { CustomLayerInterface } from 'maplibre-gl';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import type {
  WorkspaceMapFeatures,
  WorkspaceSelection,
} from '@/lib/spatial-workspace-view';
import type { WorkspaceRasterReport } from '@/lib/spatial-workspace-contract';
import type { PublicReferences } from '@/lib/spatial-public-reference';
import { getDictionary } from '@/lib/i18n';
import { SpatialWorkspaceMap } from './spatial-workspace-map';

const probe = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  source: null as unknown,
  publicReferences: null as unknown,
  custom: null as CustomLayerInterface | null,
  images: [] as { id: string; url: string; coordinates: number[][] }[],
  query: vi.fn(() => []),
  stop: vi.fn(),
  jumpTo: vi.fn(),
  native: null as unknown,
  zooming: vi.fn(() => false),
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
      const native = {
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
        scrollZoom: { isZooming: probe.zooming },
      };
      probe.native = native;
      useImperativeHandle(ref, () => ({
        getMap: () => native,
        queryRenderedFeatures: probe.query,
        unproject: ({ x, y }: { x: number; y: number }) => ({ lng: x, lat: y }),
      }));
      return (
        <div
          data-testid="native-map"
          onWheel={(event) =>
            (props.onWheel as ((event: unknown) => void) | undefined)?.({
              target: native,
              originalEvent: event.nativeEvent,
            })
          }
        >
          {props.children as ReactNode}
        </div>
      );
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
      if (props.id === 'workspace-public-references')
        probe.publicReferences = props.data;
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
const publicReferences: PublicReferences = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'admin',
      geometry: features.features[0].geometry,
      properties: {
        kind: 'administrative',
        label: '行政参考',
        fixedSourceId: 'osm-admin-reference-20260919',
        sourceFileSha256: 'a'.repeat(64),
        originalSha256: ['b'.repeat(64)],
        attribution: '© OpenStreetMap contributors · ODbL 1.0',
        licenseUrl: 'https://www.openstreetmap.org/copyright',
        sourceUrl: 'https://www.openstreetmap.org/relation/1',
        limitation: '不是法定边界',
        scope: 'public-geographic-reference',
        crs: 'EPSG:4326',
      },
    },
    {
      type: 'Feature',
      id: 'watercourse',
      geometry: features.features[1].geometry,
      properties: {
        kind: 'watercourse',
        label: '水系参考',
        fixedSourceId: 'osm-river-reference-20260919',
        sourceFileSha256: 'c'.repeat(64),
        originalSha256: ['d'.repeat(64)],
        attribution: '© OpenStreetMap contributors · ODbL 1.0',
        licenseUrl: 'https://www.openstreetmap.org/copyright',
        sourceUrl: 'https://www.openstreetmap.org/way/2',
        limitation: '不是月报边界',
        scope: 'public-geographic-reference',
        crs: 'EPSG:4326',
      },
    },
    {
      type: 'Feature',
      id: 'reach',
      geometry: features.features[1].geometry,
      properties: {
        kind: 'reference-reach',
        label: '河段参考',
        fixedSourceId: 'openstreetmap',
        sourceFileSha256: 'e'.repeat(64),
        originalSha256: ['f'.repeat(64)],
        attribution: '© OpenStreetMap contributors · ODbL 1.0',
        licenseUrl: 'https://www.openstreetmap.org/copyright',
        sourceUrl: 'https://www.openstreetmap.org/way/3',
        limitation: '未完成历史边界核验',
        scope: 'public-geographic-reference',
        crs: 'EPSG:4326',
      },
    },
  ],
};
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

it('delivers a WGS84 canvas pick only to an active inspection reader while retaining ordinary record selection', () => {
  const onCoordinate = vi.fn();
  const { rerender } = render(
    <SpatialWorkspaceMap {...props} {...{ onCoordinate }} webGLAvailable />,
  );
  const event = {
    lngLat: { lng: 116.7, lat: 40.1 },
    point: { x: 400, y: 230 },
    features: [],
  };
  act(() => (probe.props.onClick as (event: unknown) => void)(event));
  expect(onCoordinate).toHaveBeenCalledWith([116.7, 40.1]);
  rerender(
    <SpatialWorkspaceMap
      {...props}
      {...{ onCoordinate }}
      active={false}
      webGLAvailable
    />,
  );
  act(() => (probe.props.onClick as (event: unknown) => void)(event));
  expect(onCoordinate).toHaveBeenCalledTimes(1);
  expect(props.onSelect).not.toHaveBeenCalled();
});

it('draws one-finger WGS84 inspection bounds and discards a cancelled or multi-touch gesture', () => {
  const onBounds = vi.fn();
  render(
    <SpatialWorkspaceMap
      {...props}
      drawBounds
      onBounds={onBounds}
      webGLAvailable
    />,
  );
  const touch = (lng: number, lat: number, count = 1) => ({
    lngLat: { lng, lat },
    points: Array.from({ length: count }, () => ({ x: 0, y: 0 })),
    originalEvent: { touches: { length: count } },
    preventDefault: vi.fn(),
  });
  const start = touch(116.5, 40.1),
    end = touch(116.6, 40.2);
  act(() => (probe.props.onTouchStart as (event: unknown) => void)?.(start));
  act(() => (probe.props.onTouchMove as (event: unknown) => void)?.(end));
  act(() => (probe.props.onTouchEnd as (event: unknown) => void)?.(end));
  expect(onBounds).toHaveBeenCalledWith([116.5, 40.1, 116.6, 40.2]);
  act(() => (probe.props.onTouchStart as (event: unknown) => void)?.(start));
  act(() => (probe.props.onTouchCancel as (event: unknown) => void)?.(end));
  act(() => (probe.props.onTouchEnd as (event: unknown) => void)?.(end));
  act(() =>
    (probe.props.onTouchStart as (event: unknown) => void)?.(
      touch(116.5, 40.1, 2),
    ),
  );
  act(() => (probe.props.onTouchEnd as (event: unknown) => void)?.(end));
  expect(onBounds).toHaveBeenCalledTimes(1);
});

it('keeps WGS84 picking and returned TCI cell colors in the existing planar fallback', () => {
  const onCoordinate = vi.fn();
  const inspectionGeometry = {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: { kind: 'pixel' as const, color: 'rgb(43,72,45)' },
        geometry: features.features[0].geometry,
      },
    ],
  };
  const { container } = render(
    <SpatialWorkspaceMap
      {...props}
      camera={{ ...camera, bearing: 0, pitch: 0 }}
      features={{ type: 'FeatureCollection', features: [] }}
      mode="2d"
      {...{ onCoordinate, inspectionGeometry }}
      webGLAvailable={false}
    />,
  );
  fireEvent.click(screen.getByLabelText(copy.planarView), {
    clientX: 400,
    clientY: 230,
  });
  expect(onCoordinate).toHaveBeenCalledTimes(1);
  const coordinate = onCoordinate.mock.calls[0][0] as readonly [number, number];
  expect(coordinate[0]).toBeCloseTo(116.5, 10);
  expect(coordinate[1]).toBeCloseTo(39.5, 10);
  expect(
    container
      .querySelector('[data-inspection-kind="pixel"] path')
      ?.getAttribute('fill'),
  ).toBe('rgb(43,72,45)');
  expect(props.onSelect).not.toHaveBeenCalled();
});
beforeEach(() => {
  probe.custom = null;
  probe.images = [];
  probe.source = null;
  probe.publicReferences = null;
  probe.query.mockClear();
  probe.zooming.mockReturnValue(false);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

it('draws independent reference sources below record layers with separate switches', () => {
  render(
    <SpatialWorkspaceMap
      {...props}
      publicReferences={publicReferences}
      publicReferenceState="ready"
    />,
  );
  expect((probe.publicReferences as PublicReferences).features).toHaveLength(3);
  expect(probe.source).toEqual(features);
  expect(probe.props.interactiveLayerIds).not.toContain(
    'workspace-public-watercourse',
  );
  const administrative = screen.getByLabelText(
    copy.publicReferenceKinds.administrative,
  );
  expect(administrative instanceof HTMLInputElement).toBe(true);
  if (!(administrative instanceof HTMLInputElement))
    throw new Error('Missing public reference switch');
  expect(administrative.checked).toBe(true);
  fireEvent.click(
    screen.getByLabelText(copy.publicReferenceKinds.administrative),
  );
  expect(
    (probe.publicReferences as PublicReferences).features.map(
      (feature) => feature.properties.kind,
    ),
  ).toEqual(['watercourse', 'reference-reach']);
  fireEvent.click(screen.getByLabelText(copy.publicReferenceKinds.watercourse));
  expect(
    (probe.publicReferences as PublicReferences).features.map(
      (feature) => feature.properties.kind,
    ),
  ).toEqual(['reference-reach']);
  fireEvent.click(
    screen.getByLabelText(copy.publicReferenceKinds['reference-reach']),
  );
  expect((probe.publicReferences as PublicReferences).features).toHaveLength(0);
  fireEvent.click(screen.getByText(copy.publicReferenceEvidence));
  expect(screen.getByText('b'.repeat(64))).toBeTruthy();
  expect(screen.getByText(copy.publicReferenceLimit)).toBeTruthy();
});

it('uses noninteractive SVG reference geometry without adding a record location', () => {
  const { container } = render(
    <SpatialWorkspaceMap
      {...props}
      webGLAvailable={false}
      publicReferences={publicReferences}
    />,
  );
  expect(
    container.querySelectorAll('[data-public-reference-kind]'),
  ).toHaveLength(3);
  expect(
    container
      .querySelector('[data-public-reference-kind="reference-reach"]')
      ?.getAttribute('pointer-events'),
  ).toBe('none');
  expect(container.querySelectorAll('[data-planar-geometry]')).toHaveLength(2);
  expect(probe.source).toBeNull();
});

it('keeps record geometry available when public references fail closed', () => {
  render(
    <SpatialWorkspaceMap
      {...props}
      publicReferences={null}
      publicReferenceState="invalid"
    />,
  );
  expect(screen.getByRole('status').textContent).toContain(
    copy.publicReferenceUnavailable,
  );
  expect(probe.source).toEqual(features);
  expect((probe.publicReferences as PublicReferences).features).toHaveLength(0);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('wheel qualification after external stop', () => {
  const stopReasons = ['load', 'external camera', 'hide and show'] as const;
  const sources = ['wheel', 'sourceless'] as const;
  const external = { ...camera, longitude: 117.4, latitude: 40.5, zoom: 6 };
  const delayed = { ...external, zoom: 6.25 };
  const wheel = () =>
    fireEvent.wheel(screen.getByTestId('native-map'), { deltaY: 180 });
  function stopAfterPendingWheel(reason: (typeof stopReasons)[number]) {
    const result = render(<SpatialWorkspaceMap {...props} />);
    if (reason !== 'load') act(() => (probe.props.onLoad as () => void)());
    wheel();
    // Simulate the classification delay: this wheel has not started zooming
    // when the external stop happens, but its timer may start it afterwards.
    expect(probe.zooming()).toBe(false);
    probe.stop.mockClear();
    if (reason === 'load') act(() => (probe.props.onLoad as () => void)());
    else if (reason === 'external camera')
      result.rerender(<SpatialWorkspaceMap {...props} camera={external} />);
    else {
      result.rerender(<SpatialWorkspaceMap {...props} active={false} />);
      result.rerender(<SpatialWorkspaceMap {...props} />);
    }
    expect(probe.stop).toHaveBeenCalled();
    return result;
  }
  function move(source: (typeof sources)[number], target = probe.native) {
    act(() =>
      (probe.props.onMove as (event: unknown) => void)({
        target,
        viewState: delayed,
        ...(source === 'wheel'
          ? { originalEvent: new WheelEvent('wheel', { deltaY: 180 }) }
          : {}),
      }),
    );
  }

  it.each(
    stopReasons.flatMap((reason) =>
      sources.map((source) => [reason, source] as const),
    ),
  )(
    'rejects an old %s classification frame with %s provenance after stopping',
    (reason, source) => {
      stopAfterPendingWheel(reason);
      probe.zooming.mockReturnValue(true);
      move(source);
      expect(props.onCamera).not.toHaveBeenCalled();
    },
  );

  it.each(
    stopReasons.flatMap((reason) =>
      sources.map((source) => [reason, source] as const),
    ),
  )(
    'accepts a new DOM wheel after %s stop with %s provenance',
    (reason, source) => {
      stopAfterPendingWheel(reason);
      wheel();
      probe.zooming.mockReturnValue(true);
      move(source);
      expect(props.onCamera).toHaveBeenCalledExactlyOnceWith(delayed);
    },
  );

  it.each(
    ['wrong target', 'inactive', 'ended'].flatMap((guard) =>
      sources.map((source) => [guard, source] as const),
    ),
  )('retains the %s guard for a qualified %s frame', (guard, source) => {
    const { rerender } = stopAfterPendingWheel('load');
    wheel();
    if (guard === 'inactive')
      rerender(<SpatialWorkspaceMap {...props} active={false} />);
    probe.zooming.mockReturnValue(guard !== 'ended');
    move(source, guard === 'wrong target' ? {} : probe.native);
    expect(props.onCamera).not.toHaveBeenCalled();
  });

  it.each(['mouse', 'keyboard'] as const)(
    'keeps %s navigation available without wheel qualification',
    (source) => {
      stopAfterPendingWheel('load');
      act(() =>
        (probe.props.onMove as (event: unknown) => void)({
          target: probe.native,
          viewState: delayed,
          originalEvent:
            source === 'mouse'
              ? new MouseEvent('mousemove')
              : new KeyboardEvent('keydown', { key: '+' }),
        }),
      );
      expect(props.onCamera).toHaveBeenCalledExactlyOnceWith(delayed);
    },
  );

  it('reapplies the controlled camera on move end without writing the rejected end proposal', () => {
    stopAfterPendingWheel('external camera');
    act(() =>
      (probe.props.onMoveEnd as (event: unknown) => void)({
        target: probe.native,
        viewState: delayed,
      }),
    );
    expect(props.onCamera).not.toHaveBeenCalled();
    expect(probe.props.longitude).toBe(external.longitude);
    expect(probe.props.latitude).toBe(external.latitude);
    expect(probe.props.zoom).toBe(external.zoom);
  });
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

it('accepts a sourceless scroll frame only from the currently zooming native map', () => {
  render(<SpatialWorkspaceMap {...props} />);
  const move = probe.props.onMove as (event: unknown) => void;
  const next = { ...camera, zoom: camera.zoom - 0.25 };
  probe.zooming.mockReturnValue(true);
  act(() => move({ viewState: next, target: {} }));
  expect(props.onCamera).not.toHaveBeenCalled();
  act(() => move({ viewState: next, target: probe.native }));
  expect(props.onCamera).toHaveBeenCalledExactlyOnceWith(next);
});

it('rejects sourceless frames when native scrolling ends or the map is inactive', () => {
  const { rerender } = render(<SpatialWorkspaceMap {...props} />);
  const next = { ...camera, zoom: camera.zoom - 0.25 };
  act(() =>
    (probe.props.onMove as (event: unknown) => void)({
      viewState: next,
      target: probe.native,
    }),
  );
  expect(props.onCamera).not.toHaveBeenCalled();
  rerender(<SpatialWorkspaceMap {...props} active={false} />);
  probe.zooming.mockReturnValue(true);
  act(() =>
    (probe.props.onMove as (event: unknown) => void)({
      viewState: next,
      target: probe.native,
    }),
  );
  expect(props.onCamera).not.toHaveBeenCalled();
});

it('rejects a late wheel-source frame after native scrolling stopped', () => {
  render(<SpatialWorkspaceMap {...props} />);
  const move = probe.props.onMove as (event: unknown) => void;
  const next = { ...camera, zoom: camera.zoom - 0.25 };
  const originalEvent = new WheelEvent('wheel', { deltaY: 2 });
  act(() => move({ viewState: next, target: probe.native, originalEvent }));
  expect(props.onCamera).not.toHaveBeenCalled();
  probe.zooming.mockReturnValue(true);
  act(() => move({ viewState: next, target: probe.native, originalEvent }));
  expect(props.onCamera).toHaveBeenCalledExactlyOnceWith(next);
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

it('explains only displayed location roles and removes withdrawn roles from the legend', () => {
  const { rerender } = render(<SpatialWorkspaceMap {...props} />);
  const legend = screen.getByRole('group', { name: '地图图例' });
  expect(within(legend).getByText(copy.positionRoles.reference)).toBeTruthy();
  expect(
    within(legend).getByText(copy.positionRoles['applicable-area']),
  ).toBeTruthy();
  expect(within(legend).queryByText(copy.positionRoles.sampling)).toBeNull();
  rerender(
    <SpatialWorkspaceMap
      {...props}
      features={{ ...features, features: [features.features[0]] }}
    />,
  );
  expect(within(legend).queryByText(copy.positionRoles.reference)).toBeNull();
});

it('keeps reference meaning visible in selected planar geometry instead of presenting it as a sampling position', () => {
  const { container } = render(
    <SpatialWorkspaceMap
      {...props}
      webGLAvailable={false}
      selection={{ recordId: 'r2', positionId: 'p2' }}
    />,
  );
  const selected = screen.getByRole('region', { name: '当前地图位置' });
  expect(within(selected).getByText(copy.positionRoles.reference)).toBeTruthy();
  expect(within(selected).getByText(copy.referenceLocation)).toBeTruthy();
  expect(
    container
      .querySelector('[data-planar-geometry="original-line"] path')
      ?.getAttribute('stroke-dasharray'),
  ).toBe('6 4');
});

it('offers readable overlapping sources and positions while retaining exact references on demand', () => {
  const enriched: WorkspaceMapFeatures = {
    ...features,
    features: features.features.map((feature, index) => ({
      ...feature,
      properties: {
        ...feature.properties,
        sourceTitle: `月报来源${index + 1}`,
        positionExpression: `原文位置${index + 1}`,
        scaleNote: '仅作范围参考',
      },
    })),
  };
  render(<SpatialWorkspaceMap {...props} features={enriched} />);
  act(() =>
    (probe.props.onClick as (event: unknown) => void)({
      point: { x: 100, y: 100 },
      features: enriched.features,
    }),
  );
  const picker = screen.getByRole('group', { name: copy.overlapPick });
  const choice = within(picker).getByRole('button', {
    name: /原线.*月报来源2.*原文位置2/,
  });
  const references = picker.querySelectorAll('details');
  expect(references).toHaveLength(2);
  expect(Array.from(references).every((element) => !element.open)).toBe(true);
  expect(choice.textContent).not.toContain('v1');
  fireEvent.click(choice);
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

it.each([true, false])(
  'keeps actual reference attribution visible on the %s WebGL surface while licensing details are closed',
  (webGLAvailable) => {
    render(
      <SpatialWorkspaceMap
        {...props}
        webGLAvailable={webGLAvailable}
        publicReferences={publicReferences}
      />,
    );
    const canvas = screen.getByTestId('spatial-geographic-map');
    const attribution = within(canvas).getByRole('link', {
      name: '© OpenStreetMap contributors · ODbL 1.0',
    });
    expect(attribution.getAttribute('href')).toBe(
      'https://www.openstreetmap.org/copyright',
    );
    expect(
      within(canvas).getAllByRole('link', {
        name: '© OpenStreetMap contributors · ODbL 1.0',
      }),
    ).toHaveLength(1);
    expect(
      screen.getByText(copy.publicReferenceEvidence).closest('details')?.open,
    ).toBe(false);
    for (const label of Object.values(copy.publicReferenceKinds))
      fireEvent.click(screen.getByLabelText(label));
    expect(
      within(canvas).queryByRole('link', {
        name: '© OpenStreetMap contributors · ODbL 1.0',
      }),
    ).toBeNull();
    expect(webGLAvailable ? probe.source : null).toEqual(
      webGLAvailable ? features : null,
    );
  },
);

it('does not attribute absent reference geometry or turn camera controls into an unsupported toolbar', () => {
  render(<SpatialWorkspaceMap {...props} publicReferences={null} />);
  expect(
    within(screen.getByTestId('spatial-geographic-map')).queryByRole('link'),
  ).toBeNull();
  const groups = screen.getAllByRole('group', { name: copy.mapTitle });
  expect(groups).toHaveLength(2);
  expect(
    within(groups[0]).getByRole('button', { name: copy.zoomIn }),
  ).toBeTruthy();
  expect(
    within(groups[1]).getByRole('button', { name: copy.panWest }),
  ).toBeTruthy();
  expect(screen.queryByRole('toolbar', { name: copy.mapTitle })).toBeNull();
});

it.each(['zh-CN', 'en'] as const)(
  'keeps %s manifest counts separate from records and draws hollow noninteractive reference anchors offline',
  (locale) => {
    const dictionary = getDictionary(locale).dataFoundation.spatialWorkspace;
    const anchor: PublicReferences['features'][number] = {
      type: 'Feature',
      id: 'reference-anchor:123',
      geometry: { type: 'Point', coordinates: [116.5, 39.5] },
      properties: {
        ...publicReferences.features[0].properties,
        kind: 'reference-anchor',
        label: '原生汇口参考',
        referenceFileId: 'reference-file',
        sourceUrl: 'https://www.openstreetmap.org/node/123',
      },
    };
    const references: PublicReferences = {
      ...publicReferences,
      features: [...publicReferences.features, anchor],
      manifest: {
        version: '2026-10-05.1',
        files: [
          {
            id: 'reference-file',
            sha256: 'a'.repeat(64),
            featureCount: 4,
            format: 'osm-native-anchors-v1',
            originalSha256: ['b'.repeat(64)],
            scope: 'public-geographic-reference',
            license: {
              id: 'ODbL-1.0',
              url: 'https://www.openstreetmap.org/copyright',
              attribution: '© OpenStreetMap contributors · ODbL 1.0',
              state: 'verified',
            },
            limitation: {
              'zh-CN': '原生参考；不能当作采样点。',
              en: 'Native reference; not a sampling point.',
            },
          },
        ],
      },
    };
    const { container } = render(
      <SpatialWorkspaceMap
        {...props}
        copy={dictionary}
        webGLAvailable={false}
        publicReferences={references}
        publicReferenceState="ready"
      />,
    );
    expect(
      container
        .querySelector('[data-public-reference-kind="reference-anchor"] path')
        ?.getAttribute('fill'),
    ).toBe('none');
    expect(
      container.querySelectorAll('[data-public-reference-kind]'),
    ).toHaveLength(4);
    const label =
      locale === 'zh-CN'
        ? '汇口与设施参考锚点'
        : 'Confluence and facility reference anchors';
    expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByText(/2026-10-05.1/)).toBeTruthy();
    const counts =
      locale === 'zh-CN'
        ? /固定文件要素：4.*当前显示参考要素：4/
        : /Fixed file features: 4.*Displayed reference features: 4/;
    expect(screen.getByText(counts)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(label));
    expect(
      container.querySelectorAll('[data-public-reference-kind]'),
    ).toHaveLength(3);
    expect(props.onSelect).not.toHaveBeenCalled();
  },
);
