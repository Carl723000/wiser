// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  fireEvent,
  screen,
} from '@testing-library/react';
import { useImperativeHandle, type Ref } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataFoundationMap } from './data-foundation-map';
import { mapDisplayBounds } from '@/lib/data-foundation-map-bounds';
import { getDictionary } from '@/lib/i18n';

const probe = vi.hoisted(() => ({
  style: null as Record<string, unknown> | null,
  query: vi.fn(),
  jump: vi.fn(),
  fit: vi.fn(),
  onlineSync: vi.fn(),
  center: { lng: 116, lat: 40 },
  zoom: 8,
  loads: [] as Array<() => void>,
  options: {} as Record<string, unknown>,
  pitch: 0,
  bearing: 0,
  filter: vi.fn(),
  events: new Map<string, (value: unknown) => void>(),
}));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  NavigationControl: class {},
  Map: class {
    constructor(input: { style: Record<string, unknown> }) {
      probe.style = input.style;
      probe.options = input;
      probe.bearing = Number((input as Record<string, unknown>).bearing ?? 0);
      probe.pitch = Number((input as Record<string, unknown>).pitch ?? 0);
    }
    jumpTo(value: { pitch: number; bearing?: number }) {
      probe.pitch = value.pitch;
      if (value.bearing !== undefined) probe.bearing = value.bearing;
      probe.jump(value);
      probe.events.get('moveend')?.({});
    }
    getCenter() {
      return probe.center;
    }
    getZoom() {
      return probe.zoom;
    }
    getPitch() {
      return probe.pitch;
    }
    getBearing() {
      return probe.bearing;
    }
    touchZoomRotate = { disableRotation: vi.fn() };
    queryRenderedFeatures = probe.query;
    on(event: string, action: (value: unknown) => void) {
      probe.events.set(event, action);
    }
    once(event: string, callback: () => void) {
      if (event === 'load') probe.loads.push(callback);
    }
    fitBounds = probe.fit;
    off() {}
    getLayer(id: string) {
      return id.startsWith('reader-selected-') ? { id } : undefined;
    }
    setFilter = probe.filter;
    setLayoutProperty() {}
    addControl() {}
    remove() {}
  },
}));
vi.mock('./amap-basemap', () => ({
  AmapBasemap: ({
    ref,
  }: {
    ref: Ref<{ syncCamera: typeof probe.onlineSync }>;
  }) => {
    useImperativeHandle(ref, () => ({ syncCamera: probe.onlineSync }), []);
    return <div data-testid="online-enhancement" />;
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  probe.events.clear();
  probe.loads = [];
  probe.style = null;
  probe.center = { lng: 116, lat: 40 };
  probe.zoom = 8;
});
const recordId = '10000000-0000-4000-8000-000000000004';
const candidate = {
  type: 'FeatureCollection' as const,
  features: [
    {
      type: 'Feature' as const,
      id: recordId,
      geometry: { type: 'Point' as const, coordinates: [116, 40, 9] },
      properties: {
        recordId,
        assetId: '10000000-0000-4000-8000-000000000003',
        sourceId: 'row:1',
      },
    },
  ],
};
it('renders a private candidate display collection without creating published version or authoritative location identities', () => {
  render(
    <DataFoundationMap
      locale="en"
      ariaLabel="Candidate geometry"
      displayCrs="EPSG:4326"
      features={candidate}
      stacExtents={[]}
      labels={getDictionary('en').dataFoundation.mapPage}
    />,
  );
  expect(probe.style).toMatchObject({
    sources: {
      authority: {
        data: { features: [{ properties: candidate.features[0]?.properties }] },
      },
    },
  });
  expect(JSON.stringify(probe.style)).not.toMatch(
    /versionId|dataItemId|sampling/,
  );
  expect(candidate.features[0]?.geometry.coordinates).toEqual([116, 40, 9]);
});
it('selects only a rendered record belonging to the current collection and ignores a foreign callback identity', () => {
  const selected = vi.fn();
  render(
    <DataFoundationMap
      locale="en"
      ariaLabel="Candidate geometry"
      displayCrs="EPSG:4326"
      features={candidate}
      stacExtents={[]}
      labels={getDictionary('en').dataFoundation.mapPage}
      onSelectRecord={selected}
    />,
  );
  probe.query.mockReturnValue([{ properties: { recordId } }]);
  act(() => probe.events.get('click')?.({ point: { x: 1, y: 2 } }));
  expect(selected).toHaveBeenCalledWith(recordId);
  probe.query.mockReturnValue([
    { properties: { recordId: '10000000-0000-4000-8000-000000000005' } },
  ]);
  act(() => probe.events.get('click')?.({ point: { x: 1, y: 2 } }));
  expect(selected).toHaveBeenCalledTimes(1);
});

it('uses the current reading callback when it is added or removed without recreating the map', () => {
  const props = {
    locale: 'en' as const,
    ariaLabel: 'Candidate geometry',
    displayCrs: 'EPSG:4326' as const,
    features: candidate,
    stacExtents: [],
    labels: getDictionary('en').dataFoundation.mapPage,
  };
  const { rerender } = render(<DataFoundationMap {...props} />);
  const selected = vi.fn();
  rerender(<DataFoundationMap {...props} onSelectRecord={selected} />);
  probe.query.mockReturnValue([{ properties: { recordId } }]);
  act(() => probe.events.get('click')?.({ point: { x: 1, y: 2 } }));
  expect(selected).toHaveBeenCalledWith(recordId);
  rerender(<DataFoundationMap {...props} />);
  act(() => probe.events.get('click')?.({ point: { x: 1, y: 2 } }));
  expect(selected).toHaveBeenCalledTimes(1);
});

it('highlights only a current record and clears that drawing selection without modifying original geometry', () => {
  const props = {
    locale: 'en' as const,
    ariaLabel: 'Candidate geometry',
    displayCrs: 'EPSG:4326' as const,
    features: candidate,
    stacExtents: [],
    labels: getDictionary('en').dataFoundation.mapPage,
  };
  const { rerender } = render(
    <DataFoundationMap {...props} selectedRecordId={recordId} />,
  );
  expect(probe.filter.mock.calls).toEqual(
    expect.arrayContaining([
      [
        'reader-selected-point',
        expect.arrayContaining([expect.arrayContaining([recordId])]),
      ],
    ]),
  );
  expect(candidate.features[0]?.geometry.coordinates).toEqual([116, 40, 9]);
  probe.filter.mockClear();
  rerender(
    <DataFoundationMap
      {...props}
      selectedRecordId="10000000-0000-4000-8000-000000000005"
    />,
  );
  expect(probe.filter).toHaveBeenCalledWith('reader-selected-point', [
    'literal',
    false,
  ]);
  probe.filter.mockClear();
  rerender(<DataFoundationMap {...props} selectedRecordId={null} />);
  expect(probe.filter).toHaveBeenCalledWith('reader-selected-point', [
    'literal',
    false,
  ]);
});

it('keeps public reference sources below business layers and outside record hit queries', () => {
  const selected = vi.fn();
  const reference = {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        id: 'reference-point',
        geometry: { type: 'Point' as const, coordinates: [115, 39] },
        properties: {
          kind: 'reference-anchor' as const,
          label: 'Reference',
          fixedSourceId: 'openstreetmap',
          sourceFileSha256: 'a'.repeat(64),
          originalSha256: ['b'.repeat(64)],
          attribution: '© OpenStreetMap contributors · ODbL 1.0',
          licenseUrl: 'https://www.openstreetmap.org/copyright',
          sourceUrl: 'https://www.openstreetmap.org/node/1',
          limitation: 'Reference only',
          scope: 'public-geographic-reference' as const,
          crs: 'EPSG:4326' as const,
        },
      },
    ],
  };
  const { rerender } = render(
    <DataFoundationMap
      locale="en"
      ariaLabel="Candidate"
      displayCrs="EPSG:4326"
      features={candidate}
      labels={getDictionary('en').dataFoundation.mapPage}
      stacExtents={[]}
      publicReferences={reference}
      onSelectRecord={selected}
    />,
  );
  expect(probe.style?.sources).toHaveProperty('public-reference');
  act(() => probe.loads.forEach((load) => load()));
  expect(probe.fit).toHaveBeenCalledWith(
    mapDisplayBounds(
      [candidate.features[0].geometry.coordinates],
      [],
      'EPSG:4326',
    ),
    { padding: 52, maxZoom: 11, duration: 0 },
  );
  const layers = probe.style?.layers as Array<{ id: string }>;
  expect(
    layers.findIndex((layer) => layer.id === 'public-reference-anchor'),
  ).toBeLessThan(layers.findIndex((layer) => layer.id === 'authority-points'));
  probe.query.mockReturnValue([
    { properties: { referenceId: 'reference-point' } },
  ]);
  act(() => probe.events.get('click')?.({ point: { x: 1, y: 2 } }));
  expect(selected).not.toHaveBeenCalled();
  expect(probe.query).toHaveBeenCalledWith(expect.anything(), {
    layers: ['authority-polygons', 'authority-lines', 'authority-points'],
  });
  expect(
    screen.getByText('© OpenStreetMap contributors · ODbL 1.0'),
  ).toBeTruthy();
  rerender(
    <DataFoundationMap
      locale="en"
      ariaLabel="Candidate"
      displayCrs="EPSG:4326"
      features={{ type: 'FeatureCollection', features: [] }}
      labels={getDictionary('en').dataFoundation.mapPage}
      stacExtents={[]}
      publicReferences={reference}
      onSelectRecord={selected}
    />,
  );
  expect(probe.style).toMatchObject({
    sources: { authority: { data: { features: [] } } },
  });
  probe.query.mockReturnValue([{ properties: { recordId } }]);
  act(() => probe.events.get('click')?.({ point: { x: 1, y: 2 } }));
  expect(selected).not.toHaveBeenCalled();
});
it('changes only the same map camera when switching bird-eye and planar views', () => {
  const report = vi.fn();
  render(
    <DataFoundationMap
      locale="en"
      ariaLabel="Candidate"
      displayCrs="EPSG:4326"
      features={candidate}
      labels={getDictionary('en').dataFoundation.mapPage}
      stacExtents={[]}
      onReadingCamera={report}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to bird’s-eye view' }),
  );
  expect(probe.jump).toHaveBeenLastCalledWith({ pitch: 50 });
  expect(screen.queryByTestId('online-enhancement')).toBeNull();
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ pitch: 50, bearing: 0, zoom: 8 }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to planar view' }),
  );
  expect(probe.jump).toHaveBeenLastCalledWith({ pitch: 0 });
  expect(screen.getByTestId('online-enhancement')).toBeTruthy();
});

it('keeps a rotated planar camera planar and retains its bearing across pitch switches without the online enhancement', () => {
  const report = vi.fn();
  render(
    <DataFoundationMap
      locale="en"
      ariaLabel="Candidate"
      displayCrs="EPSG:4326"
      features={candidate}
      labels={getDictionary('en').dataFoundation.mapPage}
      stacExtents={[]}
      initialReadingCamera={{
        longitude: 116,
        latitude: 40,
        zoom: 8,
        bearing: 40,
        pitch: 0,
      }}
      onReadingCamera={report}
    />,
  );
  expect(
    screen
      .getByRole('button', { name: 'Switch to planar view' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.queryByTestId('online-enhancement')).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to bird’s-eye view' }),
  );
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ bearing: 40, pitch: 50 }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to planar view' }),
  );
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ bearing: 40, pitch: 0 }),
  );
  expect(screen.queryByTestId('online-enhancement')).toBeNull();
});

it('suspends the planar enhancement synchronously during native camera motion before moveend and realigns the returning frame', () => {
  render(
    <DataFoundationMap
      locale="en"
      ariaLabel="Candidate"
      displayCrs="EPSG:4326"
      features={candidate}
      labels={getDictionary('en').dataFoundation.mapPage}
      stacExtents={[]}
    />,
  );
  expect(screen.getByTestId('online-enhancement')).toBeTruthy();
  probe.bearing = 5;
  act(() => probe.events.get('move')?.({}));
  expect(screen.queryByTestId('online-enhancement')).toBeNull();
  expect(
    screen
      .getByRole('button', { name: 'Switch to planar view' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  probe.pitch = 10;
  act(() => probe.events.get('move')?.({}));
  expect(
    screen
      .getByRole('button', { name: 'Switch to bird’s-eye view' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  probe.bearing = 0;
  probe.pitch = 0;
  probe.center = { lng: 117.5, lat: 41 };
  probe.zoom = 10;
  act(() => probe.events.get('move')?.({}));
  expect(screen.getByTestId('online-enhancement')).toBeTruthy();
  expect(probe.onlineSync).toHaveBeenLastCalledWith({
    longitude: 117.5,
    latitude: 41,
    zoom: 10,
    bearing: 0,
    pitch: 0,
  });
  const container = screen.getByTestId('online-map-enhancement');
  let hiddenBeforeReactCommit = false;
  act(() => {
    probe.events.get('pitchstart')?.({});
    hiddenBeforeReactCommit = container.hidden === true;
  });
  expect(hiddenBeforeReactCommit).toBe(true);
  expect(screen.queryByTestId('online-enhancement')).toBeNull();
  probe.pitch = 0;
  act(() => probe.events.get('move')?.({}));
  expect(container.hidden).toBe(false);
  act(() => {
    probe.events.get('rotatestart')?.({});
    expect(container.hidden).toBe(true);
  });
  expect(screen.queryByTestId('online-enhancement')).toBeNull();
});
