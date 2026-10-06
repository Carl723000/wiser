import type { IngestionCandidateReference } from '@wiser/data-contracts';
import type { CandidateLoadHttpOptions } from './a12-candidate-load-http.ts';

export type CandidateOriginalHttpOptions = CandidateLoadHttpOptions;
export interface CandidateOriginalHttpInput {
  readonly reference: IngestionCandidateReference;
  readonly assetId: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: number;
}
export interface CandidateOriginalHttpResult {
  readonly status: 200;
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface CandidateOriginalHttpAdapter {
  readonly read: (
    input: CandidateOriginalHttpInput,
  ) => Promise<CandidateOriginalHttpResult>;
  readonly close: () => void;
  readonly diagnostics: () => { activeRequests: number; closed: boolean };
}

/** Raw original integrity only; never a scanner or formal A12 certificate. */
export function createCandidateOriginalHttpAdapter(
  _options: CandidateOriginalHttpOptions,
): CandidateOriginalHttpAdapter {
  throw new Error('Candidate original adapter is not implemented');
}
