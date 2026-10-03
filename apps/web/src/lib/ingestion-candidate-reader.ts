import type {
  IngestionCandidateAssetPage,
  IngestionCandidateRecordPage,
  IngestionCandidateGeometryPage,
  IngestionCandidateReference,
} from '@wiser/data-contracts';

export type CandidateReadAction = 'get' | 'records' | 'geometry';
export interface CandidatePages {
  get: IngestionCandidateAssetPage;
  records: IngestionCandidateRecordPage;
  geometry: IngestionCandidateGeometryPage;
}
export class CandidateReaderError extends Error {
  constructor(
    readonly kind: 'denied' | 'stale' | 'invalid' | 'unavailable' | 'cancelled',
  ) {
    super('Candidate content is unavailable');
  }
}
export function readCandidatePage<A extends CandidateReadAction>(
  _action: A,
  _input: unknown,
  _signal: AbortSignal,
  _fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CandidatePages[A]> {
  return Promise.reject(new CandidateReaderError('unavailable'));
}
export function candidateOriginalUrl(
  _reference: IngestionCandidateReference,
  _assetId: string,
  _locale: string,
): string {
  return '';
}
export function candidateMapFeatures(_page: IngestionCandidateGeometryPage) {
  return { type: 'FeatureCollection' as const, features: [] };
}
