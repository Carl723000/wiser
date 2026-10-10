// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getDictionary } from '@/lib/i18n';
import { SpatialWorkspaceMap } from './spatial-workspace-map';

const probe = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  jump: vi.fn(),
  stop: vi.fn(),
  removeLayer: vi.fn(),
  unmounted: vi.fn(),
}));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  MercatorCoordinate: { fromLngLat: () => ({ x: 0, y: 0, z: 0 }) },
}));
vi.mock('react-map-gl/maplibre', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react');
  const native = {
    stop: probe.stop,
    jumpTo: probe.jump,
    addLayer: vi.fn(),
    getLayer: () => true,
    removeLayer: probe.removeLayer,
    triggerRepaint: vi.fn(),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 460 }),
    scrollZoom: { isZooming: () => false },
  };
  return {
    default: forwardRef<
      unknown,
      Record<string, unknown> & { children?: ReactNode }
    >((props, ref) => {
      probe.props = props;
      useImperativeHandle(ref, () => ({ getMap: () => native }));
      useEffect(
        () => () => {
          probe.unmounted();
        },
        [],
      );
      return <div>{props.children as ReactNode}</div>;
    }),
    Source: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Layer: () => null,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('keeps the passive geographic viewport controlled while suppressing all input, links and duplicate controls', () => {
  const onCamera = vi.fn(),
    onCoordinate = vi.fn(),
    onBounds = vi.fn();
  const camera = {
    longitude: 116,
    latitude: 40,
    zoom: 12,
    bearing: 15,
    pitch: 50,
  };
  const props = {
    features: { type: 'FeatureCollection' as const, features: [] },
    camera,
    mode: '3d' as const,
    selection: null,
    copy: getDictionary('en').dataFoundation.spatialWorkspace,
    onCamera,
    onCoordinate,
    onBounds,
    onSelect: vi.fn(),
    webGLAvailable: true,
    active: true,
    passive: true,
    surfaceOnly: true,
  };
  const view = render(<SpatialWorkspaceMap {...props} />);
  expect(view.container.querySelectorAll('button, input, a')).toHaveLength(0);
  for (const key of [
    'dragRotate',
    'pitchWithRotate',
    'keyboard',
    'scrollZoom',
    'doubleClickZoom',
    'dragPan',
    'touchZoomRotate',
    'touchPitch',
  ])
    expect(probe.props[key]).toBe(false);
  act(() => (probe.props.onLoad as () => void)());
  const next = {
    ...camera,
    longitude: 115.8,
    latitude: 40.2,
    bearing: 40,
    zoom: 14,
    pitch: 60,
  };
  view.rerender(<SpatialWorkspaceMap {...props} camera={next} />);
  expect(probe.jump).toHaveBeenLastCalledWith(next);
  act(() => {
    (probe.props.onMove as (event: unknown) => void)({
      viewState: { ...next, zoom: 16 },
      originalEvent: { type: 'mousemove' },
    });
    (probe.props.onClick as (event: unknown) => void)({
      lngLat: { lng: 115.8, lat: 40.2 },
    });
  });
  expect(onCamera).not.toHaveBeenCalled();
  expect(onCoordinate).not.toHaveBeenCalled();
  expect(onBounds).not.toHaveBeenCalled();
  expect(
    view.container
      .querySelector('[data-passive-surface]')
      ?.hasAttribute('inert'),
  ).toBe(true);
  view.unmount();
  expect(probe.removeLayer).toHaveBeenCalledTimes(1);
  expect(probe.unmounted).toHaveBeenCalledTimes(1);
});
