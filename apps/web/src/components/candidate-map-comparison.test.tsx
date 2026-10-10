// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IngestionCandidateReader } from './ingestion-candidate-reader';
import { getDictionary } from '@/lib/i18n';
import type { MapCamera } from '@/lib/amap-camera';
import { useEffect, useImperativeHandle, type Ref } from 'react';
import {
  OpenIngestionCandidateTopicOutputSchema,
  OpenIngestionCandidateViewOutputSchema,
  CreateIngestionCandidateViewInputSchema,
} from '@wiser/data-contracts';

const maps = vi.hoisted(() => ({ active: 0, maximum: 0, removed: 0 }));
// Synthetic transport/lifecycle checks. Native authenticated canvas is separate.
vi.mock('./data-foundation-map', () => ({
  DataFoundationMap: ({
    ariaLabel,
    readingCamera,
    initialReadingCamera,
    selectedRecordId,
    onReadingCamera,
    readingHandle,
  }: {
    ariaLabel: string;
    readingCamera?: MapCamera;
    initialReadingCamera?: MapCamera;
    selectedRecordId?: string | null;
    onReadingCamera?: (camera: MapCamera) => void;
    readingHandle?: Ref<{ camera: () => MapCamera | undefined }>;
  }) => {
    useEffect(() => {
      maps.active++;
      maps.maximum = Math.max(maps.maximum, maps.active);
      return () => {
        maps.active--;
        maps.removed++;
      };
    }, []);
    useImperativeHandle(
      readingHandle,
      () => ({
        camera: () =>
          readingCamera ??
          initialReadingCamera ?? {
            longitude: 116.5,
            latitude: 40,
            zoom: 8,
            bearing: 0,
            pitch: 0,
          },
      }),
      [readingCamera, initialReadingCamera],
    );
    return (
      <div
        data-testid={ariaLabel}
        data-camera={JSON.stringify(readingCamera ?? initialReadingCamera)}
        data-selected={selectedRecordId ?? ''}
      >
        <button
          onClick={() =>
            onReadingCamera?.({
              longitude: ariaLabel === 'Left window' ? 119 : 118,
              latitude: 41,
              zoom: ariaLabel === 'Left window' ? 11 : 10,
              bearing: 20,
              pitch: 50,
            })
          }
        >
          Move {ariaLabel}
        </button>
      </div>
    );
  },
}));
const copy = getDictionary('en').dataFoundation.candidateReader;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const assetA = '10000000-0000-4000-8000-000000000003';
const assetB = '10000000-0000-4000-8000-000000000008';
const recordA = '10000000-0000-4000-8000-000000000004';
const recordB = '10000000-0000-4000-8000-000000000005';
const recordC = '10000000-0000-4000-8000-000000000006';
const recordD = '10000000-0000-4000-8000-000000000007';
const assets = {
  reference,
  parserVersion: 'synthetic-comparison',
  status: 'READY',
  createdAt: '2026-10-10T00:00:00Z',
  totalAssetCount: 2,
  knownRecordCount: 4,
  knownFeatureCount: 4,
  unknownAssetCount: 0,
  assets: [assetA, assetB].map((assetId) => ({
    assetId,
    sourceHash: 'b'.repeat(64),
    status: 'READY',
    recordCount: 2,
    featureCount: 2,
    reason: null,
  })),
  nextCursor: null,
};
function geometry(
  assetId = assetA,
  ids = [recordA, recordB],
  nextCursor: string | null = 'next-geometry',
) {
  return {
    reference,
    assetId,
    crs: 'EPSG:4326',
    features: ids.map((recordId, i) => ({
      recordId,
      assetId,
      index: i + 1,
      sourceId: `synthetic:${recordId}`,
      sourceCrs: 'EPSG:4326',
      geometry: { type: 'Point', coordinates: [116 + i, 40] },
    })),
    nextCursor,
  };
}
function records(assetId = assetA) {
  return {
    reference,
    assetId,
    columns: [{ key: 'value', label: 'Original value' }],
    records: [recordA, recordB].map((recordId, i) => ({
      recordId,
      assetId,
      index: i + 1,
      sourceId: `synthetic:${recordId}`,
      hasGeometry: true,
      values: { value: `original:${assetId}:${recordId}` },
    })),
    nextCursor: null,
  };
}
const fetch = vi.fn<typeof globalThis.fetch>();
function json(value: unknown) {
  return Promise.resolve(Response.json(value));
}
function requestUrl(url: RequestInfo | URL) {
  return typeof url === 'string'
    ? url
    : url instanceof URL
      ? url.href
      : url.url;
}
function body(init?: RequestInit) {
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  maps.active = 0;
  maps.maximum = 0;
  maps.removed = 0;
  vi.stubGlobal('fetch', fetch);
  fetch.mockImplementation((url, init) => {
    const route = requestUrl(url),
      input = body(init);
    if (route.endsWith('/get')) return json(assets);
    if (route.endsWith('/geometry'))
      return json(geometry(String(input.assetId)));
    if (route.endsWith('/records')) return json(records(String(input.assetId)));
    if (route.endsWith('/create'))
      return json({
        savedView: {
          kind: 'ingestion-candidate-view',
          viewId: '10000000-0000-4000-8000-000000000009',
          title: 'Synthetic comparison reading',
          visibility: 'private',
          createdAt: '2026-10-10T00:00:00Z',
          revokedAt: null,
        },
      });
    throw new Error(`Unexpected synthetic route ${route}`);
  });
});
afterEach(() => {
  cleanup();
  fetch.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function openComparison() {
  const { rerender } = render(
    <IngestionCandidateReader reference={reference} locale="en" />,
  );
  await screen.findAllByRole('button', { name: copy.readGeometry });
  fireEvent.click(
    screen.getAllByRole('button', { name: copy.readGeometry })[0],
  );
  await screen.findByRole('button', { name: 'Open map comparison' });
  fireEvent.click(screen.getByRole('button', { name: 'Open map comparison' }));
  return {
    rerender,
    left: within(await screen.findByRole('region', { name: 'Left window' })),
    right: within(screen.getByRole('region', { name: 'Right window' })),
  };
}

it('reads both windows concurrently with separate cancellation ownership and adopts reversed responses only in their requesting window', async () => {
  const panes = await openComparison();
  const a = deferred(),
    b = deferred();
  const signals: AbortSignal[] = [];
  fetch.mockImplementation((url, init) => {
    if (!requestUrl(url).endsWith('/geometry'))
      throw new Error('Unexpected request');
    signals.push(init!.signal as AbortSignal);
    return signals.length === 1 ? a.promise : b.promise;
  });
  fireEvent.click(panes.left.getByRole('button', { name: copy.nextGeometry }));
  fireEvent.click(panes.right.getByRole('button', { name: copy.nextGeometry }));
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  await act(async () => {
    b.resolve(Response.json(geometry(assetA, [recordD], null)));
    await b.promise;
  });
  await panes.right.findByText(`synthetic:${recordD}`);
  expect(panes.left.queryByText(`synthetic:${recordD}`)).toBeNull();
  await act(async () => {
    a.resolve(Response.json(geometry(assetA, [recordC], null)));
    await a.promise;
  });
  await panes.left.findByText(`synthetic:${recordC}`);
  expect(panes.right.queryByText(`synthetic:${recordC}`)).toBeNull();
});

it('unmounts the original canvas before mounting two comparison canvases and releases both on return', async () => {
  await openComparison();
  expect(maps.active).toBe(2);
  expect(maps.maximum).toBe(2);
  expect(maps.removed).toBe(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Return to original map' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Left window' })).toBeNull(),
  );
  expect(maps.active).toBe(1);
  expect(maps.maximum).toBe(2);
  expect(maps.removed).toBe(3);
  expect(screen.getByTestId(copy.map).dataset.camera).toBe(
    JSON.stringify({
      longitude: 116.5,
      latitude: 40,
      zoom: 8,
      bearing: 0,
      pitch: 0,
    }),
  );
});

it.each([403, 409, 422])(
  'clears both windows and cancels the other pending read after a current %s response',
  async (status) => {
    const panes = await openComparison();
    const pending = deferred();
    let leftSignal: AbortSignal | undefined;
    let count = 0;
    fetch.mockImplementation((_url, init) => {
      if (++count === 1) {
        leftSignal = init!.signal as AbortSignal;
        return pending.promise;
      }
      return Promise.resolve(new Response(null, { status }));
    });
    fireEvent.click(
      panes.left.getByRole('button', { name: copy.nextGeometry }),
    );
    fireEvent.click(
      panes.right.getByRole('button', { name: copy.nextGeometry }),
    );
    await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: 'Left window' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Right window' })).toBeNull();
    expect(leftSignal?.aborted).toBe(true);
    expect(maps.active).toBe(0);
    expect(maps.maximum).toBe(2);
    await act(async () => {
      pending.resolve(Response.json(geometry(assetA, [recordC], null)));
      await pending.promise;
    });
    expect(screen.queryByText(`synthetic:${recordC}`)).toBeNull();
  },
);

it('keeps selections independent, synchronizes only the active camera and can explicitly return the exact right-window asset and record', async () => {
  const panes = await openComparison();
  fireEvent.click(
    panes.right.getAllByRole('button', {
      name: new RegExp(copy.selectRecord),
    })[1],
  );
  expect(screen.getByTestId('Right window').dataset.selected).toBe(recordB);
  expect(screen.getByTestId('Left window').dataset.selected).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Move Right window' }));
  expect(screen.getByTestId('Left window').dataset.camera).toBe(
    screen.getByTestId('Right window').dataset.camera,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Independent cameras' }));
  const rightCamera = screen.getByTestId('Right window').dataset.camera;
  fireEvent.click(screen.getByRole('button', { name: 'Move Left window' }));
  expect(screen.getByTestId('Right window').dataset.camera).toBe(rightCamera);
  expect(screen.getByTestId('Left window').dataset.camera).not.toBe(
    rightCamera,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Synchronized cameras' }));
  expect(screen.getByTestId('Right window').dataset.camera).toBe(
    screen.getByTestId('Left window').dataset.camera,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Independent cameras' }));
  // The right source is chosen from the already loaded authorized asset list.
  fireEvent.change(panes.right.getByRole('combobox', { name: 'Source file' }), {
    target: { value: assetB },
  });
  await waitFor(() =>
    expect(
      panes.right.getByRole('combobox').getAttribute('aria-busy'),
    ).not.toBe('true'),
  );
  await waitFor(() =>
    expect(
      panes.right
        .getAllByRole('button', {
          name: new RegExp(copy.selectRecord),
        })[1]
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(
    panes.right.getAllByRole('button', {
      name: new RegExp(copy.selectRecord),
    })[1],
  );
  expect(screen.getByTestId('Left window').dataset.selected).toBe('');
  expect(rightCamera).toBeDefined();
  fireEvent.click(
    panes.right.getByRole('button', { name: "View this window's record" }),
  );
  await screen.findByText(`original:${assetB}:${recordB}`);
  const selected = screen.getByRole('button', {
    name: `${copy.selectRecord} 2`,
  });
  expect(selected.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('region', { name: 'Left window' })).toBeNull();
  const requests = fetch.mock.calls
    .filter(([url]) => requestUrl(url).endsWith('/records'))
    .map(([, init]) => body(init));
  expect(requests.at(-1)).toMatchObject({ ...reference, assetId: assetB });
});

it('returns to the original single-map descriptor after comparison and saves only the existing single-page strict shape', async () => {
  const panes = await openComparison();
  fireEvent.change(screen.getByRole('textbox', { name: copy.viewName }), {
    target: { value: 'Synthetic comparison reading' },
  });
  expect(
    screen.getByRole('button', { name: copy.save }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    screen.getByText('Return to a single window before saving.'),
  ).toBeTruthy();
  fireEvent.click(
    panes.right.getAllByRole('button', {
      name: new RegExp(copy.selectRecord),
    })[1],
  );
  fireEvent.change(panes.right.getByRole('combobox'), {
    target: { value: assetB },
  });
  await waitFor(() =>
    expect(panes.right.getByRole('combobox').hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Return to original map' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Left window' })).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: copy.save }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([url]) => requestUrl(url).endsWith('/create')),
    ).toBe(true),
  );
  const saved = body(
    fetch.mock.calls.find(([url]) => requestUrl(url).endsWith('/create'))![1],
  );
  expect(saved.viewSpec).toMatchObject({
    page: { kind: 'geometry', reference, assetId: assetA },
  });
  expect(JSON.stringify(saved.viewSpec)).not.toMatch(
    /comparison|left|right|pane|recordPins/,
  );
});

it('blocks both windows on visible-page recovery, cancels older reads and adopts no partial recovery result', async () => {
  const panes = await openComparison();
  const old = deferred(),
    a = deferred(),
    b = deferred();
  let oldSignal: AbortSignal | undefined;
  let reads = 0;
  fetch.mockImplementation((_url, init) => {
    if (++reads === 1) {
      oldSignal = init!.signal as AbortSignal;
      return old.promise;
    }
    if (reads === 2) return json(geometry()); // original single page recovery
    return reads === 3 ? a.promise : b.promise;
  });
  fireEvent.click(panes.right.getByRole('button', { name: copy.nextGeometry }));
  await waitFor(() => expect(reads).toBe(1));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(reads).toBe(4));
  expect(oldSignal?.aborted).toBe(true);
  expect(
    panes.left
      .getByRole('button', {
        name: copy.nextGeometry,
      })
      .hasAttribute('disabled'),
  ).toBe(true);
  await act(async () => {
    a.resolve(Response.json(geometry(assetA, [recordC], null)));
    await a.promise;
  });
  expect(panes.left.queryByText(`synthetic:${recordC}`)).toBeNull();
  await act(async () => {
    b.resolve(Response.json(geometry(assetA, [recordD], null)));
    await b.promise;
  });
  await panes.left.findByText(`synthetic:${recordC}`);
  await panes.right.findByText(`synthetic:${recordD}`);
  await act(async () => {
    old.resolve(Response.json(geometry(assetA, [recordB], null)));
    await old.promise;
  });
  expect(panes.right.queryByText(`synthetic:${recordB}`)).toBeNull();
});

const viewId = '10000000-0000-4000-8000-000000000009';
function savedReading(kind: 'view' | 'topic') {
  const metadata = {
    kind: 'ingestion-candidate-view',
    viewId,
    title: 'Synthetic fixed comparison source',
    visibility: 'private',
    createdAt: '2026-10-10T00:00:00Z',
    revokedAt: null,
  };
  const references = [
    reference,
    {
      ...reference,
      ingestionId: assetB,
      processingBatchId: recordC,
      reviewHash: 'f'.repeat(64),
    },
  ];
  const page = { kind: 'geometry', reference, assetId: assetA, first: 50 };
  const request = {
    capabilityId: 'data.ingestion.candidate.geometry',
    input: { ...reference, assetId: assetA, first: 50 },
  };
  const map = {
    camera: { longitude: 116.5, latitude: 40, zoom: 8, bearing: 0, pitch: 0 },
  };
  if (kind === 'view')
    return OpenIngestionCandidateViewOutputSchema.parse({
      kind: 'ingestion-candidate-view',
      savedView: metadata,
      references,
      viewSpec: {
        page,
        focus: { reference, assetId: assetA, recordId: recordA },
        map,
      },
      request,
    });
  return OpenIngestionCandidateTopicOutputSchema.parse({
    status: 'READABLE',
    specVersion: 2,
    savedView: { ...metadata, specVersion: 2 },
    references,
    viewSpec: {
      schemaVersion: 2,
      page,
      focus: { reference, assetId: assetA, recordId: recordA },
      map,
      period: {
        windowMode: 'month',
        from: '2023-04',
        to: '2023-05',
        displayUnit: 'month',
        timeRole: 'REPORT_PERIOD',
        includeUndated: true,
      },
      topic: {
        question: 'Synthetic fixed record question',
        regionIds: ['chaobai'],
        needIds: ['K5-001'],
        recordPins: [{ reference, assetId: assetA, recordId: recordA }],
      },
      rulePins: ['projection', 'readiness', 'requirement', 'impact'].map(
        (kind) => ({
          kind,
          ruleId: `synthetic:${kind}`,
          version: 'synthetic-v1',
        }),
      ),
      dependencyPins: [
        {
          kind: 'asset',
          reference,
          assetId: assetA,
          sourceHash: 'b'.repeat(64),
          parserVersion: 'synthetic-comparison',
        },
        {
          kind: 'record',
          reference,
          assetId: assetA,
          sourceHash: 'b'.repeat(64),
          parserVersion: 'synthetic-comparison',
          recordId: recordA,
          recordHash: 'c'.repeat(64),
        },
        {
          kind: 'geometry',
          reference,
          assetId: assetA,
          sourceHash: 'b'.repeat(64),
          parserVersion: 'synthetic-comparison',
          recordId: recordA,
          recordHash: 'c'.repeat(64),
          geometryHash: 'd'.repeat(64),
        },
      ],
      relationPins: [],
    },
    request,
  });
}

it.each(['view', 'topic'] as const)(
  'confines %s comparison to its already read fixed page and keeps the complete saved spec and original path',
  async (kind) => {
    const opened = savedReading(kind);
    const originalSpec = JSON.stringify(opened);
    const ordinary = fetch.getMockImplementation()!;
    fetch.mockImplementation((url, init) =>
      requestUrl(url).endsWith('/open') ? json(opened) : ordinary(url, init),
    );
    render(
      <IngestionCandidateReader
        reference={null}
        ingestionId={reference.ingestionId}
        locale="en"
        {...(kind === 'topic'
          ? { savedTopicId: viewId }
          : { savedViewId: viewId })}
      />,
    );
    await screen.findByRole('button', { name: 'Open map comparison' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open map comparison' }),
    );
    const right = within(
      await screen.findByRole('region', { name: 'Right window' }),
    );
    const source = right.getByRole('combobox');
    expect(source.hasAttribute('disabled')).toBe(true);
    expect(within(source).getAllByRole('option')).toHaveLength(1);
    expect(
      right
        .getByRole('button', { name: copy.nextGeometry })
        .hasAttribute('disabled'),
    ).toBe(true);
    const link = right.getByRole('link', { name: copy.downloadOriginal });
    expect(link.getAttribute('href')).toContain(
      kind === 'topic' ? 'savedTopicId=' : 'savedViewId=',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move Right window' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Return to original map' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Right window' })).toBeNull(),
    );
    expect(JSON.stringify(opened)).toBe(originalSpec);
    expect(
      fetch.mock.calls.every(([url]) => !/create|pin/.test(requestUrl(url))),
    ).toBe(true);
  },
);

it.each(['denied', 'unavailable', 'changed-pins'] as const)(
  'withdraws both windows when complete topic authority is %s during recovery',
  async (failure) => {
    const opened = savedReading('topic');
    let failed = false;
    const ordinary = fetch.getMockImplementation()!;
    fetch.mockImplementation((url, init) => {
      if (!requestUrl(url).endsWith('/open')) return ordinary(url, init);
      if (!failed) return json(opened);
      if (failure === 'denied')
        return Promise.resolve(new Response(null, { status: 403 }));
      if (failure === 'unavailable')
        return json({ status: 'UNAVAILABLE', viewId });
      if (!('viewSpec' in opened))
        throw new Error('Expected synthetic readable topic');
      return json({
        ...opened,
        viewSpec: {
          ...opened.viewSpec,
          period: { ...opened.viewSpec.period, from: '2023-03' },
        },
      });
    });
    render(
      <IngestionCandidateReader
        reference={null}
        ingestionId={reference.ingestionId}
        savedTopicId={viewId}
        locale="en"
      />,
    );
    await screen.findByRole('button', { name: 'Open map comparison' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open map comparison' }),
    );
    failed = true;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: 'Left window' })).toBeNull();
    expect(
      screen.queryByRole('link', { name: copy.downloadOriginal }),
    ).toBeNull();
    expect(screen.queryByText('Synthetic fixed comparison source')).toBeNull();
    expect(
      fetch.mock.calls.every(([url]) => !/create|pin/.test(requestUrl(url))),
    ).toBe(true);
  },
);

it('cancels both old-owner reads on complete candidate replacement and refuses the late old payload', async () => {
  const panes = await openComparison();
  const pending = deferred();
  let oldSignal: AbortSignal | undefined;
  const ordinary = fetch.getMockImplementation()!;
  fetch.mockImplementation((url, init) => {
    if (requestUrl(url).endsWith('/geometry') && body(init).after) {
      oldSignal = init!.signal as AbortSignal;
      return pending.promise;
    }
    return ordinary(url, init);
  });
  fireEvent.click(panes.left.getByRole('button', { name: copy.nextGeometry }));
  await waitFor(() => expect(oldSignal).toBeDefined());
  // Replace the keyed reader owner, as the authenticated route does.
  panes.rerender(
    <IngestionCandidateReader
      reference={{ ...reference, reviewHash: 'e'.repeat(64) }}
      locale="en"
    />,
  );
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(Response.json(geometry(assetA, [recordC], null)));
    await pending.promise;
  });
  await screen.findByRole('alert'); // the intentionally old get response is rejected
  expect(screen.queryByText(`synthetic:${recordC}`)).toBeNull();
});

it('never substitutes the first record when the requested window record is outside the bounded record search', async () => {
  const panes = await openComparison();
  fireEvent.click(
    panes.right.getAllByRole('button', {
      name: new RegExp(copy.selectRecord),
    })[1],
  );
  const ordinary = fetch.getMockImplementation()!;
  fetch.mockImplementation((url, init) =>
    requestUrl(url).endsWith('/records')
      ? json({
          ...records(),
          records: [{ ...records().records[0], recordId: recordC }],
          nextCursor: null,
        })
      : ordinary(url, init),
  );
  fireEvent.click(
    panes.right.getByRole('button', { name: "View this window's record" }),
  );
  await screen.findByText(copy.limitedSearch);
  expect(screen.getByRole('region', { name: 'Right window' })).toBeTruthy();
  expect(screen.queryByText(`original:${assetA}:${recordA}`)).toBeNull();
  expect(
    panes.right
      .getByRole('button', { name: copy.nextGeometry })
      .hasAttribute('disabled'),
  ).toBe(false);
});

it('retains the existing strict view validation rather than adding a comparison serialization loophole', () => {
  expect(
    CreateIngestionCandidateViewInputSchema.safeParse({
      title: 'Synthetic view',
      visibility: 'private',
      references: [reference],
      viewSpec: {
        page: { kind: 'geometry', reference, assetId: assetA, first: 50 },
        comparison: { left: assetA, right: assetB },
      },
    }).success,
  ).toBe(false);
});
