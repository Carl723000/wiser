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
import { CreateIngestionCandidateViewInputSchema } from '@wiser/data-contracts';
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
function requestUrl(url: RequestInfo | URL): string {
  return typeof url === 'string'
    ? url
    : url instanceof URL
      ? url.href
      : url.url;
}
function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string')
    throw new Error('Expected a JSON string request');
  const value: unknown = JSON.parse(init.body);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object request');
  return value as Record<string, unknown>;
}
const respondJson = (value: unknown): Promise<Response> =>
  Promise.resolve(Response.json(value));
const fetch = vi.fn<typeof globalThis.fetch>();

it.each([403, 409])(
  'derives processing facts only from this authorized owner and clears facts with content on %s',
  async (status) => {
    render(<IngestionCandidateReader reference={ref} locale="en" />);
    await screen.findByRole('button', { name: 'Read records' });
    fireEvent.click(screen.getByRole('button', { name: 'Read records' }));
    await screen.findByText('Synthetic river');
    const facts = within(
      screen.getByRole('region', { name: 'Processing facts' }),
    );
    expect(
      facts.getByText('Records on this page').nextElementSibling?.textContent,
    ).toBe('2');
    expect(facts.getByText('Known parsed records')).toBeDefined();
    expect(facts.getByText('3')).toBeDefined();
    expect(facts.getByText('Water body')).toBeDefined();
    expect(facts.getByText('Original value')).toBeDefined();
    expect(facts.getByText('synthetic-fixture-v1')).toBeDefined();
    expect(
      facts.getByText(
        'Cleaning responsibility is not recorded in this reading scope.',
      ),
    ).toBeDefined();
    expect(
      facts.getByText(
        'Human quality-control responsibility is not recorded in this reading scope.',
      ),
    ).toBeDefined();
    expect(
      facts.getByText('Spatial records on this page').nextElementSibling
        ?.textContent,
    ).toBe('Not read yet');
    fetch.mockResolvedValueOnce(
      new Response('private denied body', { status }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('region', { name: 'Processing facts' }),
    ).toBeNull();
    expect(screen.queryByText('synthetic-fixture-v1')).toBeNull();
  },
);
it('uses the same reader for current workspace reading without saved-view actions or reads', async () => {
  render(<IngestionCandidateReader reference={ref} locale="en" readOnly />);
  await screen.findByRole('button', { name: 'Read records' });
  expect(
    screen.queryByRole('region', { name: 'Fixed reading view' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load saved views' })).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/data-foundation/candidates/get');
});
it('cannot enter saved reading through a readonly owner even when a saved identifier is supplied', async () => {
  render(
    <IngestionCandidateReader
      reference={ref}
      locale="en"
      readOnly
      savedViewId="10000000-0000-4000-8000-000000000009"
    />,
  );
  await screen.findByRole('button', { name: 'Read records' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/data-foundation/candidates/get');
  expect(requestBody(fetch.mock.calls[0]?.[1])).toMatchObject(ref);
});
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
  fetch.mockImplementation((url) =>
    respondJson(
      requestUrl(url).endsWith('/records')
        ? records
        : requestUrl(url).endsWith('/geometry')
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
  fetch.mockImplementation((_url, init) => {
    const input = requestBody(init);
    return respondJson(
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
  expect(requestBody(fetch.mock.calls[1]?.[1])).toMatchObject({
    ...ref,
    after: 'next-assets',
    first: 50,
  });
  await screen.findByRole('button', { name: 'Previous originals' });
  fireEvent.click(screen.getByRole('button', { name: 'Previous originals' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(requestBody(fetch.mock.calls[2]?.[1])).not.toHaveProperty('after');
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
  // Switch identities only after the original request really became in-flight.
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const updated = { ...ref, reviewHash: 'c'.repeat(64) };
  fetch.mockResolvedValueOnce(
    Response.json({
      ...assets,
      reference: updated,
      status: 'READY',
      unknownAssetCount: 0,
      knownRecordCount: 8,
      parserVersion: 'current-owner-parser',
    }),
  );
  rerender(<IngestionCandidateReader reference={updated} locale="en" />);
  await screen.findByText('8');
  await act(() => Promise.resolve(reply(Response.json(assets))));
  expect(screen.queryByText('Partially parsed')).toBeNull();
  const facts = within(
    screen.getByRole('region', { name: 'Processing facts' }),
  );
  expect(facts.getByText('current-owner-parser')).toBeDefined();
  expect(facts.queryByText('synthetic-fixture-v1')).toBeNull();
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
    expect(requestBody(call[1])).not.toHaveProperty('versionId');
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

const viewId = '10000000-0000-4000-8000-000000000009';
const savedView = {
  kind: 'ingestion-candidate-view',
  viewId,
  title: 'Synthetic fixed view',
  visibility: 'private',
  createdAt: '2026-10-03T00:00:00Z',
  revokedAt: null,
};
const opened = {
  kind: 'ingestion-candidate-view',
  savedView,
  references: [ref],
  viewSpec: {
    page: { kind: 'records', reference: ref, assetId, first: 50 },
    focus: { reference: ref, assetId, recordId },
  },
  request: {
    capabilityId: 'data.ingestion.candidate.records',
    input: { ...ref, assetId, first: 50 },
  },
};
it.each(['Records', 'Originals'] as const)(
  'retains the saved manifest identity on original links from the %s pane',
  async (pane) => {
    fetch.mockImplementation((url) =>
      respondJson(
        requestUrl(url).endsWith('/open')
          ? opened
          : requestUrl(url).endsWith('/records')
            ? records
            : assets,
      ),
    );
    render(
      <IngestionCandidateReader
        reference={null}
        ingestionId={ref.ingestionId}
        savedViewId={viewId}
        locale="en"
      />,
    );
    await screen.findByText('Synthetic river');
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Refresh candidate' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    if (pane === 'Originals')
      fireEvent.click(screen.getByRole('tab', { name: pane }));
    const originals = await screen.findAllByRole('link', {
      name: 'Download original',
    });
    for (const original of originals) {
      expect(original.getAttribute('href')).toContain(`savedViewId=${viewId}`);
      expect(original.getAttribute('href')).toContain(ref.processingBatchId);
      expect(original.getAttribute('href')).toContain(ref.reviewHash);
    }
  },
);
it('creates a real saved view and restores its server request and selected record on reopen', async () => {
  fetch.mockImplementation((url) =>
    respondJson(
      requestUrl(url).endsWith('/create')
        ? { savedView }
        : requestUrl(url).endsWith('/list')
          ? { items: [savedView], nextCursor: null }
          : requestUrl(url).endsWith('/open')
            ? opened
            : requestUrl(url).endsWith('/records')
              ? records
              : assets,
    ),
  );
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Read records' }));
  await screen.findByText('Synthetic river');
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), {
    target: { value: savedView.title },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
  await screen.findByText('View saved.');
  const createCall = fetch.mock.calls.find(([url]) =>
    requestUrl(url).endsWith('/create'),
  );
  expect(requestBody(createCall?.[1])).toMatchObject({
    references: [ref],
    viewSpec: { page: { kind: 'records', reference: ref, assetId, first: 50 } },
  });
  expect(createCall?.[1]?.headers).toHaveProperty('Idempotency-Key');
  fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
  await screen.findByText(savedView.title);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen view' }));
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Select record 1' })
        .getAttribute('aria-pressed'),
    ).toBe('true'),
  );
  expect(
    screen.getByRole('tab', { name: 'Records' }).getAttribute('aria-selected'),
  ).toBe('true');
});
it('clears loaded candidate content and saved titles when full-manifest access fails after a reopen read', async () => {
  let opens = 0;
  fetch.mockImplementation((url) => {
    if (requestUrl(url).endsWith('/open')) {
      opens++;
      return opens === 1
        ? respondJson(opened)
        : Promise.resolve(
            new Response('private denied detail', { status: 403 }),
          );
    }
    return respondJson(
      requestUrl(url).endsWith('/list')
        ? { items: [savedView], nextCursor: null }
        : requestUrl(url).endsWith('/records')
          ? records
          : assets,
    );
  });
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  await screen.findByRole('link', { name: 'Download original' });
  fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
  await screen.findByText(savedView.title);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen view' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Synthetic river')).toBeNull();
  expect(screen.queryByText(savedView.title)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Download original' })).toBeNull();
});

it('retries a denied saved view through the full-manifest open action before any new material read', async () => {
  let permitted = true;
  fetch.mockImplementation((url) => {
    if (requestUrl(url).endsWith('/open'))
      return permitted
        ? respondJson(opened)
        : Promise.resolve(new Response(null, { status: 403 }));
    return respondJson(
      requestUrl(url).endsWith('/list')
        ? { items: [savedView], nextCursor: null }
        : requestUrl(url).endsWith('/records')
          ? records
          : assets,
    );
  });
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  await screen.findByRole('link', { name: 'Download original' });
  fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
  await screen.findByText(savedView.title);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen view' }));
  await screen.findByText('Synthetic river');
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Refresh candidate' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  permitted = false;
  fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
  await screen.findByRole('alert');
  const before = fetch.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  expect(fetch.mock.calls[before]?.[0]).toBe(
    '/api/data-foundation/candidate-saved-views/open',
  );
  expect(screen.queryByText('Synthetic river')).toBeNull();
});

it('refreshes the same frozen candidate after opening an older batch instead of mixing current original links', async () => {
  const oldRef = {
    ...ref,
    processingBatchId: '10000000-0000-4000-8000-000000000012',
    reviewHash: 'd'.repeat(64),
  };
  const oldOpened = {
    ...opened,
    references: [oldRef],
    viewSpec: {
      page: { kind: 'records', reference: oldRef, assetId, first: 50 },
    },
    request: {
      capabilityId: 'data.ingestion.candidate.records',
      input: { ...oldRef, assetId, first: 50 },
    },
  };
  fetch.mockImplementation((url, init) => {
    if (requestUrl(url).endsWith('/list'))
      return respondJson({ items: [savedView], nextCursor: null });
    if (requestUrl(url).endsWith('/open')) return respondJson(oldOpened);
    const input = requestBody(init);
    const reference = input.reviewHash === oldRef.reviewHash ? oldRef : ref;
    return respondJson(
      requestUrl(url).endsWith('/records')
        ? { ...records, reference }
        : { ...assets, reference },
    );
  });
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  await screen.findByRole('link', { name: 'Download original' });
  fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
  await screen.findByText(savedView.title);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen view' }));
  await screen.findByText('Synthetic river');
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Refresh candidate' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh candidate' }));
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Refresh candidate' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Originals' }));
  const original = await screen.findByRole('link', {
    name: 'Download original',
  });
  expect(original.getAttribute('href')).toContain(oldRef.processingBatchId);
  expect(original.getAttribute('href')).toContain(oldRef.reviewHash);
});

it('reopens a server-authorized persisted view even when the current detail has no candidate reference', async () => {
  fetch.mockImplementation((url) =>
    respondJson(
      requestUrl(url).endsWith('/open')
        ? opened
        : requestUrl(url).endsWith('/records')
          ? records
          : assets,
    ),
  );
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={ref.ingestionId}
      savedViewId={viewId}
      locale="en"
    />,
  );
  await screen.findByText('Synthetic river');
  expect(fetch.mock.calls[0]?.[0]).toBe(
    '/api/data-foundation/candidate-saved-views/open',
  );
  expect(
    requestBody(
      fetch.mock.calls.find(([url]) =>
        requestUrl(url).endsWith('/records'),
      )?.[1],
    ),
  ).toEqual(opened.request.input);
});

it('does not read candidate material when the persisted view belongs to a different intake route', async () => {
  fetch.mockResolvedValue(Response.json(opened));
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={otherId}
      savedViewId={viewId}
      locale="en"
    />,
  );
  await screen.findByRole('alert');
  expect(
    fetch.mock.calls.every(([url]) => requestUrl(url).endsWith('/open')),
  ).toBe(true);
});

it('uses the restored page size and newly issued cursor for the next saved-view page', async () => {
  const resized = {
    ...opened,
    viewSpec: { page: { kind: 'records', reference: ref, assetId, first: 1 } },
    request: {
      capabilityId: 'data.ingestion.candidate.records',
      input: { ...ref, assetId, first: 1 },
    },
  };
  fetch.mockImplementation((url, init) => {
    if (requestUrl(url).endsWith('/open')) return respondJson(resized);
    if (requestUrl(url).endsWith('/records'))
      return respondJson({
        ...records,
        records: [records.records[0]],
        nextCursor: requestBody(init).after ? null : 'fresh-saved-cursor',
      });
    return respondJson(assets);
  });
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={ref.ingestionId}
      savedViewId={viewId}
      locale="en"
    />,
  );
  await screen.findByText('Synthetic river');
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Next records' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          requestUrl(url).endsWith('/records') &&
          requestBody(init).after === 'fresh-saved-cursor',
      ),
    ).toBe(true),
  );
  const call = fetch.mock.calls.find(
    ([url, init]) =>
      requestUrl(url).endsWith('/records') && requestBody(init).after,
  );
  expect(requestBody(call?.[1])).toEqual({
    ...ref,
    assetId,
    first: 1,
    after: 'fresh-saved-cursor',
  });
});

it('creates a fixed page anchor instead of persisting the opaque current cursor', async () => {
  fetch.mockImplementation((url, init) => {
    if (requestUrl(url).endsWith('/create')) return respondJson({ savedView });
    const input = requestBody(init);
    return respondJson(
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
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Load saved views' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), {
    target: { value: savedView.title },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
  await screen.findByText('View saved.');
  const input = CreateIngestionCandidateViewInputSchema.parse(
    requestBody(
      fetch.mock.calls.find(([url]) =>
        requestUrl(url).endsWith('/create'),
      )?.[1],
    ),
  );
  expect(input.viewSpec.page).toEqual({
    kind: 'assets',
    reference: ref,
    first: 50,
    afterAssetId: assetId,
  });
  expect(JSON.stringify(input)).not.toContain('next-assets');
});

it('revokes the active saved view through the server and removes its loaded content', async () => {
  fetch.mockImplementation((url) =>
    respondJson(
      requestUrl(url).endsWith('/open')
        ? opened
        : requestUrl(url).endsWith('/list')
          ? { items: [savedView], nextCursor: null }
          : requestUrl(url).endsWith('/revoke')
            ? { viewId, revoked: true }
            : requestUrl(url).endsWith('/records')
              ? records
              : assets,
    ),
  );
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={ref.ingestionId}
      savedViewId={viewId}
      locale="en"
    />,
  );
  await screen.findByText('Synthetic river');
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Load saved views' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
  await screen.findByText(savedView.title);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke view' }));
  await screen.findByText('View revoked.');
  expect(screen.queryByText('Synthetic river')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Download original' })).toBeNull();
  expect(
    fetch.mock.calls.find(([url]) => requestUrl(url).endsWith('/revoke'))?.[1]
      ?.headers,
  ).toHaveProperty('Idempotency-Key');
});

const topicOpened = {
  status: 'READABLE',
  specVersion: 2,
  savedView: {
    ...savedView,
    specVersion: 2,
    title: 'Synthetic complete topic',
  },
  references: [ref],
  viewSpec: {
    schemaVersion: 2,
    ...opened.viewSpec,
    period: {
      timeRole: 'REPORT_PERIOD',
      windowMode: 'month',
      from: '2026-09',
      to: '2026-09',
      displayUnit: 'month',
      includeUndated: false,
    },
    topic: {
      question: 'Synthetic question retained exactly',
      regionIds: ['synthetic-region'],
      needIds: ['synthetic-need'],
      recordPins: [{ reference: ref, assetId, recordId }],
    },
    rulePins: ['projection', 'readiness', 'requirement', 'impact'].map(
      (kind) => ({ kind, ruleId: `synthetic-${kind}`, version: 'synthetic/1' }),
    ),
    dependencyPins: [
      {
        kind: 'asset',
        reference: ref,
        assetId,
        sourceHash: 'b'.repeat(64),
        parserVersion: 'synthetic-fixture-v1',
      },
      {
        kind: 'record',
        reference: ref,
        assetId,
        recordId,
        sourceHash: 'b'.repeat(64),
        parserVersion: 'synthetic-fixture-v1',
        recordHash: 'c'.repeat(64),
      },
    ],
    relationPins: [],
  },
  request: {
    ...opened.request,
    input: { ...ref, assetId, first: 2, after: 'topic-resume' },
  },
};
function topicResponses(url: RequestInfo | URL) {
  const path = requestUrl(url);
  if (path === '/api/data-foundation/candidate-topics/open')
    return respondJson(topicOpened);
  if (path === '/api/data-foundation/candidate-topics/list')
    return respondJson({
      items: [{ ...savedView, specVersion: 1 }, topicOpened.savedView],
      nextCursor: null,
    });
  if (path === '/api/data-foundation/candidates/records')
    return respondJson(records);
  if (path === '/api/data-foundation/candidates/geometry')
    return respondJson(geometry);
  if (path === '/api/data-foundation/candidates/get')
    return respondJson(assets);
  throw new Error('Unexpected topic transport');
}
it('restores the complete topic from its authorized request with no current candidate and never downgrades originals or saving', async () => {
  fetch.mockImplementation(topicResponses);
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={ref.ingestionId}
      savedTopicId={viewId}
      locale="en"
    />,
  );
  await screen.findByText('Synthetic river');
  expect(screen.getByText(topicOpened.savedView.title)).toBeDefined();
  expect(screen.getByText(topicOpened.viewSpec.topic.question)).toBeDefined();
  const materialRead = fetch.mock.calls.find(
    ([url]) => requestUrl(url) === '/api/data-foundation/candidates/records',
  );
  expect(requestBody(materialRead?.[1])).toEqual(topicOpened.request.input);
  expect(
    screen
      .getByRole('button', { name: 'Select record 1' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Revoke view' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Download original' })).toBeNull();
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Refresh candidate' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Originals' }));
  await screen.findByRole('button', { name: 'Read records' });
  expect(screen.queryByRole('link', { name: 'Download original' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Read native raster' }),
  ).toBeNull();
  expect(
    fetch.mock.calls.every(
      ([url]) =>
        !requestUrl(url).includes('candidate-saved-views') &&
        !requestUrl(url).includes('candidate-assets'),
    ),
  ).toBe(true);
});
it('lists actual mixed-version topics and opens v2 through the topic ability; UNAVAILABLE clears titles, counts, references and material', async () => {
  let available = true;
  fetch.mockImplementation((url) =>
    requestUrl(url) === '/api/data-foundation/candidate-topics/open' &&
    !available
      ? respondJson({ status: 'UNAVAILABLE', viewId })
      : topicResponses(url),
  );
  render(<IngestionCandidateReader reference={ref} locale="en" />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Load saved topics' }),
  );
  await screen.findByText('Synthetic complete topic');
  const topicList = within(
    screen.getByRole('region', { name: 'Saved topics' }),
  );
  fireEvent.click(
    topicList.getAllByRole('button', { name: 'Reopen topic' })[1]!,
  );
  await screen.findByText('Synthetic river');
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Refresh candidate' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  available = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh candidate' }));
  await screen.findByRole('alert');
  for (const value of [
    'Synthetic river',
    'Synthetic complete topic',
    'Synthetic fixed view',
    topicOpened.viewSpec.topic.question,
    ref.reviewHash,
    ref.processingBatchId,
    'synthetic-fixture-v1',
  ])
    expect(screen.queryByText(value)).toBeNull();
  expect(screen.queryByRole('region', { name: 'Processing facts' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Saved reading link' })).toBeNull();
  const before = fetch.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  expect(fetch.mock.calls[before]?.[0]).toBe(
    '/api/data-foundation/candidate-topics/open',
  );
});
it('rejects a changed complete-topic rule pin after material reading without showing partial content', async () => {
  let opens = 0;
  fetch.mockImplementation((url) => {
    if (requestUrl(url) === '/api/data-foundation/candidate-topics/open') {
      opens++;
      return respondJson(
        opens < 3
          ? topicOpened
          : {
              ...topicOpened,
              viewSpec: {
                ...topicOpened.viewSpec,
                rulePins: topicOpened.viewSpec.rulePins.map((pin) => ({
                  ...pin,
                  version: 'synthetic/2',
                })),
              },
            },
      );
    }
    return topicResponses(url);
  });
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={ref.ingestionId}
      savedTopicId={viewId}
      locale="en"
    />,
  );
  await screen.findByRole('alert');
  expect(screen.queryByText('Synthetic river')).toBeNull();
  expect(screen.queryByText(topicOpened.savedView.title)).toBeNull();
});
