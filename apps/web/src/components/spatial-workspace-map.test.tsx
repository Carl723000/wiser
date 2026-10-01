// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { CustomLayerInterface } from 'maplibre-gl';
import type { WorkspaceMapFeatures } from '@/lib/spatial-workspace-view';
import { getDictionary } from '@/lib/i18n';
import { SpatialWorkspaceMap } from './spatial-workspace-map';

const probe = vi.hoisted(() => ({ props: {} as Record<string, unknown>, source: null as unknown, custom: null as CustomLayerInterface | null, query: vi.fn(() => []) }));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  MercatorCoordinate: { fromLngLat: ([lng, lat]: number[], height = 0) => ({ x: lng / 180, y: lat / 90, z: height / 10000 }) },
}));
vi.mock('react-map-gl/maplibre', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef<unknown, Record<string, unknown> & { children?: ReactNode }>((props, ref) => {
      probe.props = props;
      useImperativeHandle(ref, () => ({ getMap: () => ({ addLayer: (layer: CustomLayerInterface) => { probe.custom = layer; }, getLayer: () => null, removeLayer: vi.fn(), triggerRepaint: vi.fn(), getCanvas: () => ({ clientWidth: 800, clientHeight: 460 }), project: ([lng, lat]: number[]) => ({ x: (lng / 180 + 1) * 400, y: (1 - lat / 90) * 230 }) }), queryRenderedFeatures: probe.query, unproject: ({ x, y }: { x: number; y: number }) => ({ lng: x, lat: y }) }));
      return <div data-testid="native-map">{props.children}</div>;
    }),
    Source: (props: { children?: ReactNode; data: unknown; id: string }) => { if (props.id === 'workspace-records') probe.source = props.data; return <div>{props.children}</div>; },
    Layer: () => null,
  };
});
const features: WorkspaceMapFeatures = { type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'original-polygon', geometry: { type: 'Polygon', coordinates: [[[116, 39], [117, 39], [117, 40], [116, 39]]] }, properties: { sourceId: 'source', versionId: 'v1', recordId: 'r1', positionId: 'p1', label: '原面', kind: 'policy', role: 'applicable-area' } },
  { type: 'Feature', id: 'original-line', geometry: { type: 'LineString', coordinates: [[116, 39], [117, 40]] }, properties: { sourceId: 'source', versionId: 'v1', recordId: 'r2', positionId: 'p2', label: '原线', kind: 'observation', role: 'reference' } },
] };
const copy = getDictionary('zh-CN').dataFoundation.spatialWorkspace;
const camera = { longitude: 116.5, latitude: 39.5, zoom: 7, pitch: 50, bearing: 35 };
const props = { features, camera, mode: '3d' as const, selection: null, copy, onCamera: vi.fn(), onSelect: vi.fn(), webGLAvailable: true };
beforeEach(() => { probe.custom = null; probe.query.mockClear(); vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; }); vi.stubGlobal('cancelAnimationFrame', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('passes original geometry and the common geographic pitch/bearing to MapLibre', () => {
  render(<SpatialWorkspaceMap {...props} />);
  expect(probe.source).toEqual(features);
  expect(probe.props.pitch).toBe(50);
  expect(probe.props.bearing).toBe(35);
  expect(probe.props.dragRotate).toBe(true);
  expect(probe.props.mapStyle).not.toHaveProperty('glyphs');
  expect(JSON.stringify(probe.props.mapStyle)).not.toMatch(/https?:/);
});

it('uses the public MapLibre 3D projection matrix for evidenced category stems', () => {
  const { container } = render(<SpatialWorkspaceMap {...props} />);
  act(() => (probe.props.onLoad as () => void)());
  expect(probe.custom?.renderingMode).toBe('3d');
  act(() => probe.custom?.render({} as WebGL2RenderingContext, { defaultProjectionData: { mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } } as Parameters<CustomLayerInterface['render']>[1]));
  const anchor = container.querySelector('[data-ground-anchor-error]');
  expect(anchor).toBeTruthy();
  expect(Number(anchor!.getAttribute('data-ground-anchor-error'))).toBeLessThan(0.01);
  expect(container.innerHTML).not.toMatch(/perspective\(|rotateX\(|rotateY\(/);
  expect(screen.getByText(copy.categoryHeightHint)).toBeTruthy();
});

it('exposes both exact source-position hits rather than guessing one from its name', () => {
  render(<SpatialWorkspaceMap {...props} />);
  act(() => (probe.props.onClick as (event: unknown) => void)({ point: { x: 100, y: 100 }, features: features.features }));
  expect(props.onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /原线/ }));
  expect(props.onSelect).toHaveBeenLastCalledWith({ recordId: 'r2', positionId: 'p2' });
});

it('retains an actual selectable planar geometry view without WebGL', () => {
  const { container } = render(<SpatialWorkspaceMap {...props} webGLAvailable={false} />);
  expect(screen.queryByTestId('native-map')).toBeNull();
  expect(screen.getByText(copy.noWebgl)).toBeTruthy();
  expect(container.querySelector('[data-planar-geometry="original-polygon"] path')).toBeTruthy();
  const geometry = screen.getByRole('button', { name: /原面/ });
  fireEvent.keyDown(geometry, { key: 'Enter' });
  expect(props.onSelect).toHaveBeenLastCalledWith({ recordId: 'r1', positionId: 'p1' });
});

it('unloads a failed canvas and leaves the record positions selectable for retry', () => {
  render(<SpatialWorkspaceMap {...props} />);
  act(() => (probe.props.onError as () => void)());
  expect(screen.queryByTestId('native-map')).toBeNull();
  expect(screen.getByText(copy.renderFailed)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /原线/ }));
  expect(props.onSelect).toHaveBeenLastCalledWith({ recordId: 'r2', positionId: 'p2' });
  fireEvent.click(screen.getByRole('button', { name: copy.retryMap }));
  expect(screen.getByTestId('native-map')).toBeTruthy();
});
