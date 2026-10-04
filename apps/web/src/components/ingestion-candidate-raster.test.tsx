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
  RETAINED_RASTER_HASHES,
  type CandidateRasterWindowResult,
} from '@/lib/candidate-raster-window';
import { readCandidateRasterWindow } from '@/lib/candidate-raster-original-reader';
import { CandidateReaderError } from '@/lib/ingestion-candidate-reader';
import { IngestionCandidateReader } from './ingestion-candidate-reader';

vi.mock('@/lib/candidate-raster-original-reader', () => ({
  readCandidateRasterWindow: vi.fn(),
}));
vi.mock('./data-foundation-map', () => ({
  DataFoundationMap: () => null,
}));

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: 'a0000000-0000-4000-8000-000000000001',
  processingBatchId: 'a0000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const changedReference = { ...reference, reviewHash: 'b'.repeat(64) };
const viewId = 'a0000000-0000-4000-8000-000000000099';
const savedView = {
  kind: 'ingestion-candidate-view',
  viewId,
  title: 'Fixed raster view',
  visibility: 'private',
  createdAt: '2026-10-03T00:00:00Z',
  revokedAt: null,
};
const openedView = {
  kind: 'ingestion-candidate-view',
  savedView,
  references: [reference],
  viewSpec: { page: { kind: 'assets', reference, first: 50 } },
  request: {
    capabilityId: 'data.ingestion.candidate.get',
    input: { ...reference, first: 50 },
  },
};
const bands = ['B03', 'B8A', 'SCL', 'TCI'] as const;
const assets = bands.map((band, index) => ({
  assetId: `a0000000-0000-4000-8000-00000000001${index}`,
  sourceHash: RETAINED_RASTER_HASHES[band],
  status: 'UNSUPPORTED' as const,
  recordCount: null,
  featureCount: null,
  reason: 'UNSUPPORTED_FORMAT',
}));
const cursors = ['raster-page-1', 'raster-page-2', 'raster-page-3'];
const fetchMock = vi.fn<typeof globalThis.fetch>();
const rasterRead = vi.mocked(readCandidateRasterWindow);

function requestUrl(url: RequestInfo | URL): string {
  return typeof url === 'string'
    ? url
    : url instanceof URL
      ? url.href
      : url.url;
}
function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request');
  return JSON.parse(init.body) as Record<string, unknown>;
}
function page(index: number, changed = false) {
  return {
    reference: changed ? changedReference : reference,
    parserVersion: 'synthetic-raster-v1',
    status: 'UNAVAILABLE',
    createdAt: '2026-10-03T00:00:00Z',
    totalAssetCount: changed ? 1 : 4,
    knownRecordCount: 0,
    knownFeatureCount: 0,
    unknownAssetCount: changed ? 1 : 4,
    assets: changed
      ? [{ ...assets[0], sourceHash: 'f'.repeat(64) }]
      : [assets[index]],
    nextCursor: changed ? null : (cursors[index] ?? null),
  };
}
function result(window: {
  row: number;
  column: number;
  rows: number;
  columns: number;
}): CandidateRasterWindowResult {
  const count = window.rows * window.columns;
  return {
    window,
    crs: 'EPSG:32650',
    affine: [20, 0, 385180, 0, -20, 4481920],
    values: {
      B03: new Uint16Array(count).fill(1713),
      B8A: new Uint16Array(count).fill(1204),
      SCL: new Uint8Array(count).fill(6),
      TCI: [
        new Uint8Array(count).fill(43),
        new Uint8Array(count).fill(72),
        new Uint8Array(count).fill(45),
      ],
    },
    validMask: new Uint8Array(count).fill(255),
    qualityMask: new Uint8Array(count).fill(1),
    quality: { kind: 'raw' },
    sourceProduct: 'fixed-retained-scene',
    sensingTime: '2026-08-24T03:05:19Z',
  };
}
function formWindow(
  row: number,
  column: number,
  rows: number,
  columns: number,
) {
  fireEvent.change(
    screen.getByRole('spinbutton', { name: 'Native row (0-based)' }),
    {
      target: { value: String(row) },
    },
  );
  fireEvent.change(
    screen.getByRole('spinbutton', { name: 'Native column (0-based)' }),
    {
      target: { value: String(column) },
    },
  );
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Window rows' }), {
    target: { value: String(rows) },
  });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Window columns' }), {
    target: { value: String(columns) },
  });
}
async function openInspector() {
  await screen.findByRole('link', { name: 'Download original' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect native raster' }),
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((_url, init) => {
    const input = requestBody(init);
    const changed = input.reviewHash === changedReference.reviewHash;
    const index =
      typeof input.after === 'string' ? cursors.indexOf(input.after) + 1 : 0;
    return Promise.resolve(Response.json(page(index, changed)));
  });
  rasterRead.mockImplementation((input) =>
    Promise.resolve(result(input.window)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('collects four distinct authorized asset pages and reads this selection in native row/column coordinates', async () => {
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  formWindow(650, 535, 19, 23);
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await waitFor(() => expect(rasterRead).toHaveBeenCalledTimes(1));
  const [input, signal] = rasterRead.mock.calls[0];
  expect(input).toMatchObject({
    reference,
    locale: 'en',
    assets: bands.map((band, index) => ({
      band,
      assetId: assets[index].assetId,
      sha256: RETAINED_RASTER_HASHES[band],
    })),
    window: { row: 650, column: 535, rows: 19, columns: 23 },
    quality: { kind: 'raw' },
  });
  expect(signal.aborted).toBe(false);
  const pageReads = fetchMock.mock.calls
    .filter(([url]) => requestUrl(url).endsWith('/candidates/get'))
    .map(([, init]) => requestBody(init));
  expect(pageReads.slice(-4).map((item) => item.after ?? null)).toEqual([
    null,
    cursors[0],
    cursors[1],
    cursors[2],
  ]);
  for (const pageRead of pageReads) expect(pageRead).toMatchObject(reference);
  const values = await screen.findByTestId('candidate-raster-window-values');
  expect(values.textContent).toContain('1713');
  expect(values.textContent).toContain('EPSG:32650');
  expect(screen.queryByText('Published version')).toBeNull();
});

it('clears returned pixels and candidate links when a fresh raster read is denied', async () => {
  rasterRead.mockResolvedValueOnce(
    result({ row: 77, column: 318, rows: 1, columns: 1 }),
  );
  rasterRead.mockRejectedValueOnce(new CandidateReaderError('denied'));
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  formWindow(77, 318, 1, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  expect(
    (await screen.findByTestId('candidate-raster-window-values')).textContent,
  ).toContain('1713');
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await screen.findByRole('alert');
  expect(screen.queryByTestId('candidate-raster-window-values')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Download original' })).toBeNull();
});

it('cancels an in-flight decode and discards late pixels when the fixed candidate changes', async () => {
  let finish!: (value: CandidateRasterWindowResult) => void;
  rasterRead.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { rerender } = render(
    <IngestionCandidateReader reference={reference} locale="en" />,
  );
  await openInspector();
  formWindow(77, 318, 1, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await waitFor(() => expect(rasterRead).toHaveBeenCalledTimes(1));
  const signal = rasterRead.mock.calls[0][1];
  rerender(
    <IngestionCandidateReader reference={changedReference} locale="en" />,
  );
  await waitFor(() => expect(signal.aborted).toBe(true));
  finish(result({ row: 77, column: 318, rows: 1, columns: 1 }));
  await screen.findByRole('link', { name: 'Download original' });
  expect(screen.queryByTestId('candidate-raster-window-values')).toBeNull();
  expect(rasterRead).toHaveBeenCalledTimes(1);
});

it('terminates its selection on unmount and never infers a candidate from local preview files', async () => {
  render(<IngestionCandidateReader reference={null} locale="en" />);
  expect(
    screen.queryByRole('button', { name: 'Inspect native raster' }),
  ).toBeNull();
  expect(rasterRead).not.toHaveBeenCalled();
  cleanup();
  rasterRead.mockImplementationOnce(
    () => new Promise<CandidateRasterWindowResult>(() => {}),
  );
  const mounted = render(
    <IngestionCandidateReader reference={reference} locale="en" />,
  );
  await openInspector();
  formWindow(77, 318, 1, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await waitFor(() => expect(rasterRead).toHaveBeenCalledTimes(1));
  const signal = rasterRead.mock.calls[0][1];
  mounted.unmount();
  expect(signal.aborted).toBe(true);
});

it('does not read any pixels from a complete but ambiguous four-product asset listing', async () => {
  fetchMock.mockImplementation((_url, init) => {
    const input = requestBody(init);
    const index =
      typeof input.after === 'string' ? cursors.indexOf(input.after) + 1 : 0;
    const current = page(index);
    return Promise.resolve(
      Response.json({
        ...current,
        assets:
          index === 1
            ? [{ ...assets[1], sourceHash: RETAINED_RASTER_HASHES.B03 }]
            : current.assets,
      }),
    );
  });
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await screen.findByRole('alert');
  expect(rasterRead).not.toHaveBeenCalled();
  expect(screen.queryByTestId('candidate-raster-window-values')).toBeNull();
});

it('refuses repeated cursors before handing a partial asset listing to the raster reader', async () => {
  fetchMock.mockImplementation((_url, init) => {
    const input = requestBody(init);
    const index =
      typeof input.after === 'string' ? cursors.indexOf(input.after) + 1 : 0;
    return Promise.resolve(
      Response.json({
        ...page(index),
        nextCursor: index === 2 ? cursors[0] : page(index).nextCursor,
      }),
    );
  });
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await screen.findByRole('alert');
  expect(rasterRead).not.toHaveBeenCalled();
  expect(screen.queryByTestId('candidate-raster-window-values')).toBeNull();
});

it('refuses a completed asset listing that lacks one of the four fixed originals', async () => {
  fetchMock.mockImplementation((_url, init) => {
    const input = requestBody(init);
    const index =
      typeof input.after === 'string' ? cursors.indexOf(input.after) + 1 : 0;
    const current = page(index);
    return Promise.resolve(
      Response.json({
        ...current,
        assets:
          index === 3
            ? [{ ...assets[3], sourceHash: 'f'.repeat(64) }]
            : current.assets,
      }),
    );
  });
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await screen.findByRole('alert');
  expect(rasterRead).not.toHaveBeenCalled();
  expect(screen.queryByTestId('candidate-raster-window-values')).toBeNull();
});

it('aborts a manual read, removes its pixels and permits a fresh bounded selection', async () => {
  let finish!: (value: CandidateRasterWindowResult) => void;
  rasterRead.mockImplementationOnce(
    () =>
      new Promise<CandidateRasterWindowResult>((resolve) => {
        finish = resolve;
      }),
  );
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await waitFor(() => expect(rasterRead).toHaveBeenCalledTimes(1));
  const signal = rasterRead.mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'Cancel read' }));
  expect(signal.aborted).toBe(true);
  finish(result({ row: 0, column: 0, rows: 1, columns: 1 }));
  await Promise.resolve();
  expect(screen.queryByTestId('candidate-raster-window-values')).toBeNull();
  formWindow(77, 318, 1, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  expect(
    (await screen.findByTestId('candidate-raster-window-values')).textContent,
  ).toContain('1713');
  expect(rasterRead).toHaveBeenCalledTimes(2);
});

it('keeps the old candidate raster inactive during a pending parent refresh', async () => {
  let release!: (response: Response) => void;
  let gets = 0;
  fetchMock.mockImplementation((_url, init) => {
    const input = requestBody(init);
    const index =
      typeof input.after === 'string' ? cursors.indexOf(input.after) + 1 : 0;
    gets++;
    if (gets === 2)
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return Promise.resolve(Response.json(page(index)));
  });
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await screen.findByRole('link', { name: 'Download original' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh candidate' }));
  await waitFor(() => expect(gets).toBe(2));
  const inspector = screen.getByRole('button', {
    name: 'Inspect native raster',
  });
  expect(inspector.hasAttribute('disabled')).toBe(true);
  fireEvent.click(inspector);
  expect(rasterRead).not.toHaveBeenCalled();
  act(() => release(Response.json(page(0))));
  await screen.findByRole('link', { name: 'Download original' });
});

it('waits for a saved-view change and sends only the new fixed view to pixel reading', async () => {
  let releaseOpen!: (response: Response) => void;
  let opens = 0;
  fetchMock.mockImplementation((url, init) => {
    const path = requestUrl(url);
    if (path.endsWith('/list'))
      return Promise.resolve(
        Response.json({ items: [savedView], nextCursor: null }),
      );
    if (path.endsWith('/open')) {
      opens++;
      return opens === 1
        ? new Promise<Response>((resolve) => {
            releaseOpen = resolve;
          })
        : Promise.resolve(Response.json(openedView));
    }
    const input = requestBody(init);
    const index =
      typeof input.after === 'string' ? cursors.indexOf(input.after) + 1 : 0;
    return Promise.resolve(Response.json(page(index)));
  });
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await screen.findByRole('link', { name: 'Download original' });
  fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
  await screen.findByText(savedView.title);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen view' }));
  await waitFor(() => expect(opens).toBe(1));
  expect(
    screen
      .getByRole('button', { name: 'Inspect native raster' })
      .hasAttribute('disabled'),
  ).toBe(true);
  act(() => releaseOpen(Response.json(openedView)));
  await waitFor(() =>
    expect(
      screen
        .getByRole('link', { name: 'Download original' })
        .getAttribute('href'),
    ).toContain(`savedViewId=${viewId}`),
  );
  await openInspector();
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await waitFor(() => expect(rasterRead).toHaveBeenCalledTimes(1));
  expect(rasterRead.mock.calls[0][0].savedViewId).toBe(viewId);
});

it('aborts the old decode and discards its late reply on a parent refresh', async () => {
  let finish!: (value: CandidateRasterWindowResult) => void;
  rasterRead.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await waitFor(() => expect(rasterRead).toHaveBeenCalledTimes(1));
  const signal = rasterRead.mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh candidate' }));
  expect(signal.aborted).toBe(true);
  finish(result({ row: 0, column: 0, rows: 1, columns: 1 }));
  await screen.findByRole('link', { name: 'Download original' });
  expect(screen.queryByTestId('candidate-raster-window-values')).toBeNull();
});

it('bounds complete-asset discovery within the same user selection deadline', async () => {
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
    await act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole('alert').textContent).toContain(
      'temporarily unavailable',
    );
    expect(rasterRead).not.toHaveBeenCalled();
    expect(screen.queryByTestId('candidate-raster-window-values')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('shows explicit SCL selection, fixed-mask basis, joint counts and projected grid area without inferring water area', async () => {
  rasterRead.mockImplementation((input) => {
    const base = result(input.window);
    return Promise.resolve({
      ...base,
      quality: input.quality,
      values: {
        ...base.values,
        B03: Uint16Array.of(0, 1713, 1200, 1300),
        SCL: Uint8Array.of(0, 4, 9, 6),
      },
      validMask: Uint8Array.of(255, 255, 255, 255),
      qualityMask: Uint8Array.of(1, 1, 0, 0),
    });
  });
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  formWindow(650, 535, 2, 2);
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Quality selection' }),
    {
      target: { value: 'scl-classes' },
    },
  );
  fireEvent.change(
    screen.getByRole('textbox', {
      name: 'Allowed SCL classes (0–11, comma-separated)',
    }),
    { target: { value: '0,4' } },
  );
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Quality rule version' }),
    { target: { value: 'scl-user-v1' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  await waitFor(() => expect(rasterRead).toHaveBeenCalledTimes(1));
  expect(rasterRead.mock.calls[0][0].quality).toEqual({
    kind: 'scl-classes',
    allowedClasses: [0, 4],
    ruleVersion: 'scl-user-v1',
  });
  const values = await screen.findByTestId('candidate-raster-window-values');
  expect(values.textContent).toContain('Rasterio');
  expect(values.textContent).toContain('all_valid');
  expect(values.textContent).toContain('Original-mask valid cells: 4');
  expect(values.textContent).toContain('Joint included cells: 2');
  expect(values.textContent).toContain('Excluded cells: 2');
  expect(values.textContent).toContain('400 m²');
  expect(values.textContent).toContain('800 m²');
  expect(values.textContent).toContain('not measured water area');
});

it('rejects an unversioned or duplicated SCL class selection before reading originals', async () => {
  render(<IngestionCandidateReader reference={reference} locale="en" />);
  await openInspector();
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Quality selection' }),
    {
      target: { value: 'scl-classes' },
    },
  );
  fireEvent.change(
    screen.getByRole('textbox', {
      name: 'Allowed SCL classes (0–11, comma-separated)',
    }),
    { target: { value: '4,4' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Read native window' }));
  expect(screen.getByRole('alert').textContent).toContain('integer window');
  expect(rasterRead).not.toHaveBeenCalled();
});
