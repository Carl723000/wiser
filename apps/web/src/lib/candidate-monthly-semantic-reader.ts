import {
  IngestionCandidateBatchSchema,
  IngestionCandidateReferenceSchema,
  candidateSavedReferenceKey,
  jsonUtf8Bytes,
  type IngestionCandidateAssetPage,
  type IngestionCandidateRecordPage,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  CANDIDATE_MONTHLY_RULE_VERSION,
  projectCandidateMonthlyReport,
  type CandidateMonthlyProjectedRecord,
  type CandidateMonthlyUnparsedReason,
} from '@wiser/data-core/candidate-monthly-projection';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import {
  CandidateReaderError,
  readCandidatePage,
  readCandidateSavedView,
} from './ingestion-candidate-reader';

const SHA256 = /^[a-f0-9]{64}$/u;
const PAGE_SIZE = 200;
const MAX_ASSET_PAGES = 100;
const MAX_RECORD_PAGES = 100;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10_000;

/** Explicit source-local evidence. The candidate GET contract supplies neither work ID nor DOC conversion lineage. */
export interface CandidateMonthlyReadInput {
  readonly reference: IngestionCandidateReference;
  readonly assetId: string;
  readonly savedViewId?: string;
  readonly fixed: {
    readonly sourceLocalWorkId: string | null;
    readonly originalSha256: string | null;
    readonly preparedSha256: string;
    readonly processingRuleVersion: string;
  };
}

export type CandidateMonthlySemanticRecord = Omit<
  CandidateMonthlyProjectedRecord,
  'source'
> & {
  readonly source: {
    readonly sourceLocalWorkId: string;
    readonly assetId: string;
    /** Hash of the original work, never inferred from a converted candidate asset. */
    readonly originalSha256: string;
    /** Hash of the bytes parsed for this candidate asset. */
    readonly preparedSha256: string;
  };
};

export type CandidateMonthlySemanticReason =
  | CandidateMonthlyUnparsedReason
  | 'MISSING_SOURCE_LOCAL_IDENTITY'
  | 'MISSING_ORIGINAL_HASH'
  | 'CONVERSION_PROVENANCE_UNAVAILABLE'
  | 'RULE_VERSION_CHANGED';

export type CandidateMonthlySemanticRead =
  | {
      readonly kind: 'READY';
      readonly reason: null;
      readonly candidateReference: IngestionCandidateReference;
      readonly assetId: string;
      readonly publicationMonth: string;
      readonly processingRuleVersion: typeof CANDIDATE_MONTHLY_RULE_VERSION;
      readonly records: readonly CandidateMonthlySemanticRecord[];
    }
  | {
      readonly kind: 'NOT_PARSED';
      readonly reason: CandidateMonthlySemanticReason;
      readonly candidateReference: IngestionCandidateReference;
      readonly assetId: string;
      readonly publicationMonth: null;
      readonly processingRuleVersion: typeof CANDIDATE_MONTHLY_RULE_VERSION;
      readonly records: readonly [];
    };

function invalid(): never {
  throw new CandidateReaderError('invalid');
}
function current(signal: AbortSignal): void {
  if (signal.aborted) throw new CandidateReaderError('cancelled');
}
function notParsed(
  reference: IngestionCandidateReference,
  assetId: string,
  reason: CandidateMonthlySemanticReason,
): CandidateMonthlySemanticRead {
  return {
    kind: 'NOT_PARSED',
    reason,
    candidateReference: reference,
    assetId,
    publicationMonth: null,
    processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
    records: [],
  };
}
function sameReference(
  left: IngestionCandidateReference,
  right: IngestionCandidateReference,
): boolean {
  return candidateSavedReferenceKey(left) === candidateSavedReferenceKey(right);
}
function snapshot(page: IngestionCandidateAssetPage): string {
  return JSON.stringify({
    reference: page.reference,
    parserVersion: page.parserVersion,
    status: page.status,
    createdAt: page.createdAt,
    totalAssetCount: page.totalAssetCount,
    knownRecordCount: page.knownRecordCount,
    knownFeatureCount: page.knownFeatureCount,
    unknownAssetCount: page.unknownAssetCount,
  });
}
function checkedSum(values: readonly (number | null)[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value ?? 0;
    if (!Number.isSafeInteger(sum)) invalid();
  }
  return sum;
}

async function checkedSavedOpen(
  input: CandidateMonthlyReadInput,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch,
): Promise<string | null> {
  if (!input.savedViewId) return null;
  const opened = await readCandidateSavedView(
    'open',
    { viewId: input.savedViewId },
    signal,
    undefined,
    fetch,
  );
  const page = opened.viewSpec.page;
  if (
    !opened.references.some((ref) => sameReference(ref, input.reference)) ||
    !sameReference(page.reference, input.reference) ||
    (page.kind !== 'assets' &&
      page.assetId.toLowerCase() !== input.assetId.toLowerCase()) ||
    (opened.viewSpec.focus &&
      (!sameReference(opened.viewSpec.focus.reference, input.reference) ||
        opened.viewSpec.focus.assetId.toLowerCase() !==
          input.assetId.toLowerCase()))
  )
    invalid();
  return JSON.stringify(opened);
}

async function completeBatch(
  input: CandidateMonthlyReadInput,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch,
) {
  const pages: IngestionCandidateAssetPage[] = [];
  const assets: IngestionCandidateAssetPage['assets'][number][] = [];
  const seenAssets = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | undefined;
  let bytes = 0;
  for (let index = 0; index < MAX_ASSET_PAGES; index++) {
    current(signal);
    const page = await readCandidatePage(
      'get',
      { ...input.reference, first: PAGE_SIZE, ...(after ? { after } : {}) },
      signal,
      fetch,
    );
    bytes += jsonUtf8Bytes(page);
    if (
      bytes > MAX_ASSET_BYTES ||
      (pages.length > 0 && snapshot(page) !== snapshot(pages[0]))
    )
      invalid();
    pages.push(page);
    for (const asset of page.assets) {
      const id = asset.assetId.toLowerCase();
      if (seenAssets.has(id)) invalid();
      seenAssets.add(id);
      assets.push(asset);
    }
    if (assets.length > page.totalAssetCount) invalid();
    if (page.nextCursor === null) {
      if (
        assets.length !== page.totalAssetCount ||
        checkedSum(assets.map((asset) => asset.recordCount)) !==
          page.knownRecordCount ||
        checkedSum(assets.map((asset) => asset.featureCount)) !==
          page.knownFeatureCount ||
        assets.filter((asset) => asset.recordCount === null).length !==
          page.unknownAssetCount
      )
        invalid();
      const batch = IngestionCandidateBatchSchema.safeParse({
        reference: page.reference,
        parserVersion: page.parserVersion,
        status: page.status,
        assets,
        createdAt: page.createdAt,
      });
      if (!batch.success) invalid();
      return { batch: batch.data, firstPage: pages[0] };
    }
    if (
      assets.length === page.totalAssetCount ||
      seenCursors.has(page.nextCursor)
    )
      invalid();
    seenCursors.add(page.nextCursor);
    after = page.nextCursor;
  }
  return invalid();
}

async function completeRecords(
  input: CandidateMonthlyReadInput,
  expectedCount: number,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch,
): Promise<IngestionCandidateRecordPage[]> {
  if (expectedCount < 1 || expectedCount > MAX_RECORDS) invalid();
  const pages: IngestionCandidateRecordPage[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | undefined;
  let expectedIndex = 1;
  let columns: string | null = null;
  let bytes = 0;
  for (let index = 0; index < MAX_RECORD_PAGES; index++) {
    current(signal);
    const page = await readCandidatePage(
      'records',
      {
        ...input.reference,
        assetId: input.assetId,
        first: PAGE_SIZE,
        ...(after ? { after } : {}),
      },
      signal,
      fetch,
    );
    bytes += jsonUtf8Bytes(page);
    const pageColumns = JSON.stringify(page.columns);
    if (
      bytes > MAX_RECORD_BYTES ||
      (columns !== null && columns !== pageColumns) ||
      page.records.length === 0
    )
      invalid();
    columns = pageColumns;
    for (const record of page.records) {
      const id = record.recordId.toLowerCase();
      if (seenIds.has(id) || record.index !== expectedIndex++) invalid();
      seenIds.add(id);
    }
    pages.push(page);
    if (seenIds.size > expectedCount) invalid();
    if (page.nextCursor === null) {
      if (seenIds.size !== expectedCount) invalid();
      return pages;
    }
    if (seenIds.size === expectedCount || seenCursors.has(page.nextCursor))
      invalid();
    seenCursors.add(page.nextCursor);
    after = page.nextCursor;
  }
  return invalid();
}

/** Complete, currently authorized candidate pages only; no local pack or published identity fallback. */
export async function readCandidateMonthlySemantics(
  raw: CandidateMonthlyReadInput,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CandidateMonthlySemanticRead> {
  current(signal);
  const reference = IngestionCandidateReferenceSchema.safeParse(raw.reference);
  const assetId = PlatformUuidSchema.safeParse(raw.assetId);
  if (
    !reference.success ||
    !assetId.success ||
    (raw.savedViewId !== undefined &&
      !PlatformUuidSchema.safeParse(raw.savedViewId).success) ||
    !raw.fixed ||
    !SHA256.test(raw.fixed.preparedSha256) ||
    (raw.fixed.originalSha256 !== null &&
      !SHA256.test(raw.fixed.originalSha256))
  )
    invalid();
  const fixed = raw.fixed;
  const initialSaved = await checkedSavedOpen(raw, signal, fetch);
  const { batch, firstPage } = await completeBatch(raw, signal, fetch);
  const asset = batch.assets.find(
    (entry) => entry.assetId.toLowerCase() === assetId.data.toLowerCase(),
  );
  if (!asset || asset.sourceHash !== fixed.preparedSha256)
    return notParsed(reference.data, assetId.data, 'SOURCE_CHANGED');
  if (
    batch.status !== 'READY' ||
    asset.status !== 'READY' ||
    asset.recordCount === null
  )
    return notParsed(reference.data, assetId.data, 'SOURCE_NOT_READY');
  if (fixed.processingRuleVersion !== CANDIDATE_MONTHLY_RULE_VERSION)
    return notParsed(reference.data, assetId.data, 'RULE_VERSION_CHANGED');
  if (
    fixed.sourceLocalWorkId === null ||
    typeof fixed.sourceLocalWorkId !== 'string' ||
    !fixed.sourceLocalWorkId.trim() ||
    fixed.sourceLocalWorkId.length > 256
  )
    return notParsed(
      reference.data,
      assetId.data,
      'MISSING_SOURCE_LOCAL_IDENTITY',
    );
  if (fixed.originalSha256 === null)
    return notParsed(reference.data, assetId.data, 'MISSING_ORIGINAL_HASH');
  if (fixed.originalSha256 !== fixed.preparedSha256)
    return notParsed(
      reference.data,
      assetId.data,
      'CONVERSION_PROVENANCE_UNAVAILABLE',
    );
  const pages = await completeRecords(raw, asset.recordCount, signal, fetch);

  // A fresh authorized read closes the collect/convert window as far as the current API can prove.
  const fresh = await readCandidatePage(
    'get',
    { ...reference.data, first: PAGE_SIZE },
    signal,
    fetch,
  );
  if (JSON.stringify(fresh) !== JSON.stringify(firstPage))
    throw new CandidateReaderError('stale');
  if (initialSaved !== null) {
    const currentSaved = await checkedSavedOpen(raw, signal, fetch);
    if (currentSaved !== initialSaved) throw new CandidateReaderError('stale');
  }
  current(signal);
  const projection = projectCandidateMonthlyReport({
    batch,
    pages,
    fixed: {
      workId: fixed.sourceLocalWorkId,
      assetId: assetId.data,
      sourceHash: fixed.preparedSha256,
    },
  });
  current(signal);
  if (projection.kind !== 'READY')
    return notParsed(reference.data, assetId.data, projection.reason);
  return {
    kind: 'READY',
    reason: null,
    candidateReference: reference.data,
    assetId: assetId.data,
    publicationMonth: projection.publicationMonth,
    processingRuleVersion: projection.ruleVersion,
    records: projection.records.map((record) => ({
      ...record,
      source: {
        sourceLocalWorkId: fixed.sourceLocalWorkId!,
        assetId: record.source.assetId,
        originalSha256: fixed.originalSha256!,
        preparedSha256: fixed.preparedSha256,
      },
    })),
  };
}
