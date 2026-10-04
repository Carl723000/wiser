import {
  IngestionCandidateReferenceSchema,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import type { Locale } from './i18n';

const keys = [
  'candidateIngestionId',
  'candidateProcessingBatchId',
  'candidateReviewHash',
] as const;
type Search = Record<string, string | string[] | undefined>;

export function decodeCandidateWorkspaceRoute(
  search: Search,
):
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'valid'; reference: IngestionCandidateReference } {
  if (!Object.keys(search).some((key) => key.startsWith('candidate')))
    return { status: 'absent' };
  // Current-candidate navigation cannot also select local or saved reading state.
  if (
    Object.keys(search).length !== keys.length ||
    keys.some((key) => typeof search[key] !== 'string')
  )
    return { status: 'invalid' };
  const parsed = IngestionCandidateReferenceSchema.safeParse({
    kind: 'ingestion-candidate',
    ingestionId: search.candidateIngestionId,
    processingBatchId: search.candidateProcessingBatchId,
    reviewHash: search.candidateReviewHash,
  });
  return parsed.success
    ? { status: 'valid', reference: parsed.data }
    : { status: 'invalid' };
}

export function candidateWorkspaceHref(
  locale: Locale,
  reference: IngestionCandidateReference,
): string {
  const fixed = IngestionCandidateReferenceSchema.parse(reference);
  const query = new URLSearchParams({
    candidateIngestionId: fixed.ingestionId.toLowerCase(),
    candidateProcessingBatchId: fixed.processingBatchId.toLowerCase(),
    candidateReviewHash: fixed.reviewHash,
  });
  return `/${locale}/data-foundation/spatial-workspace?${query.toString()}`;
}
