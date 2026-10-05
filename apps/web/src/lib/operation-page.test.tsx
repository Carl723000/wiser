import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ events: vi.fn(), operation: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw Error('NOT_FOUND');
  },
  redirect: (url: string) => {
    throw Error(url);
  },
}));
vi.mock('@/lib/data-foundation-dal.server', () => ({
  DataFoundationApiError: class extends Error {},
  getDataFoundationDal: () =>
    Promise.resolve({
      operation: mocks.operation,
      operationEvents: mocks.events,
    }),
}));
import Page from '../app/[locale]/data-foundation/operations/[operationId]/page';
const operationId = '10000000-0000-4000-8000-000000000001';
it('provides an explicit first-segment recovery on the production task page', async () => {
  mocks.operation.mockResolvedValue({
    operationId,
    capabilityId: 'data.ingestion.create',
    status: 'RUNNING',
    progressPercent: 10,
    version: 1,
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
  });
  mocks.events.mockResolvedValue([]);
  const markup = renderToStaticMarkup(
    await Page({ params: Promise.resolve({ locale: 'en', operationId }) }),
  );
  expect(markup).toContain('Return to first segment');
  expect(mocks.events).toHaveBeenCalledWith(operationId);
});
