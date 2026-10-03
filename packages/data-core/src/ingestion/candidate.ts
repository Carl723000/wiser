import {
  FrozenIngestionCandidateInputSchema,
  IngestionCandidateBatchSchema,
} from '@wiser/data-contracts';
import { resolveIngestionReviewGovernance } from './index.js';

/** Integrity check only. Live Auth, maintenance ownership and effects belong to adapters. */
export function matchesFrozenIngestionCandidate(
  current: unknown,
  candidate: unknown,
): boolean {
  const authority = FrozenIngestionCandidateInputSchema.safeParse(current);
  const batch = IngestionCandidateBatchSchema.safeParse(candidate);
  if (
    !authority.success ||
    !batch.success ||
    resolveIngestionReviewGovernance(authority.data.reviewGovernance).kind !==
      'REQUIRES_REVIEW'
  )
    return false;
  const ref = batch.data.reference;
  const frozen = authority.data;
  if (
    ref.ingestionId !== frozen.ingestionId ||
    ref.reviewHash !== frozen.reviewHash ||
    ref.processingBatchId !== frozen.processingBatchId
  )
    return false;
  const originals = new Map(
    frozen.assets.map((asset) => [asset.assetId, asset.sourceHash]),
  );
  return (
    originals.size === frozen.assets.length &&
    originals.size === batch.data.assets.length &&
    batch.data.assets.every(
      (asset) => originals.get(asset.assetId) === asset.sourceHash,
    )
  );
}
