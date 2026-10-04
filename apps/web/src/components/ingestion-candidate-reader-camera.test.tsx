// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IngestionCandidateReader } from './ingestion-candidate-reader';
import { getDictionary } from '@/lib/i18n';
import { authorityCamera, displayCamera } from '@/lib/amap-camera';

// This exercises the actual Reader and map component. Only the WebGL engine and
// network replies are synthetic; it does not claim a real browser camera check.
const probe = vi.hoisted(() => ({
  instances: [] as Array<{
    removed: boolean;
    camera: { center: number[]; zoom: number };
    events: Map<string, (value: unknown) => void>;
    filter: ReturnType<typeof vi.fn>;
    fitted: boolean;
  }>,
  hits: [] as Array<{ properties: { recordId: string } }>,
}));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  NavigationControl: class {},
  Map: class {
    removed = false;
    camera = { center: [0, 0], zoom: 1 };
    events = new Map<string, (value: unknown) => void>();
    filter = vi.fn();
    fitted = false;
    constructor(options: { center: number[]; zoom: number }) {
      this.camera = { center: options.center, zoom: options.zoom };
      probe.instances.push(this);
    }
    touchZoomRotate = { disableRotation: vi.fn() };
    queryRenderedFeatures() {
      return probe.hits;
    }
    on(event: string, action: (value: unknown) => void) {
      const previous = this.events.get(event);
      this.events.set(event, (value) => {
        previous?.(value);
        action(value);
      });
    }
    once(event: string, action: (value: unknown) => void) {
      this.on(event, action);
    }
    off() {}
    loaded() {
      return false;
    }
    getCenter() {
      return { lng: this.camera.center[0], lat: this.camera.center[1] };
    }
    getZoom() {
      return this.camera.zoom;
    }
    fitBounds() {
      this.fitted = true;
      this.camera = { center: [116.5, 40], zoom: 7 };
    }
    getLayer(id: string) {
      return id.startsWith('reader-selected-') ? { id } : undefined;
    }
    setFilter(id: string, filter: unknown) {
      this.filter(id, filter);
    }
    setLayoutProperty() {}
    addControl() {}
    remove() {
      this.removed = true;
      this.events.get('remove')?.(undefined);
    }
  },
}));
vi.mock('./amap-basemap', () => ({ AmapBasemap: () => null }));

const ref = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const assetId = '10000000-0000-4000-8000-000000000003';
const recordId = '10000000-0000-4000-8000-000000000004';
const otherAssetId = '10000000-0000-4000-8000-000000000005';
const otherRecordId = '10000000-0000-4000-8000-000000000006';
const native = {
  type: 'LineString',
  coordinates: [
    [116, 40, 12],
    [117, 40, 13],
  ],
};
const copy = getDictionary('en').dataFoundation.candidateReader;
const fetch = vi.fn<typeof globalThis.fetch>();
let geometryReads = 0;
let nativeReply = native;
function requestUrl(value: RequestInfo | URL) {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.href
      : value.url;
}
function requestInput(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON input');
  const value: unknown = JSON.parse(init.body);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function fixtureReply(url: RequestInfo | URL, init?: RequestInit) {
  const input = requestInput(init);
  const reference = {
    ...ref,
    ingestionId: input.ingestionId,
    processingBatchId: input.processingBatchId,
    reviewHash: input.reviewHash,
  };
  const chosenAsset = input.assetId === otherAssetId ? otherAssetId : assetId;
  const chosenRecord = chosenAsset === otherAssetId ? otherRecordId : recordId;
  if (requestUrl(url).endsWith('/geometry')) {
    geometryReads++;
    return Response.json({
      reference,
      assetId: chosenAsset,
      crs: 'EPSG:4326',
      features: [
        {
          recordId: chosenRecord,
          assetId: chosenAsset,
          index: 1,
          sourceId: 'table:1/row:1',
          sourceCrs: 'EPSG:4326',
          geometry: nativeReply,
        },
      ],
      nextCursor: `fresh-authorized-cursor-${geometryReads}`,
    });
  }
  if (requestUrl(url).endsWith('/records'))
    return Response.json({
      reference,
      assetId: chosenAsset,
      columns: [{ key: 'name', label: 'Original name' }],
      records: [
        {
          recordId: chosenRecord,
          assetId: chosenAsset,
          index: 1,
          sourceId: 'table:1/row:1',
          hasGeometry: true,
          values: { name: 'Synthetic camera fixture' },
        },
      ],
      nextCursor: null,
    });
  return Response.json({
    reference,
    parserVersion: 'synthetic-camera-fixture-v1',
    status: 'READY',
    createdAt: '2026-10-03T00:00:00Z',
    totalAssetCount: 2,
    knownRecordCount: 2,
    knownFeatureCount: 2,
    unknownAssetCount: 0,
    assets: [assetId, otherAssetId].map((id) => ({
      assetId: id,
      sourceHash: 'b'.repeat(64),
      status: 'READY',
      recordCount: 1,
      featureCount: 1,
      reason: null,
    })),
    nextCursor: null,
  });
}
beforeEach(() => {
  probe.instances.length = 0;
  probe.hits.length = 0;
  geometryReads = 0;
  nativeReply = native;
  fetch.mockImplementation((url, init) =>
    Promise.resolve(fixtureReply(url, init)),
  );
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
async function settle() {
  await waitFor(() => expect(screen.queryByText(copy.loading)).toBeNull());
}
async function openMap() {
  const view = render(<IngestionCandidateReader reference={ref} locale="en" />);
  const buttons = await screen.findAllByRole('button', {
    name: copy.readGeometry,
  });
  fireEvent.click(buttons[0]);
  await screen.findByRole('region', { name: 'Map' });
  await settle();
  return view;
}
const position = { center: [116.7, 40.2], zoom: 9 };

it('keeps the map engine and reading camera while its tab is hidden, without exposing hidden map controls', async () => {
  const view = await openMap();
  const engine = probe.instances[0];
  engine.camera = position;
  const canvas = screen.getByRole('region', { name: 'Map' });
  expect(screen.getByRole('checkbox', { name: 'Map' })).toBeDefined();
  for (const tab of screen.getAllByRole('tab')) {
    const target = tab.getAttribute('aria-controls');
    expect(target).not.toBeNull();
    expect(document.getElementById(target ?? '')?.getAttribute('role')).toBe(
      'tabpanel',
    );
  }
  fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
  await screen.findByText('Synthetic camera fixture');
  await settle();
  expect(screen.queryByRole('region', { name: 'Map' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Map' })).toBeNull();
  expect(view.container.contains(canvas)).toBe(true);
  expect(canvas.closest('[hidden]')).not.toBeNull();
  expect(engine.removed).toBe(false);
  expect(engine.camera).toEqual(position);
});
it('returns to the same drawing after a new authorized geometry reply and uses its new cursor', async () => {
  await openMap();
  const engine = probe.instances[0];
  engine.camera = position;
  fireEvent.click(screen.getByRole('checkbox', { name: 'Map' }));
  expect(screen.getByRole('checkbox', { name: 'Map' })).toHaveProperty(
    'checked',
    false,
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
  await screen.findByText('Synthetic camera fixture');
  await settle();
  fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
  await settle();
  expect(geometryReads).toBe(2);
  expect(probe.instances).toHaveLength(1);
  expect(engine.removed).toBe(false);
  expect(engine.camera).toEqual(position);
  expect(screen.getByRole('checkbox', { name: 'Map' })).toHaveProperty(
    'checked',
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: copy.nextGeometry }));
  await settle();
  const last = requestInput(fetch.mock.calls.at(-1)?.[1]);
  expect(last.after).toBe('fresh-authorized-cursor-2');
  expect(last).toMatchObject({ ...ref, assetId, first: 50 });
});
it('retains map selection and camera on a selected-record round trip and full-workspace expansion', async () => {
  await openMap();
  const engine = probe.instances[0];
  engine.camera = position;
  probe.hits = [{ properties: { recordId } }];
  act(() => engine.events.get('click')?.({ point: { x: 1, y: 2 } }));
  fireEvent.click(screen.getByRole('button', { name: 'View selected record' }));
  await screen.findByText('Synthetic camera fixture');
  await settle();
  expect(
    screen
      .getByRole('button', { name: 'Select record 1' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(
    screen.getByRole('button', { name: copy.viewSelectedGeometry }),
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Expand workspace' }));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(probe.instances).toHaveLength(1);
  expect(engine.camera).toEqual(position);
  expect(engine.filter).toHaveBeenCalledWith(
    'reader-selected-line',
    expect.arrayContaining([expect.arrayContaining([recordId])]),
  );
  expect(native.coordinates).toEqual([
    [116, 40, 12],
    [117, 40, 13],
  ]);
});
it('clears the hidden map and its camera when current permission is denied', async () => {
  const view = await openMap();
  const engine = probe.instances[0];
  engine.camera = position;
  fetch.mockResolvedValueOnce(
    Response.json({ code: 'NOT_AUTHORIZED' }, { status: 403 }),
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
  await screen.findByRole('alert');
  expect(engine.removed).toBe(true);
  expect(
    view.container.querySelector('[data-testid="data-foundation-map"]'),
  ).toBeNull();
  expect(screen.queryByRole('link', { name: 'Download original' })).toBeNull();
});
it('does not reuse a former camera after the fixed candidate changes, even for identical native geometry', async () => {
  const { rerender } = await openMap();
  const previous = probe.instances[0];
  previous.camera = position;
  rerender(
    <IngestionCandidateReader
      reference={{ ...ref, reviewHash: 'c'.repeat(64) }}
      locale="en"
    />,
  );
  const buttons = await screen.findAllByRole('button', {
    name: copy.readGeometry,
  });
  fireEvent.click(buttons[0]);
  await screen.findByRole('region', { name: 'Map' });
  await settle();
  expect(previous.removed).toBe(true);
  expect(probe.instances).toHaveLength(2);
  expect(probe.instances[1]?.camera).not.toEqual(position);
  expect(requestInput(fetch.mock.calls.at(-1)?.[1]).reviewHash).toBe(
    'c'.repeat(64),
  );
});
it('does not transfer a camera to a different asset with the same native coordinates', async () => {
  await openMap();
  const previous = probe.instances[0];
  previous.camera = position;
  fireEvent.click(screen.getByRole('tab', { name: 'Originals' }));
  fireEvent.click(
    screen.getAllByRole('button', { name: copy.readGeometry })[1],
  );
  await screen.findByRole('region', { name: 'Map' });
  await settle();
  expect(previous.removed).toBe(true);
  expect(probe.instances).toHaveLength(2);
  expect(probe.instances[1]?.camera).not.toEqual(position);
  expect(requestInput(fetch.mock.calls.at(-1)?.[1]).assetId).toBe(otherAssetId);
});

it('replaces the old drawing when new authorized native geometry differs within the same fixed candidate', async () => {
  await openMap();
  const previous = probe.instances[0];
  previous.camera = position;
  nativeReply = {
    type: 'LineString',
    coordinates: [
      [115, 39, 12],
      [116, 39, 13],
    ],
  };
  fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
  await settle();
  expect(geometryReads).toBe(2);
  expect(previous.removed).toBe(true);
  expect(probe.instances).toHaveLength(2);
  expect(probe.instances[1]?.camera).not.toEqual(position);
  expect(native.coordinates).toEqual([
    [116, 40, 12],
    [117, 40, 13],
  ]);
});

it('does not retain a current-batch camera when a saved view opens another fixed batch in the same reader', async () => {
  await openMap();
  const previous = probe.instances[0];
  previous.camera = position;
  const oldRef = {
    ...ref,
    processingBatchId: '10000000-0000-4000-8000-000000000007',
    reviewHash: 'c'.repeat(64),
  };
  const viewId = '10000000-0000-4000-8000-000000000009';
  const savedView = {
    kind: 'ingestion-candidate-view',
    viewId,
    title: 'Synthetic historical camera fixture',
    visibility: 'private',
    createdAt: '2026-10-03T00:00:00Z',
    revokedAt: null,
  };
  const opened = {
    kind: 'ingestion-candidate-view',
    savedView,
    references: [oldRef],
    viewSpec: {
      page: { kind: 'geometry', reference: oldRef, assetId, first: 50 },
    },
    request: {
      capabilityId: 'data.ingestion.candidate.geometry',
      input: { ...oldRef, assetId, first: 50 },
    },
  };
  fetch.mockImplementation((url, init) =>
    Promise.resolve(
      requestUrl(url).endsWith('/list')
        ? Response.json({ items: [savedView], nextCursor: null })
        : requestUrl(url).endsWith('/open')
          ? Response.json(opened)
          : fixtureReply(url, init),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
  await screen.findByText(savedView.title);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen view' }));
  await screen.findByDisplayValue(savedView.title);
  await settle();
  expect(previous.removed).toBe(true);
  expect(probe.instances).toHaveLength(2);
  expect(probe.instances[1]?.camera).not.toEqual(position);
  const geometryRequest = fetch.mock.calls
    .filter(([url]) => requestUrl(url).endsWith('/geometry'))
    .at(-1);
  expect(requestInput(geometryRequest?.[1])).toMatchObject({
    ...oldRef,
    assetId,
  });
  expect(
    fetch.mock.calls.filter(([url]) => requestUrl(url).endsWith('/open')),
  ).toHaveLength(2);
});

const savedCamera = {
  longitude: 116.7,
  latitude: 40.2,
  zoom: 9,
  bearing: 0,
  pitch: 0,
};
const savedId = '10000000-0000-4000-8000-000000000009';
const period = {
  from: '2023-12',
  to: '2024-02',
  unit: 'month',
  includeUndated: false,
};
function savedCameraReply(camera = savedCamera) {
  const savedView = {
    kind: 'ingestion-candidate-view',
    viewId: savedId,
    title: 'Synthetic saved camera',
    visibility: 'private',
    createdAt: '2026-10-03T00:00:00Z',
    revokedAt: null,
  };
  return {
    kind: 'ingestion-candidate-view',
    savedView,
    references: [ref],
    viewSpec: {
      page: { kind: 'geometry', reference: ref, assetId, first: 50 },
      focus: { reference: ref, assetId, recordId },
      map: { camera, layers: { points: true, lines: false, polygons: true } },
      period,
    },
    request: {
      capabilityId: 'data.ingestion.candidate.geometry',
      input: { ...ref, assetId, first: 50 },
    },
  };
}
async function openPersistedCamera(camera = savedCamera) {
  const opened = savedCameraReply(camera);
  fetch.mockImplementation((url, init) =>
    Promise.resolve(
      requestUrl(url).endsWith('/open')
        ? Response.json(opened)
        : requestUrl(url).endsWith('/create')
          ? Response.json({
              savedView: { ...opened.savedView, viewId: otherRecordId },
            })
          : fixtureReply(url, init),
    ),
  );
  render(
    <IngestionCandidateReader
      reference={ref}
      savedViewId={savedId}
      locale="en"
    />,
  );
  await screen.findByDisplayValue(opened.savedView.title);
  await settle();
  return opened;
}

it('restores the server-fixed two-dimensional camera on reopening without the load fit overwriting it', async () => {
  await openPersistedCamera();
  const engine = probe.instances[0];
  act(() => engine.events.get('load')?.(undefined));
  const display = displayCamera(savedCamera);
  expect(engine.camera).toEqual({
    center: [display.longitude, display.latitude],
    zoom: display.zoom,
  });
  expect(engine.fitted).toBe(false);
});

it('saves the current reading camera as a new view without changing fixed members, the page, focus or retained settings', async () => {
  const opened = await openPersistedCamera();
  const engine = probe.instances[0];
  engine.camera = { center: [117.2, 40.3], zoom: 10 };
  act(() => engine.events.get('moveend')?.(undefined));
  fireEvent.change(screen.getByRole('textbox', { name: copy.viewName }), {
    target: { value: 'Another reading' },
  });
  fireEvent.click(screen.getByRole('button', { name: copy.save }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([url]) => requestUrl(url).endsWith('/create')),
    ).toBe(true),
  );
  const create = fetch.mock.calls.find(([url]) =>
    requestUrl(url).endsWith('/create'),
  );
  const input = requestInput(create?.[1]);
  expect(input.references).toEqual(opened.references);
  expect(input.viewSpec).toMatchObject({
    page: opened.viewSpec.page,
    focus: opened.viewSpec.focus,
    period,
    map: {
      camera: authorityCamera({
        longitude: 117.2,
        latitude: 40.3,
        zoom: 10,
        bearing: 0,
        pitch: 0,
      }),
      layers: opened.viewSpec.map.layers,
    },
  });
  expect(opened.viewSpec.map.camera).toEqual(savedCamera);
});
