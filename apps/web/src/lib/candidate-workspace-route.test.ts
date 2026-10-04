import { expect, it } from 'vitest';
import {
  candidateWorkspaceHref,
  decodeCandidateWorkspaceRoute,
} from './candidate-workspace-route';

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: 'A0000000-0000-4000-8000-000000000001',
  processingBatchId: 'B0000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
it('roundtrips the complete candidate identity without a published version or saved state', () => {
  const href = candidateWorkspaceHref('zh-CN', reference);
  const url = new URL(href, 'https://example.invalid');
  expect(url.pathname).toBe('/zh-CN/data-foundation/spatial-workspace');
  expect(
    decodeCandidateWorkspaceRoute(Object.fromEntries(url.searchParams)),
  ).toEqual({
    status: 'valid',
    reference: {
      ...reference,
      ingestionId: reference.ingestionId.toLowerCase(),
      processingBatchId: reference.processingBatchId.toLowerCase(),
    },
  });
  expect([...url.searchParams.keys()]).toHaveLength(3);
});
it('keeps local reading separate and rejects a saved-only candidate query', () => {
  expect(decodeCandidateWorkspaceRoute({ region: 'north' })).toEqual({
    status: 'absent',
  });
  expect(
    decodeCandidateWorkspaceRoute({ candidateView: reference.ingestionId }),
  ).toEqual({ status: 'invalid' });
});
