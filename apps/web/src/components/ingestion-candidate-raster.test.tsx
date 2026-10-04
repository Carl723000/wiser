// @vitest-environment jsdom
import {
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
