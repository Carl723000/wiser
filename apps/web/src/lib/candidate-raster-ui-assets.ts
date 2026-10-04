import {
  candidateSavedReferenceKey,
  jsonUtf8Bytes,
  type IngestionCandidateAssetPage,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  CANDIDATE_RASTER_BANDS,
  RETAINED_RASTER_HASHES,
} from './candidate-raster-window';
import type { CandidateRasterReadInput } from './candidate-raster-original-reader';
import {
  CandidateReaderError,
  readCandidatePage,
} from './ingestion-candidate-reader';

// The definitive reader independently repeats this complete-page check before
// and after decoding. Discovery only locates the four fixed asset identifiers.
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const REQUIRED_HASHES = new Set<string>(Object.values(RETAINED_RASTER_HASHES));

function invalid(): never {
  throw new CandidateReaderError('invalid');
}

function batchSnapshot(page: IngestionCandidateAssetPage): string {
  return JSON.stringify({
    reference: candidateSavedReferenceKey(page.reference),
    parserVersion: page.parserVersion,
    status: page.status,
    createdAt: page.createdAt,
    totalAssetCount: page.totalAssetCount,
    knownRecordCount: page.knownRecordCount,
    knownFeatureCount: page.knownFeatureCount,
    unknownAssetCount: page.unknownAssetCount,
  });
}

/** Locate, but never authorize from a partial or ambiguous asset listing. */
export async function discoverCandidateRasterAssets(
  reference: IngestionCandidateReference,
  signal: AbortSignal,
): Promise<CandidateRasterReadInput['assets']> {
  let after: string | undefined;
  let snapshot: string | null = null;
  let total: number | null = null;
  let bytes = 0;
  const assetIds = new Set<string>();
  const cursors = new Set<string>();
  const matching = new Map<string, string>();

  for (let index = 0; index < MAX_PAGES; index++) {
    if (signal.aborted) throw new CandidateReaderError('cancelled');
    const page = await readCandidatePage(
      'get',
      { ...reference, first: PAGE_SIZE, ...(after ? { after } : {}) },
      signal,
    );
    const nextSnapshot = batchSnapshot(page);
    bytes += jsonUtf8Bytes(page);
    if (
      bytes > MAX_PAGE_BYTES ||
      (snapshot !== null && nextSnapshot !== snapshot)
    )
      invalid();
    snapshot = nextSnapshot;
    total = page.totalAssetCount;

    for (const asset of page.assets) {
      const id = asset.assetId.toLowerCase();
      if (assetIds.has(id)) invalid();
      assetIds.add(id);
      if (REQUIRED_HASHES.has(asset.sourceHash)) {
        if (matching.has(asset.sourceHash)) invalid();
        matching.set(asset.sourceHash, asset.assetId);
      }
    }
    if (assetIds.size > total) invalid();

    if (page.nextCursor === null) {
      if (
        assetIds.size !== total ||
        matching.size !== CANDIDATE_RASTER_BANDS.length
      )
        invalid();
      return CANDIDATE_RASTER_BANDS.map((band) => ({
        band,
        assetId: matching.get(RETAINED_RASTER_HASHES[band])!,
        sha256: RETAINED_RASTER_HASHES[band],
      }));
    }
    if (
      cursors.has(page.nextCursor) ||
      page.assets.length === 0 ||
      assetIds.size === total
    )
      invalid();
    cursors.add(page.nextCursor);
    after = page.nextCursor;
  }
  return invalid();
}
