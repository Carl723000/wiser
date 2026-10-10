import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  local: vi.fn(),
  reader: vi.fn(),
  background: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/spatial-public-reference.server', () => ({
  loadPublicReferences: mocks.background,
}));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Map([['host', 'localhost:3422']])),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (href: string) => {
    throw new Error(href);
  },
}));
vi.mock('@/lib/spatial-workspace-local', () => ({
  loadLocalSpatialWorkspace: mocks.local,
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
    Promise.resolve({ ingestionDetail: mocks.detail }),
}));
vi.mock('@/components/ingestion-candidate-reader', () => ({
  IngestionCandidateReader: (props: unknown) => {
    mocks.reader(props);
    return <div>Current candidate reading</div>;
  },
}));
vi.mock('@/components/spatial-workspace-shell', () => ({
  SpatialWorkspaceShell: () => <div>Local workspace</div>,
}));
import Page from '../app/[locale]/data-foundation/spatial-workspace/page';
import { DataFoundationApiError } from './data-foundation-dal.server';

const reference = {
  kind: 'ingestion-candidate',
  ingestionId: '10000000-0000-4000-8000-000000000001',
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const query = {
  candidateIngestionId: reference.ingestionId,
  candidateProcessingBatchId: reference.processingBatchId,
  candidateReviewHash: reference.reviewHash,
};
const params = Promise.resolve({ locale: 'en' });
afterEach(() => vi.resetAllMocks());
function page(search: Record<string, string | string[] | undefined> = query) {
  if (!mocks.background.getMockImplementation())
    mocks.background.mockResolvedValue({});
  mocks.local.mockResolvedValue({ state: 'disabled', pack: null });
  return Page({ params, searchParams: Promise.resolve(search) });
}

it('opens only the same current server-advertised candidate through the shared readonly reader', async () => {
  mocks.detail.mockResolvedValue({
    ingestion: { ingestionId: reference.ingestionId },
    candidateReference: reference,
  });
  const markup = renderToStaticMarkup(await page());
  expect(mocks.detail).toHaveBeenCalledWith(reference.ingestionId);
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.reader).toHaveBeenCalledWith({
    reference,
    locale: 'en',
    readOnly: true,
  });
  expect(markup).toContain('Current candidate reading');
  expect(markup).not.toContain('Local workspace');
});
it.each([
  { candidateIngestionId: reference.ingestionId },
  { ...query, candidateReviewHash: ['a'.repeat(64), 'a'.repeat(64)] },
  { ...query, candidateView: '10000000-0000-4000-8000-000000000009' },
  { ...query, candidateProcessingBatchId: 'invalid' },
  { ...query, periodFrom: '2026-10' },
])(
  'rejects incomplete, duplicate or mixed candidate navigation without a local fallback',
  async (search) => {
    const markup = renderToStaticMarkup(await page(search));
    expect(markup).toContain('role="alert"');
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.reader).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  { ...reference, reviewHash: 'b'.repeat(64) },
  { ...reference, processingBatchId: '10000000-0000-4000-8000-000000000003' },
])(
  'rejects missing or replaced current references without widening to historical reads',
  async (candidateReference) => {
    mocks.detail.mockResolvedValue({
      ingestion: { ingestionId: reference.ingestionId },
      candidateReference,
    });
    const markup = renderToStaticMarkup(await page());
    expect(markup).toContain('role="alert"');
    expect(mocks.reader).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  },
);
it('retains the fixed destination for sign-in and never reads a local pack after Auth failure', async () => {
  mocks.detail.mockRejectedValue(
    new DataFoundationApiError('authentication', 401),
  );
  const href = `/en/data-foundation/spatial-workspace?${new URLSearchParams(query)}`;
  await expect(page()).rejects.toThrow(
    `/en/login?next=${encodeURIComponent(href)}`,
  );
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.reader).not.toHaveBeenCalled();
});
it('shows only a safe permission failure with no candidate content', async () => {
  mocks.detail.mockRejectedValue(
    new DataFoundationApiError('authorization', 403),
  );
  const markup = renderToStaticMarkup(await page());
  expect(markup).toContain('role="alert"');
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.reader).not.toHaveBeenCalled();
});
it('rejects an authorized detail from a different intake rather than mixing owners', async () => {
  mocks.detail.mockResolvedValue({
    ingestion: { ingestionId: '10000000-0000-4000-8000-000000000009' },
    candidateReference: reference,
  });
  const markup = renderToStaticMarkup(await page());
  expect(markup).toContain('role="alert"');
  expect(mocks.reader).not.toHaveBeenCalled();
  expect(mocks.local).not.toHaveBeenCalled();
});
it('preserves the existing explicit local path when no candidate navigation is present', async () => {
  renderToStaticMarkup(await page({}));
  expect(mocks.local).toHaveBeenCalledOnce();
  expect(mocks.detail).not.toHaveBeenCalled();
});

it('passes separately verified public references after current candidate authority succeeds', async () => {
  const background = {
    publicReferenceState: 'ready',
    publicReferences: { type: 'FeatureCollection', features: [] },
  };
  mocks.background.mockResolvedValue(background);
  mocks.detail.mockResolvedValue({
    ingestion: { ingestionId: reference.ingestionId },
    candidateReference: reference,
  });
  renderToStaticMarkup(await page());
  expect(mocks.background).toHaveBeenCalledWith(process.env);
  expect(mocks.reader).toHaveBeenCalledWith({
    reference,
    locale: 'en',
    readOnly: true,
    ...background,
  });
  expect(mocks.local).not.toHaveBeenCalled();
});
