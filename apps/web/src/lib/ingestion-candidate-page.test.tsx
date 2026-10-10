import type { CandidateSupplementLookup } from '@/components/candidate-followup-panel';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  legacy: vi.fn(),
  reader: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(url);
  },
}));
vi.mock('@/lib/data-foundation-dal.server', () => ({
  DataFoundationApiError: class extends Error {
    constructor(
      readonly kind: string,
      readonly status: number,
    ) {
      super('Safe data service error');
    }
  },
  getDataFoundationDal: () =>
    Promise.resolve({ ingestionDetail: mocks.detail, ingestion: mocks.legacy }),
}));
vi.mock('@/components/ingestion-candidate-reader', () => ({
  IngestionCandidateReader: (props: unknown) => {
    mocks.reader(props);
    return <div>Candidate reader boundary</div>;
  },
}));
import Page from '../app/[locale]/data-foundation/ingestions/[ingestionId]/page';
import { DataFoundationApiError } from './data-foundation-dal.server';

const ingestionId = '10000000-0000-4000-8000-000000000001';
const viewId = '10000000-0000-4000-8000-000000000009';
const reference = {
  kind: 'ingestion-candidate',
  ingestionId,
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const ingestion = {
  ingestionId,
  projectId: '10000000-0000-4000-8000-000000000020',
  assetIds: [],
  intendedUses: ['research'],
  requestedSecurityLevel: 'L0_PUBLIC',
  state: 'REVIEW_REQUIRED',
  version: 1,
  createdAt: '2026-10-03T00:00:00Z',
  updatedAt: '2026-10-03T00:00:00Z',
};
const params = Promise.resolve({ locale: 'en', ingestionId });
afterEach(() => {
  vi.resetAllMocks();
});

it('uses ingestion detail 1.2 and passes the complete candidate without changing intake status', async () => {
  mocks.detail.mockResolvedValue({ ingestion, candidateReference: reference });
  const markup = renderToStaticMarkup(await Page({ params }));
  expect(mocks.detail).toHaveBeenCalledWith(ingestionId);
  expect(mocks.legacy).not.toHaveBeenCalled();
  expect(mocks.reader).toHaveBeenCalledWith({
    reference,
    locale: 'en',
    savedViewId: undefined,
    ingestionId,
    supplementLookup: {
      action: `/en/data-foundation/ingestions/${ingestionId}`,
      requestedIngestionId: '',
    },
  });
  expect(markup).toContain('Review required');
  const document = new URL(
    markup
      .match(/href="([^"]*spatial-workspace[^"]*)"/)?.[1]
      ?.replaceAll('&amp;', '&') ?? '',
    'https://example.invalid',
  );
  expect(document.searchParams.get('candidateIngestionId')).toBe(ingestionId);
  expect(document.searchParams.get('candidateProcessingBatchId')).toBe(
    reference.processingBatchId,
  );
  expect(document.searchParams.get('candidateReviewHash')).toBe(
    reference.reviewHash,
  );
});
it('keeps a null candidate reference and forwards only a valid persisted view identifier', async () => {
  mocks.detail.mockResolvedValue({ ingestion, candidateReference: null });
  const markup = renderToStaticMarkup(
    await Page({
      params,
      searchParams: Promise.resolve({ candidateView: viewId }),
    }),
  );
  expect(mocks.reader).toHaveBeenCalledWith({
    reference: null,
    locale: 'en',
    savedViewId: viewId,
    ingestionId,
  });
  expect(markup).not.toContain('Open current candidate workspace');
});
it.each(['not-a-uuid', [viewId, viewId]])(
  'rejects invalid or duplicate saved-view parameters before reading intake',
  async (candidateView) => {
    const markup = renderToStaticMarkup(
      await Page({ params, searchParams: Promise.resolve({ candidateView }) }),
    );
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.reader).not.toHaveBeenCalled();
    expect(markup).toContain('role="alert"');
  },
);
it('preserves the validated saved-view destination when login is required', async () => {
  mocks.detail.mockRejectedValue(
    new DataFoundationApiError('authentication', 401),
  );
  const target = `/en/data-foundation/ingestions/${ingestionId}?candidateView=${viewId}`;
  await expect(
    Page({ params, searchParams: Promise.resolve({ candidateView: viewId }) }),
  ).rejects.toThrow(`/en/login?next=${encodeURIComponent(target)}`);
  expect(mocks.reader).not.toHaveBeenCalled();
});
it('shows a safe failure without mounting the reader or disclosing transport error detail', async () => {
  mocks.detail.mockRejectedValue(new Error('private service detail'));
  const markup = renderToStaticMarkup(await Page({ params }));
  expect(markup).toContain('role="alert"');
  expect(markup).not.toContain('private service detail');
  expect(mocks.reader).not.toHaveBeenCalled();
});

it('forwards a validated topic destination without disclosing the ordinary intake summary', async () => {
  const markup = renderToStaticMarkup(
    await Page({
      params,
      searchParams: Promise.resolve({ candidateTopic: viewId }),
    }),
  );
  expect(mocks.detail).not.toHaveBeenCalled();
  expect(mocks.reader).toHaveBeenCalledWith({
    reference: null,
    locale: 'en',
    savedTopicId: viewId,
    ingestionId,
  });
  expect(markup).not.toContain('Review required');
});
it.each([
  { candidateTopic: 'bad' },
  { candidateTopic: [viewId, viewId] },
  { candidateView: viewId, candidateTopic: viewId },
])('rejects malformed or competing topic destinations', async (query) => {
  const markup = renderToStaticMarkup(
    await Page({ params, searchParams: Promise.resolve(query) }),
  );
  expect(mocks.detail).not.toHaveBeenCalled();
  expect(mocks.reader).not.toHaveBeenCalled();
  expect(markup).toContain('role="alert"');
});

it('resolves one supplemental intake on the server without replacing the reading reference', async () => {
  const otherId = '10000000-0000-4000-8000-000000000030';
  const other = {
    ...reference,
    ingestionId: otherId,
    reviewHash: 'b'.repeat(64),
  };
  mocks.detail.mockImplementation((id: string) =>
    Promise.resolve({
      ingestion: { ...ingestion, ingestionId: id },
      candidateReference: id === ingestionId ? reference : other,
    }),
  );
  renderToStaticMarkup(
    await Page({
      params,
      searchParams: Promise.resolve({
        supplementIngestionId: otherId,
        followupId: viewId,
      }),
    }),
  );
  expect(mocks.detail.mock.calls.map((c) => c[0] as unknown)).toEqual([
    ingestionId,
    otherId,
  ]);
  expect(mocks.reader).toHaveBeenCalledWith(
    expect.objectContaining({ reference }),
  );
  const received = mocks.reader.mock.calls[0][0] as {
    supplementLookup: CandidateSupplementLookup;
  };
  expect(received.supplementLookup).toMatchObject({
    action: `/en/data-foundation/ingestions/${ingestionId}`,
    requestedIngestionId: otherId,
    initialFollowupId: viewId,
    source: { reference: other, label: otherId },
    stateLabel: 'Review required',
  });
  expect(received.supplementLookup.verificationId).toMatch(/^[0-9a-f-]{36}$/);
});
it.each(['authorization', 'not-found', 'unavailable'])(
  'keeps A readable and never supplies fallback evidence after supplemental %s',
  async (kind) => {
    mocks.detail
      .mockResolvedValueOnce({ ingestion, candidateReference: reference })
      .mockRejectedValueOnce(new DataFoundationApiError(kind as never, 403));
    const markup = renderToStaticMarkup(
      await Page({
        params,
        searchParams: Promise.resolve({ supplementIngestionId: viewId }),
      }),
    );
    expect(markup).not.toContain('Safe data service error');
    expect(mocks.reader).toHaveBeenCalledWith(
      expect.objectContaining({ reference }),
    );
    const received = mocks.reader.mock.calls[0][0] as {
      supplementLookup: CandidateSupplementLookup;
    };
    expect(received.supplementLookup.requestedIngestionId).toBe(viewId);
    expect(received.supplementLookup.error).toBeTypeOf('string');
    expect(received.supplementLookup.source).toBeUndefined();
  },
);
it('shows an empty supplemental candidate without inventing a source', async () => {
  mocks.detail
    .mockResolvedValueOnce({ ingestion, candidateReference: reference })
    .mockResolvedValueOnce({
      ingestion: { ...ingestion, ingestionId: viewId },
      candidateReference: null,
    });
  renderToStaticMarkup(
    await Page({
      params,
      searchParams: Promise.resolve({ supplementIngestionId: viewId }),
    }),
  );
  expect(
    (
      mocks.reader.mock.calls[0][0] as {
        supplementLookup: CandidateSupplementLookup;
      }
    ).supplementLookup,
  ).toMatchObject({
    error: 'empty',
  });
});
it.each([
  { supplementIngestionId: [viewId, viewId] },
  { supplementIngestionId: 'bad' },
  { followupId: 'bad' },
  { candidateTopic: viewId, supplementIngestionId: viewId },
  { candidateView: viewId, supplementIngestionId: viewId },
])(
  'rejects malformed or saved-reading supplementary parameters',
  async (query) => {
    renderToStaticMarkup(
      await Page({ params, searchParams: Promise.resolve(query) }),
    );
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.reader).not.toHaveBeenCalled();
  },
);
it('preserves the supplemental source and followup target through sign in', async () => {
  mocks.detail
    .mockResolvedValueOnce({ ingestion, candidateReference: reference })
    .mockRejectedValueOnce(new DataFoundationApiError('authentication', 401));
  const destination = `/en/data-foundation/ingestions/${ingestionId}?supplementIngestionId=${viewId}&followupId=${viewId}`;
  await expect(
    Page({
      params,
      searchParams: Promise.resolve({
        supplementIngestionId: viewId,
        followupId: viewId,
      }),
    }),
  ).rejects.toThrow(`/en/login?next=${encodeURIComponent(destination)}`);
});
