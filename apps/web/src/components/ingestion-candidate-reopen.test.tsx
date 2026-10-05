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
import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordPageSchema,
  OpenIngestionCandidateViewOutputSchema,
} from '@wiser/data-contracts';
import { IngestionCandidateReader } from './ingestion-candidate-reader';
import { authorityCamera, displayCamera } from '@/lib/amap-camera';

// Discrete lifecycle regression. Actual reader, read parsers and map component;
// synthetic HTTP and WebGL engine. Dispatching these jsdom events does not
// demonstrate browser bfcache behavior, real Auth or a professional approval.
const probe = vi.hoisted(() => ({
  maps: [] as Array<{
    removed: boolean;
    camera: { center: number[]; zoom: number };
    events: Map<string, (value: unknown) => void>;
  }>,
}));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  NavigationControl: class {},
  Map: class {
    removed = false;
    camera: { center: number[]; zoom: number };
    events = new Map<string, (value: unknown) => void>();
    constructor(options: { center: number[]; zoom: number }) {
      this.camera = { center: options.center, zoom: options.zoom };
      probe.maps.push(this);
    }
    touchZoomRotate = { disableRotation: vi.fn() };
    queryRenderedFeatures() {
      return [];
    }
    on(event: string, callback: (value: unknown) => void) {
      const previous = this.events.get(event);
      this.events.set(event, (value) => {
        previous?.(value);
        callback(value);
      });
    }
    once(event: string, callback: (value: unknown) => void) {
      this.on(event, callback);
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
      this.camera = { center: [116.5, 40], zoom: 7 };
    }
    getLayer(id: string) {
      return id.startsWith('reader-selected-') ? { id } : undefined;
    }
    setFilter() {}
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
const oldRef = {
  ...ref,
  processingBatchId: '10000000-0000-4000-8000-000000000012',
  reviewHash: 'd'.repeat(64),
};
const otherMember = {
  ...ref,
  ingestionId: '10000000-0000-4000-8000-000000000011',
  processingBatchId: '10000000-0000-4000-8000-000000000013',
  reviewHash: 'e'.repeat(64),
};
const assetId = '10000000-0000-4000-8000-000000000003';
const recordId = '10000000-0000-4000-8000-000000000004';
const anchorId = '10000000-0000-4000-8000-000000000006';
const viewId = '10000000-0000-4000-8000-000000000009';
const rawValue = 'Synthetic restricted original value';
const lateValue = 'Synthetic late original value';
const savedTitle = 'Synthetic fixed multi-member view';
const savedCamera = {
  longitude: 116.7,
  latitude: 40.2,
  zoom: 9,
  bearing: 0,
  pitch: 0,
};
function assets(reference = ref) {
  return IngestionCandidateAssetPageSchema.parse({
    reference,
    parserVersion: 'synthetic-reopen-v1',
    status: 'READY',
    createdAt: '2026-10-03T00:00:00Z',
    totalAssetCount: 1,
    knownRecordCount: 1,
    knownFeatureCount: 1,
    unknownAssetCount: 0,
    assets: [
      {
        assetId,
        sourceHash: 'b'.repeat(64),
        status: 'READY',
        recordCount: 1,
        featureCount: 1,
        reason: null,
      },
    ],
    nextCursor: null,
  });
}
function records(reference = ref, value = rawValue) {
  return IngestionCandidateRecordPageSchema.parse({
    reference,
    assetId,
    columns: [
      { key: 'name', label: 'Original text' },
      { key: 'value', label: 'Original value' },
    ],
    records: [
      {
        recordId,
        assetId,
        index: 2,
        sourceId: 'table:1/row:2',
        hasGeometry: true,
        values: { name: value, value: 0 },
      },
    ],
    nextCursor: null,
  });
}
function geometry(reference = ref) {
  return IngestionCandidateGeometryPageSchema.parse({
    reference,
    assetId,
    crs: 'EPSG:4326',
    features: [
      {
        recordId,
        assetId,
        index: 2,
        sourceId: 'table:1/row:2',
        sourceCrs: 'EPSG:4326',
        geometry: {
          type: 'LineString',
          coordinates: [
            [116, 40],
            [117, 40],
          ],
        },
      },
    ],
    nextCursor: null,
  });
}
function saved(kind: 'records' | 'geometry', cursor: string) {
  return OpenIngestionCandidateViewOutputSchema.parse({
    kind: 'ingestion-candidate-view',
    savedView: {
      kind: 'ingestion-candidate-view',
      viewId,
      title: savedTitle,
      visibility: 'private',
      createdAt: '2026-10-03T00:00:00Z',
      revokedAt: null,
    },
    references: [oldRef, otherMember],
    viewSpec: {
      page: {
        kind,
        reference: oldRef,
        assetId,
        first: 50,
        afterRecordId: anchorId,
      },
      focus: { reference: oldRef, assetId, recordId },
      map: {
        camera: savedCamera,
        layers: { points: true, lines: true, polygons: true },
      },
    },
    request: {
      capabilityId: `data.ingestion.candidate.${kind}`,
      input: { ...oldRef, assetId, first: 50, after: cursor },
    },
  });
}
const fetch = vi.fn<typeof globalThis.fetch>();
function url(value: RequestInfo | URL) {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.href
      : value.url;
}
function input(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string')
    throw new Error('Expected JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}
function pageReply(
  value: RequestInfo | URL,
  init?: RequestInit,
  text = rawValue,
) {
  const request = input(init);
  const reference =
    request.processingBatchId === oldRef.processingBatchId ? oldRef : ref;
  if (url(value).endsWith('/get')) return Response.json(assets(reference));
  if (url(value).endsWith('/records'))
    return Response.json(records(reference, text));
  if (url(value).endsWith('/geometry'))
    return Response.json(geometry(reference));
  throw new Error(`Unexpected synthetic endpoint: ${url(value)}`);
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function idle() {
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Refresh candidate' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
}
type RestoreEvent = 'visible' | 'persisted pageshow';
let visibility: DocumentVisibilityState;
const visibilityDescriptor = Object.getOwnPropertyDescriptor(
  document,
  'visibilityState',
);
function restore(event: RestoreEvent) {
  if (event === 'visible') {
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
  } else {
    const page = new Event('pageshow');
    Object.defineProperty(page, 'persisted', { value: true });
    fireEvent(window, page);
  }
}
function unguarded(element: HTMLElement | null) {
  if (element instanceof HTMLButtonElement && element.disabled) return null;
  return element?.closest('[hidden], [inert]') ? null : element;
}
async function readable() {
  await screen.findByText(rawValue);
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Refresh candidate' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  const select = screen.queryByRole('button', { name: 'Select record 2' });
  if (select) fireEvent.click(select);
  const link = screen.getByRole('link', { name: 'Download original' });
  expect(
    screen.getByRole('button', { name: 'View selected spatial content' }),
  ).toBeDefined();
  expect(link.getAttribute('href')).toContain(assetId);
  expect(screen.getByRole('cell', { name: '0' })).toBeDefined();
  expect(screen.getAllByText('table:1/row:2').length).toBeGreaterThan(0);
  return link;
}
async function direct() {
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  await screen.findByRole('button', { name: 'Read records' });
  fireEvent.click(screen.getByRole('button', { name: 'Read records' }));
  return readable();
}
async function persisted(kind: 'records' | 'geometry') {
  render(
    <IngestionCandidateReader
      reference={ref}
      savedViewId={viewId}
      locale="en"
    />,
  );
  await screen.findByDisplayValue(savedTitle);
  await idle();
  if (kind === 'geometry')
    fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
  const original = await readable();
  expect(original.getAttribute('href')).toContain(oldRef.processingBatchId);
  expect(original.getAttribute('href')).toContain(oldRef.reviewHash);
  expect(original.getAttribute('href')).toContain(viewId);
  if (kind === 'geometry') {
    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Refresh candidate' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
  }
}
beforeEach(() => {
  fetch.mockReset();
  fetch.mockImplementation((value, init) =>
    Promise.resolve(pageReply(value, init)),
  );
  vi.stubGlobal('fetch', fetch);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  probe.maps.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (visibilityDescriptor)
    Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
  else Reflect.deleteProperty(document, 'visibilityState');
});

it('accepts the synthetic replies under existing contracts, with a two-member saved manifest and page anchor', () => {
  expect(assets().knownRecordCount).toBe(1);
  expect(records().records[0]?.values.value).toBe(0);
  expect(geometry().features[0]?.recordId).toBe(recordId);
  for (const kind of ['records', 'geometry'] as const) {
    const opened = saved(kind, 'synthetic-resume-before');
    expect(opened.references).toEqual([oldRef, otherMember]);
    expect(opened.viewSpec.page).toMatchObject({ afterRecordId: anchorId });
  }
});

it.each([403, 409])(
  'manual denied-read control clears values and original links on %s',
  async (status) => {
    await direct();
    fetch.mockResolvedValueOnce(new Response(null, { status }));
    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(rawValue)).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'Download original' }),
    ).toBeNull();
  },
);

it.each(['visible', 'persisted pageshow'] as const)(
  'starts a fresh authorized read after %s',
  async (event) => {
    await direct();
    const before = fetch.mock.calls.length;
    restore(event);
    await waitFor(() =>
      expect(fetch.mock.calls.length).toBeGreaterThan(before),
    );
    await idle();
  },
);

it.each(['visible', 'persisted pageshow'] as const)(
  'blocks cached original content while %s reauthorization is pending',
  async (event) => {
    await direct();
    const pending = deferred();
    fetch.mockImplementation(() => pending.promise);
    const before = fetch.mock.calls.length;
    restore(event);
    // Synchronous gate: retained bytes may stay, but inert must block new navigation.
    // Accessible queries allow a guarded hidden/inert retained page; this does
    // not require deleting harmless reading state before authority is resolved.
    expect.soft(fetch.mock.calls.length).toBeGreaterThan(before);
    expect
      .soft(
        unguarded(screen.queryByRole('link', { name: 'Download original' })),
      )
      .toBeNull();
    expect.soft(unguarded(screen.queryByRole('table'))).toBeNull();
    expect
      .soft(
        unguarded(
          screen.queryByRole('button', {
            name: 'View selected spatial content',
          }),
        ),
      )
      .toBeNull();
  },
);

it.each([
  ['visible', 403],
  ['visible', 409],
  ['persisted pageshow', 403],
  ['persisted pageshow', 409],
] as const)(
  'clears previously read values and original links after %s receives %s',
  async (event, status) => {
    await direct();
    const denied = vi.fn(() => Promise.resolve(new Response(null, { status })));
    fetch.mockImplementation(denied);
    restore(event);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect.soft(denied).toHaveBeenCalled();
    expect.soft(screen.queryByRole('alert')).not.toBeNull();
    expect.soft(screen.queryByText(rawValue)).toBeNull();
    expect
      .soft(screen.queryByRole('link', { name: 'Download original' }))
      .toBeNull();
  },
);

it.each(['visible', 'persisted pageshow'] as const)(
  'does not restore content from a pre-%s late reply after authority changed',
  async (event) => {
    await direct();
    const older = deferred();
    const oldSignals: Array<AbortSignal | null> = [];
    fetch.mockImplementationOnce((_value, init) => {
      oldSignals.push(init?.signal ?? null);
      return older.promise;
    });
    // A real existing reader interaction issues this older request. The fake
    // intentionally permits a transport to complete after cancellation, just
    // like the existing race tests; the production parser must check its signal.
    fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
    expect(oldSignals[0]).not.toBeNull();
    const denied = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 409 })),
    );
    fetch.mockImplementation(denied);
    restore(event);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    await act(async () =>
      older.resolve(Response.json(records(ref, lateValue))),
    );
    await idle();
    expect.soft(denied).toHaveBeenCalled();
    expect.soft(oldSignals[0]?.aborted).toBe(true);
    expect.soft(screen.queryByText(lateValue)).toBeNull();
    expect
      .soft(screen.queryByRole('link', { name: 'Download original' }))
      .toBeNull();
  },
);

it.each(['visible', 'persisted pageshow'] as const)(
  'rechecks the entire existing saved manifest on %s before retaining a permitted displayed member',
  async (event) => {
    let memberRevoked = false;
    const opens = vi.fn();
    fetch.mockImplementation((value, init) => {
      if (url(value).endsWith('/open')) {
        opens(input(init));
        return Promise.resolve(
          memberRevoked
            ? new Response(null, { status: 403 })
            : Response.json(saved('records', 'synthetic-resume-before')),
        );
      }
      // Displayed oldRef remains permitted. Only the existing server open
      // operation knows that another member is now revoked; no new endpoint.
      return Promise.resolve(pageReply(value, init));
    });
    await persisted('records');
    const before = opens.mock.calls.length;
    // The outer persisted-view route opens once, then the reader brackets its
    // material read with two opens. All three are the existing full-manifest
    // operation. The precise initial count is an implementation detail.
    expect(before).toBeGreaterThan(0);
    memberRevoked = true;
    restore(event);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect.soft(opens.mock.calls.length).toBeGreaterThan(before);
    expect.soft(opens.mock.calls.at(-1)?.[0]).toEqual({ viewId });
    expect.soft(screen.queryByText(rawValue)).toBeNull();
    expect
      .soft(screen.queryByRole('link', { name: 'Download original' }))
      .toBeNull();
    expect.soft(screen.queryByDisplayValue(savedTitle)).toBeNull();
  },
);

it.each(['visible', 'persisted pageshow'] as const)(
  'legally restores %s with fresh fixed-page resume, historical batch, selection and camera',
  async (event) => {
    let reopening = false;
    const opens = vi.fn();
    fetch.mockImplementation((value, init) => {
      if (url(value).endsWith('/open')) {
        opens(input(init));
        return Promise.resolve(
          Response.json(
            saved(
              'geometry',
              reopening ? 'synthetic-resume-after' : 'synthetic-resume-before',
            ),
          ),
        );
      }
      return Promise.resolve(pageReply(value, init));
    });
    await persisted('geometry');
    const engine = probe.maps.at(-1)!;
    const display = displayCamera(savedCamera);
    expect(engine.camera).toEqual({
      center: [display.longitude, display.latitude],
      zoom: display.zoom,
    });
    const cameraBefore = structuredClone(engine.camera);
    Object.freeze(cameraBefore.center);
    Object.freeze(cameraBefore);
    expect(cameraBefore).not.toBe(engine.camera);
    expect(cameraBefore.center).not.toBe(engine.camera.center);
    expect(
      screen
        .getByRole('button', { name: 'Select record 2 · Line' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    const before = fetch.mock.calls.length;
    const openBefore = opens.mock.calls.length;
    reopening = true;
    restore(event);
    await waitFor(() =>
      expect(
        fetch.mock.calls
          .slice(before)
          .some(([value]) => url(value).endsWith('/geometry')),
      ).toBe(true),
    );
    await idle();
    const newReads = fetch.mock.calls
      .slice(before)
      .filter(([value]) => url(value).endsWith('/geometry'));
    expect.soft(opens.mock.calls.length).toBeGreaterThan(openBefore);
    expect.soft(newReads.length).toBeGreaterThan(0);
    const latest = newReads.at(-1)?.[1];
    expect.soft(latest ? input(latest) : undefined).toMatchObject({
      ...oldRef,
      assetId,
      first: 50,
      after: 'synthetic-resume-after',
    });
    const original = screen.getByRole('link', { name: 'Download original' });
    expect(original.getAttribute('href')).toContain(oldRef.processingBatchId);
    expect(original.getAttribute('href')).toContain(oldRef.reviewHash);
    expect(original.getAttribute('href')).toContain(viewId);
    expect(
      screen
        .getByRole('button', { name: 'Select record 2 · Line' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(probe.maps.at(-1)?.camera).toEqual(cameraBefore);
    // The actual request above proves use of the newly issued fixed-page
    // resume cursor. The reader does not expose afterRecordId itself; retaining
    // that internal navigation anchor for a later save is not proven here.
  },
);

const advancedId = '10000000-0000-4000-8000-000000000024';
const advancedCamera = { center: [118.1, 41.2], zoom: 10 };
function savedReplies(kind: 'records' | 'geometry') {
  fetch.mockImplementation((value, init) => {
    if (url(value).endsWith('/open'))
      return Promise.resolve(Response.json(saved(kind, 'saved-start')));
    if (url(value).endsWith('/create'))
      return Promise.resolve(
        Response.json({ savedView: saved(kind, 'saved-start').savedView }),
      );
    return Promise.resolve(pageReply(value, init));
  });
}
it.each(['visible', 'persisted pageshow'] as const)(
  'preserves an advanced spatial page, changed selection and moved camera after %s, proven by the next immutable save',
  async (event) => {
    let recovering = false;
    fetch.mockImplementation((value, init) => {
      const body = input(init);
      if (url(value).endsWith('/open'))
        return Promise.resolve(
          Response.json(
            saved('geometry', recovering ? 'fresh-start' : 'saved-start'),
          ),
        );
      if (url(value).endsWith('/create'))
        return Promise.resolve(
          Response.json({
            savedView: saved('geometry', 'saved-start').savedView,
          }),
        );
      if (url(value).endsWith('/geometry')) {
        const result = geometry(oldRef);
        if (body.after === 'advanced-page')
          result.features = result.features.map((row) => ({
            ...row,
            recordId: advancedId,
            index: 3,
            sourceId: 'table:1/row:3',
          }));
        else result.nextCursor = 'advanced-page';
        return Promise.resolve(Response.json(result));
      }
      return Promise.resolve(pageReply(value, init));
    });
    await persisted('geometry');
    fireEvent.click(screen.getByRole('button', { name: 'Next spatial page' }));
    await screen.findByRole('button', { name: 'Select record 3 · Line' });
    await idle();
    fireEvent.click(
      screen.getByRole('button', { name: 'Select record 3 · Line' }),
    );
    const engine = probe.maps.at(-1)!;
    await act(async () => {
      engine.events.get('load')?.(undefined);
      engine.camera = structuredClone(advancedCamera);
      engine.events.get('moveend')?.(undefined);
    });
    const before = fetch.mock.calls.length;
    recovering = true;
    restore(event);
    await waitFor(() =>
      expect(
        fetch.mock.calls
          .slice(before)
          .some(([value]) => url(value).endsWith('/geometry')),
      ).toBe(true),
    );
    await idle();
    const reads = fetch.mock.calls
      .slice(before)
      .filter(([value]) => url(value).endsWith('/geometry'));
    expect(input(reads.at(-1)![1])).toMatchObject({
      ...oldRef,
      assetId,
      after: 'advanced-page',
    });
    expect(
      screen.getByRole('tab', { name: 'Map' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen
        .getByRole('button', { name: 'Select record 3 · Line' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(probe.maps.at(-1)).toBe(engine);
    expect(engine.camera).toEqual(advancedCamera);
    fireEvent.click(
      screen.getByRole('button', { name: 'Save view', exact: true }),
    );
    await screen.findByText('View saved.');
    const created = fetch.mock.calls.filter(([value]) =>
      url(value).endsWith('/create'),
    );
    expect(created).toHaveLength(1);
    expect(input(created[0]![1])).toMatchObject({
      references: [oldRef, otherMember],
      viewSpec: {
        page: {
          kind: 'geometry',
          reference: oldRef,
          assetId,
          afterRecordId: recordId,
        },
        focus: { reference: oldRef, assetId, recordId: advancedId },
        map: {
          camera: authorityCamera({
            longitude: advancedCamera.center[0]!,
            latitude: advancedCamera.center[1]!,
            zoom: advancedCamera.zoom,
            bearing: 0,
            pitch: 0,
          }),
        },
      },
    });
  },
);
it('retains the current records tab when the saved page starts on geometry and brackets the current read with the full manifest', async () => {
  savedReplies('geometry');
  await persisted('geometry');
  fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
  await idle();
  const before = fetch.mock.calls.length;
  restore('visible');
  await waitFor(() =>
    expect(
      fetch.mock.calls
        .slice(before)
        .some(([value]) => url(value).endsWith('/records')),
    ).toBe(true),
  );
  await idle();
  const requests = fetch.mock.calls
    .slice(before)
    .map(([value]) => url(value).split('/').at(-1));
  expect(requests).toEqual(['open', 'records', 'open']);
  expect(
    screen.getByRole('tab', { name: 'Records' }).getAttribute('aria-selected'),
  ).toBe('true');
  expect(
    input(
      fetch.mock.calls
        .slice(before)
        .find(([value]) => url(value).endsWith('/records'))![1],
    ),
  ).not.toHaveProperty('after');
});
it.each([400, 409])(
  'consumes the current advanced cursor and clears on its actual %s rejection rather than resetting to the saved start',
  async (status) => {
    let recovering = false;
    fetch.mockImplementation((value, init) => {
      if (url(value).endsWith('/open'))
        return Promise.resolve(Response.json(saved('records', 'saved-start')));
      if (url(value).endsWith('/records')) {
        if (recovering && input(init).after === 'advanced-page')
          return Promise.resolve(new Response(null, { status }));
        const result = records(oldRef);
        result.nextCursor = 'advanced-page';
        return Promise.resolve(Response.json(result));
      }
      return Promise.resolve(pageReply(value, init));
    });
    await persisted('records');
    fireEvent.click(screen.getByRole('button', { name: 'Next records' }));
    await idle();
    const before = fetch.mock.calls.length;
    recovering = true;
    restore('visible');
    await screen.findByRole('alert');
    expect(
      fetch.mock.calls
        .slice(before)
        .some(
          ([value, init]) =>
            url(value).endsWith('/records') &&
            input(init).after === 'advanced-page',
        ),
    ).toBe(true);
    expect(screen.queryByText(rawValue)).toBeNull();
    expect(screen.queryByDisplayValue(savedTitle)).toBeNull();
  },
);
it('merges simultaneous visible and persisted pageshow recovery into one pending read', async () => {
  await direct();
  const held = deferred();
  fetch.mockImplementation(() => held.promise);
  const before = fetch.mock.calls.length;
  restore('visible');
  restore('persisted pageshow');
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  expect(fetch.mock.calls.length - before).toBe(1);
  await act(async () => held.resolve(Response.json(records())));
  await idle();
  expect(screen.getByText(rawValue)).toBeDefined();
});
it('ignores hidden visibility and nonpersisted pageshow without starting a new read', async () => {
  await direct();
  const before = fetch.mock.calls.length;
  visibility = 'hidden';
  fireEvent(document, new Event('visibilitychange'));
  fireEvent(window, new Event('pageshow'));
  expect(fetch.mock.calls.length).toBe(before);
});
it('defers recovery until the current save finishes, preserving its signal and delivered bytes', async () => {
  savedReplies('records');
  await persisted('records');
  const held = deferred();
  let mutationSignal: AbortSignal | null = null;
  fetch.mockImplementation((value, init) => {
    if (url(value).endsWith('/create')) {
      mutationSignal = init?.signal ?? null;
      return held.promise;
    }
    if (url(value).endsWith('/open'))
      return Promise.resolve(Response.json(saved('records', 'fresh-start')));
    return Promise.resolve(pageReply(value, init));
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Save view', exact: true }),
  );
  await waitFor(() => expect(mutationSignal).not.toBeNull());
  const before = fetch.mock.calls.length;
  restore('visible');
  restore('persisted pageshow');
  expect(mutationSignal!.aborted).toBe(false);
  expect(fetch.mock.calls.length).toBe(before);
  expect(screen.getByText(rawValue)).toBeDefined();
  expect(
    unguarded(screen.getByRole('link', { name: 'Download original' })),
  ).toBeNull();
  await act(async () =>
    held.resolve(
      Response.json({ savedView: saved('records', 'fresh-start').savedView }),
    ),
  );
  await screen.findByText('View saved.');
  await waitFor(() =>
    expect(
      fetch.mock.calls
        .slice(before)
        .some(([value]) => url(value).endsWith('/records')),
    ).toBe(true),
  );
  await idle();
  expect(mutationSignal!.aborted).toBe(false);
});
it('does not interrupt current-view revoke or reopen a view after that revoke clears the reader', async () => {
  const held = deferred();
  let revokeSignal: AbortSignal | null = null;
  fetch.mockImplementation((value, init) => {
    if (url(value).endsWith('/open'))
      return Promise.resolve(Response.json(saved('records', 'saved-start')));
    if (url(value).endsWith('/list'))
      return Promise.resolve(
        Response.json({
          items: [saved('records', 'saved-start').savedView],
          nextCursor: null,
        }),
      );
    if (url(value).endsWith('/revoke')) {
      revokeSignal = init?.signal ?? null;
      return held.promise;
    }
    return Promise.resolve(pageReply(value, init));
  });
  await persisted('records');
  fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
  await screen.findByRole('button', { name: 'Revoke view' });
  await idle();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke view' }));
  await waitFor(() => expect(revokeSignal).not.toBeNull());
  const before = fetch.mock.calls.length;
  restore('visible');
  expect(revokeSignal!.aborted).toBe(false);
  await act(async () => held.resolve(Response.json({ viewId, revoked: true })));
  await screen.findByText('View revoked.');
  await idle();
  expect(fetch.mock.calls.length).toBe(before);
  expect(revokeSignal!.aborted).toBe(false);
  expect(screen.queryByText(rawValue)).toBeNull();
});
