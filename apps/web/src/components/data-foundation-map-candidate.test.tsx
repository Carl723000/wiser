// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataFoundationMap } from './data-foundation-map';
import { getDictionary } from '@/lib/i18n';

const probe = vi.hoisted(() => ({
  style: null as Record<string, unknown> | null,
  query: vi.fn(),
  events: new Map<string, (value: unknown) => void>(),
}));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  NavigationControl: class {},
  Map: class {
    constructor(input: { style: Record<string, unknown> }) {
      probe.style = input.style;
    }
    touchZoomRotate = { disableRotation: vi.fn() };
    queryRenderedFeatures = probe.query;
    on(event: string, action: (value: unknown) => void) {
      probe.events.set(event, action);
    }
    once() {}
    off() {}
    getLayer() {
      return undefined;
    }
    addControl() {}
    remove() {}
  },
}));
vi.mock('./amap-basemap', () => ({ AmapBasemap: () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  probe.events.clear();
  probe.style = null;
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
