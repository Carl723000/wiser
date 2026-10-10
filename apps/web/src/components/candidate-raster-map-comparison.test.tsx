// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CandidateRasterWindowResult } from '@/lib/candidate-raster-window';
import type { SpatialWorkspaceMapProps } from './spatial-workspace-map';
import { CandidateRasterMap } from './candidate-raster-map';

const probe = vi.hoisted(() => ({ maps: [] as SpatialWorkspaceMapProps[] }));
vi.mock('./spatial-workspace-map', () => ({
  SpatialWorkspaceMap: (props: SpatialWorkspaceMapProps) => {
    probe.maps.push(props);
    return (
      <div
        data-testid="geographic-surface"
        data-passive={String(props.passive)}
        data-camera={JSON.stringify(props.camera)}
      />
    );
  },
}));
const result: CandidateRasterWindowResult = {
  window: { row: 10, column: 20, rows: 2, columns: 3 },
  crs: 'EPSG:32650',
  affine: [20, 0, 385180, 0, -20, 4481920],
  sourceProduct: 'scene',
  sensingTime: '2026-08-24T03:05:19Z',
  quality: { kind: 'raw' },
  values: {
    B03: new Uint16Array(6),
    B8A: new Uint16Array(6),
    SCL: Uint8Array.of(2, 4, 6, 4, 4, 6),
    TCI: [
      Uint8Array.of(1, 2, 3, 4, 5, 6),
      Uint8Array.of(7, 8, 9, 10, 11, 12),
      Uint8Array.of(13, 14, 15, 16, 17, 18),
    ],
  },
  validMask: new Uint8Array(6).fill(255),
  qualityMask: new Uint8Array(6).fill(1),
};
const onWindow = vi.fn(),
  onInvalid = vi.fn();
function props() {
  return {
    locale: 'en' as const,
    window: result.window,
    result,
    disabled: false,
    onWindow,
    onInvalid,
  };
}
beforeEach(() => {
  probe.maps = [];
  onWindow.mockClear();
  onInvalid.mockClear();
});
afterEach(cleanup);

it('uses two full geographic surfaces with identical original cell geometry and a passive SCL surface', () => {
  render(<CandidateRasterMap {...props()} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Show swipe comparison' }),
  );
  const maps = probe.maps.slice(-2);
  expect(screen.getAllByTestId('geographic-surface')).toHaveLength(2);
  expect(maps[0].camera).toEqual(maps[1].camera);
  expect(maps[1].passive).toBe(true);
  expect(maps.every((m) => m.surfaceOnly)).toBe(true);
  const pixels = maps.map((m) =>
    m.inspectionGeometry!.features.filter((f) => f.properties.kind === 'pixel'),
  );
  expect(pixels[0].map((f) => f.geometry)).toEqual(
    pixels[1].map((f) => f.geometry),
  );
  expect(pixels[0][5].properties.color).toBe('rgb(6,12,18)');
  fireEvent.change(
    screen.getByRole('slider', { name: 'Swipe divider position' }),
    { target: { value: '0' } },
  );
  expect(
    screen.getByTestId('candidate-raster-swipe-upper').style.clipPath,
  ).toBe('inset(0 100% 0 0)');
  fireEvent.change(
    screen.getByRole('slider', { name: 'Swipe divider position' }),
    { target: { value: '100' } },
  );
  expect(
    screen.getByTestId('candidate-raster-swipe-upper').style.clipPath,
  ).toBe('inset(0 0% 0 0)');
  expect(onWindow).not.toHaveBeenCalled();
  expect(onInvalid).not.toHaveBeenCalled();
});

it('keeps independent full cameras, synchronizes on request and returns the same selection through bird and swipe', () => {
  render(<CandidateRasterMap {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show two maps' }));
  fireEvent.click(screen.getByRole('button', { name: 'Independent cameras' }));
  const left = probe.maps.at(-2)!.camera;
  const right = { ...left, longitude: 115.6, zoom: 13, bearing: 25, pitch: 45 };
  act(() => probe.maps.at(-1)!.onCamera(right));
  expect(probe.maps.at(-2)!.camera).toEqual(left);
  expect(probe.maps.at(-1)!.camera).toEqual(right);
  fireEvent.click(screen.getByRole('button', { name: 'Synchronized cameras' }));
  expect(probe.maps.at(-1)!.camera).toEqual(left);
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to bird’s-eye view' }),
  );
  expect(
    probe.maps.slice(-2).every((m) => m.mode === '3d' && m.camera.pitch === 50),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'View selected window' }));
  expect(probe.maps.at(-1)!.mode).toBe('3d');
  expect(probe.maps.at(-1)!.camera.pitch).toBe(50);
  fireEvent.click(
    screen.getByRole('button', { name: 'Show swipe comparison' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show single map' }));
  expect(screen.getAllByTestId('geographic-surface')).toHaveLength(1);
  expect(
    screen
      .getByTestId('candidate-raster-map-selection')
      .getAttribute('data-native-window'),
  ).toBe('10,20,2,3');
  expect(onWindow).not.toHaveBeenCalled();
});

it('removes classified content on current cancellation/authority clearing and ignores callbacks from the retired surface', () => {
  const view = render(<CandidateRasterMap {...props()} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Show swipe comparison' }),
  );
  const retired = probe.maps.at(-2)!;
  view.rerender(
    <CandidateRasterMap {...props()} result={null} window={null} disabled />,
  );
  expect(screen.queryByTestId('candidate-raster-swipe-upper')).toBeNull();
  expect(
    probe.maps
      .at(-1)!
      .inspectionGeometry!.features.filter(
        (f) => f.properties.kind === 'pixel',
      ),
  ).toHaveLength(0);
  act(() => {
    retired.onCamera({ ...retired.camera, zoom: 16 });
    retired.onCoordinate?.([115.6, 40.1]);
  });
  expect(onWindow).not.toHaveBeenCalled();
  expect(onInvalid).not.toHaveBeenCalled();
  view.unmount();
  act(() => retired.onCoordinate?.([115.6, 40.1]));
  expect(onInvalid).not.toHaveBeenCalled();
});

it('rejects an old geographic callback even after returning to the same display mode', () => {
  render(<CandidateRasterMap {...props()} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Show swipe comparison' }),
  );
  const retired = probe.maps.at(-2)!;
  fireEvent.click(screen.getByRole('button', { name: 'Show single map' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Show swipe comparison' }),
  );
  const before = probe.maps.at(-2)!.camera;
  act(() => {
    retired.onCamera({ ...before, zoom: 16 });
    retired.onCoordinate?.([115.6, 40.1]);
  });
  expect(probe.maps.at(-2)!.camera).toEqual(before);
  expect(onWindow).not.toHaveBeenCalled();
  expect(onInvalid).not.toHaveBeenCalled();
});

it('does not show a mixed geographic projection when one rendering surface falls back', () => {
  render(<CandidateRasterMap {...props()} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Show swipe comparison' }),
  );
  const maps = probe.maps.slice(-2);
  act(() => {
    maps[0].onSurfaceRenderer?.('maplibre');
    maps[1].onSurfaceRenderer?.('planar');
  });
  expect(
    screen.getByTestId('candidate-raster-swipe-upper').style.visibility,
  ).toBe('hidden');
  expect(
    screen
      .getByTestId('candidate-raster-geographic-swipe')
      .getAttribute('data-renderers-aligned'),
  ).toBe('false');
  act(() => maps[1].onSurfaceRenderer?.('maplibre'));
  expect(
    screen.getByTestId('candidate-raster-swipe-upper').style.visibility,
  ).toBe('visible');
});
