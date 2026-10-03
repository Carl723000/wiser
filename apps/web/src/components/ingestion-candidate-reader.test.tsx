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

const ref = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const assetId = '10000000-0000-4000-8000-000000000003';
const recordId = '10000000-0000-4000-8000-000000000004';
const otherId = '10000000-0000-4000-8000-000000000005';
const assets = {
  reference: ref,
  parserVersion: 'synthetic-fixture-v1',
  status: 'PARTIAL',
  createdAt: '2026-10-03T00:00:00Z',
  totalAssetCount: 2,
  knownRecordCount: 3,
  knownFeatureCount: 1,
  unknownAssetCount: 1,
  assets: [
    {
      assetId,
      sourceHash: 'b'.repeat(64),
      status: 'READY',
      recordCount: 3,
      featureCount: 1,
      reason: null,
    },
  ],
  nextCursor: 'next-assets',
};
const records = {
  reference: ref,
  assetId,
  columns: [
    { key: 'name', label: 'Water body' },
    { key: 'v', label: 'Original value' },
  ],
  records: [
    {
      recordId,
      assetId,
      index: 1,
      sourceId: 'table:1/row:1',
      hasGeometry: true,
      values: { name: 'Synthetic river', v: 0 },
    },
    {
      recordId: otherId,
      assetId,
      index: 2,
      sourceId: null,
      hasGeometry: false,
      values: { name: '', v: null },
    },
  ],
  nextCursor: null,
};
const geometry = {
  reference: ref,
  assetId,
  crs: 'EPSG:4326',
  features: [
    {
      recordId,
      assetId,
      index: 1,
      sourceId: 'table:1/row:1',
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
};
const fetch = vi.fn<typeof globalThis.fetch>();
vi.mock('./data-foundation-map', () => ({
  DataFoundationMap: ({
    onSelectRecord,
  }: {
    onSelectRecord?: (id: string) => void;
  }) => (
    <button onClick={() => onSelectRecord?.(recordId)}>
      Select mapped record
    </button>
  ),
}));
beforeEach(() => {
  vi.stubGlobal('fetch', fetch);
  fetch.mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith('/records')
        ? records
        : String(url).endsWith('/geometry')
          ? geometry
          : assets,
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('does not invent or query a candidate when intake has no completed candidate reference', () => {
  render(<IngestionCandidateReader reference={null} locale="en" />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Download original' })).toBeNull();
});
it('shows whole-batch known totals and unknown assets separately from loaded pages and independent observations', async () => {
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  await screen.findByRole('heading', { name: 'Candidate materials' });
  await screen.findByText('Partially parsed');
  expect(screen.getByText('Known parsed records')).toBeDefined();
  expect(screen.getByText('Unparsed originals')).toBeDefined();
  expect(screen.getByText('Independent observations')).toBeDefined();
  expect(screen.getByText('Not established')).toBeDefined();
  expect(
    screen
      .getByRole('link', { name: 'Download original' })
      .getAttribute('href'),
  ).toContain('/candidate-assets/');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('pages originals only on demand, passes the issued cursor and can return to the preceding page', async () => {
  fetch.mockImplementation(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    return Response.json(
      input.after
        ? {
            ...assets,
            assets: [{ ...assets.assets[0], assetId: otherId }],
            nextCursor: null,
          }
        : assets,
    );
  });
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  await screen.findByRole('link', { name: 'Download original' });
  fireEvent.click(screen.getByRole('button', { name: 'Next originals' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
    ...ref,
    after: 'next-assets',
    first: 50,
  });
  await screen.findByRole('button', { name: 'Previous originals' });
  fireEvent.click(screen.getByRole('button', { name: 'Previous originals' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).not.toHaveProperty(
    'after',
  );
});
it('preserves original zero, null, empty text and locator, using declared column labels', async () => {
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  await screen.findByRole('button', { name: 'Read records' });
  fireEvent.click(screen.getByRole('button', { name: 'Read records' }));
  await screen.findByRole('columnheader', { name: 'Water body' });
  expect(screen.getByText('Synthetic river')).toBeDefined();
  expect(screen.getByText('0')).toBeDefined();
  expect(screen.getByText('No value (null)')).toBeDefined();
  expect(screen.getByText('Empty text')).toBeDefined();
  expect(screen.getByText('table:1/row:1')).toBeDefined();
});
it('clears all loaded candidate content and original links when current access is denied', async () => {
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Read records' }));
  await screen.findByText('Synthetic river');
  fetch.mockResolvedValueOnce(new Response('secret error', { status: 403 }));
  fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Synthetic river')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Download original' })).toBeNull();
  expect(screen.getByRole('alert').textContent).not.toContain('secret error');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('link', { name: 'Download original' });
});
it('aborts and ignores an earlier reference reply after the intake reference changes', async () => {
  let reply!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      }),
  );
  const { rerender } = render(
    <IngestionCandidateReader reference={ref} locale="en" />,
  );
  const updated = { ...ref, reviewHash: 'c'.repeat(64) };
  fetch.mockResolvedValueOnce(
    Response.json({
      ...assets,
      reference: updated,
      status: 'READY',
      unknownAssetCount: 0,
      knownRecordCount: 8,
    }),
  );
  rerender(<IngestionCandidateReader reference={updated} locale="en" />);
  await screen.findByText('8');
  await act(async () => reply(Response.json(assets)));
  expect(screen.queryByText('Partially parsed')).toBeNull();
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it('returns from a selected native geometry to its actual parsed record without creating a published identity', async () => {
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Read records' }));
  await screen.findByText('Synthetic river');
  fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Select mapped record' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'View selected record' }));
  await screen.findByText('Synthetic river');
  expect(
    screen.getByRole('tab', { name: 'Records' }).getAttribute('aria-selected'),
  ).toBe('true');
  for (const call of fetch.mock.calls)
    expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty('versionId');
});
it('keeps reading mounted during full-workspace expansion and restores the toggle after Escape', async () => {
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  await screen.findByRole('link', { name: 'Download original' });
  const before = fetch.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Expand workspace' }));
  const dialog = screen.getByRole('dialog', { name: 'Candidate materials' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fetch.mock.calls.length).toBe(before);
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Expand workspace' }),
  );
});
it.each(['en', 'zh-CN'] as const)(
  'shows pending review and accessible optional help in %s',
  async (locale) => {
    render(<IngestionCandidateReader reference={ref} locale={locale} />);
    await screen.findByText(locale === 'en' ? 'Partially parsed' : '部分解析');
    expect(
      screen.getByText(
        locale === 'en' ? 'Pending independent review' : '待独立审核',
      ),
    ).toBeDefined();
    const help = screen.getByRole('button', {
      name: locale === 'en' ? 'Counting definitions' : '计数口径',
    });
    fireEvent.click(help);
    expect(help.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(help, { key: 'Escape' });
    expect(help.getAttribute('aria-expanded')).toBe('false');
  },
);
