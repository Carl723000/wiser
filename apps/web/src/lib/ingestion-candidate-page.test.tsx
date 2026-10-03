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
  });
  expect(markup).toContain('Review required');
});
it('keeps a null candidate reference and forwards only a valid persisted view identifier', async () => {
  mocks.detail.mockResolvedValue({ ingestion, candidateReference: null });
  renderToStaticMarkup(
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
