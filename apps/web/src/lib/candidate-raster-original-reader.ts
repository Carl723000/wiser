import {
  IngestionCandidateReferenceSchema,
  candidateSavedReferenceKey,
  jsonUtf8Bytes,
  type IngestionCandidateAssetPage,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import {
  CANDIDATE_RASTER_BANDS,
  CANDIDATE_RASTER_MAX_COMPRESSED_BYTES,
  RETAINED_RASTER_HASHES,
  validateRasterSelection,
  type CandidateRasterBand,
  type CandidateRasterDecode,
  type CandidateRasterQuality,
  type CandidateRasterWindow,
  type CandidateRasterWindowResult,
} from './candidate-raster-window';
import { runCandidateRasterWorker } from './candidate-raster-worker';
import {
  CandidateReaderError,
  candidateOriginalUrl,
  readCandidatePage,
  readCandidateSavedView,
} from './ingestion-candidate-reader';

const MAX_ASSET_PAGES = 50;
const MAX_ASSET_PAGE_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 200;
let activeRead = false;

export interface CandidateRasterReadInput {
  readonly reference: IngestionCandidateReference;
  readonly locale: 'zh-CN' | 'en';
  readonly savedViewId?: string;
  readonly assets: readonly {
    readonly band: CandidateRasterBand;
    readonly assetId: string;
    readonly sha256: string;
  }[];
  readonly window: CandidateRasterWindow;
  readonly quality: CandidateRasterQuality;
}

function invalid(): never {
  throw new CandidateReaderError('invalid');
}
function current(signal: AbortSignal): void {
  if (signal.aborted) throw new CandidateReaderError('cancelled');
}
function sameReference(
  a: IngestionCandidateReference,
  b: IngestionCandidateReference,
): boolean {
  return candidateSavedReferenceKey(a) === candidateSavedReferenceKey(b);
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
function fixed(input: CandidateRasterReadInput): CandidateRasterReadInput {
  const rawAssets: unknown = input?.assets;
  if (
    !input ||
    !Array.isArray(rawAssets) ||
    rawAssets.length !== 4 ||
    rawAssets.some((asset) => !asset || typeof asset !== 'object')
  )
    invalid();
  const reference = IngestionCandidateReferenceSchema.safeParse(
    input.reference,
  );
  if (
    !reference.success ||
    !['zh-CN', 'en'].includes(input.locale) ||
    (input.savedViewId !== undefined &&
      !PlatformUuidSchema.safeParse(input.savedViewId).success)
  )
    invalid();
  try {
    validateRasterSelection({
      window: input.window,
      quality: input.quality,
      bands: input.assets.map((asset) => asset.band),
    });
  } catch {
    return invalid();
  }
  const ids = new Set<string>();
  for (const asset of input.assets) {
    const id = PlatformUuidSchema.safeParse(asset.assetId);
    if (
      !id.success ||
      ids.has(id.data.toLowerCase()) ||
      asset.sha256 !== RETAINED_RASTER_HASHES[asset.band]
    )
      invalid();
    ids.add(id.data.toLowerCase());
  }
  return input;
}

async function checkedSavedOpen(
  input: CandidateRasterReadInput,
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
      !input.assets.some(
        (asset) => asset.assetId.toLowerCase() === page.assetId.toLowerCase(),
      )) ||
    (opened.viewSpec.focus &&
      (!sameReference(opened.viewSpec.focus.reference, input.reference) ||
        !input.assets.some(
          (asset) =>
            asset.assetId.toLowerCase() ===
            opened.viewSpec.focus!.assetId.toLowerCase(),
        )))
  )
    invalid();
  return JSON.stringify(opened);
}

/** This is current candidate metadata, never a cached or published-version listing. */
async function completeAssets(
  input: CandidateRasterReadInput,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch,
): Promise<string> {
  let after: string | undefined;
  let batch: string | null = null;
  let total: number | null = null;
  let pageBytes = 0;
  let assetCount = 0;
  const seenAssets = new Map<string, string>();
  const seenCursors = new Set<string>();
  for (let index = 0; index < MAX_ASSET_PAGES; index++) {
    current(signal);
    const page = await readCandidatePage(
      'get',
      { ...input.reference, first: PAGE_SIZE, ...(after ? { after } : {}) },
      signal,
      fetch,
    );
    pageBytes += jsonUtf8Bytes(page);
    const currentBatch = snapshot(page);
    if (
      pageBytes > MAX_ASSET_PAGE_BYTES ||
      (batch !== null && batch !== currentBatch)
    )
      invalid();
    batch = currentBatch;
    total = page.totalAssetCount;
    for (const asset of page.assets) {
      const id = asset.assetId.toLowerCase();
      if (seenAssets.has(id)) invalid();
      seenAssets.set(id, asset.sourceHash);
      assetCount++;
    }
    if (assetCount > total) invalid();
    if (page.nextCursor === null) {
      if (assetCount !== total) invalid();
      for (const asset of input.assets)
        if (seenAssets.get(asset.assetId.toLowerCase()) !== asset.sha256)
          throw new CandidateReaderError('stale');
      return JSON.stringify({ batch, assets: [...seenAssets.entries()] });
    }
    if (
      seenCursors.has(page.nextCursor) ||
      assetCount === total ||
      page.assets.length === 0
    )
      invalid();
    seenCursors.add(page.nextCursor);
    after = page.nextCursor;
  }
  return invalid();
}

function statusError(status: number): CandidateReaderError {
  return new CandidateReaderError(
    status === 401 || status === 403
      ? 'denied'
      : [404, 409, 410].includes(status)
        ? 'stale'
        : [413, 415, 422].includes(status)
          ? 'invalid'
          : 'unavailable',
  );
}
function declaredLength(response: Response, remaining: number): number {
  const header = response.headers.get('content-length');
  if (!header || !/^\d+$/.test(header)) invalid();
  const size = Number(header);
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 32 * 1024 * 1024 ||
    size > remaining
  )
    invalid();
  if (
    !/^application\/octet-stream(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  )
    invalid();
  return size;
}
async function originalBytes(
  response: Response,
  size: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (!response.body) invalid();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  let rejectAbort!: (reason: CandidateReaderError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    void reader.cancel().catch(() => {});
    rejectAbort(new CandidateReaderError('cancelled'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    current(signal);
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      current(signal);
      if (next.done) break;
      if (offset + next.value.byteLength > size) invalid();
      bytes.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== size) invalid();
    return bytes.buffer;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (signal.aborted) throw new CandidateReaderError('cancelled');
    if (error instanceof CandidateReaderError) throw error;
    throw new CandidateReaderError('unavailable');
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** Read four exact originals, decode a native window, then recheck present access. */
export async function readCandidateRasterWindow(
  raw: CandidateRasterReadInput,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  decode: (
    input: CandidateRasterDecode,
    signal: AbortSignal,
  ) => Promise<CandidateRasterWindowResult> = runCandidateRasterWorker,
): Promise<CandidateRasterWindowResult> {
  current(signal);
  const input = fixed(raw);
  if (activeRead) throw new CandidateReaderError('unavailable');
  const deadline = AbortSignal.timeout(120_000);
  const operation = AbortSignal.any([signal, deadline]);
  activeRead = true;
  try {
    const initialSaved = await checkedSavedOpen(input, operation, fetch);
    const initialAssets = await completeAssets(input, operation, fetch);
    const originals: CandidateRasterDecode['assets'][number][] = [];
    const sizes = new Map<CandidateRasterBand, number>();
    let remaining = CANDIDATE_RASTER_MAX_COMPRESSED_BYTES;
    for (const band of CANDIDATE_RASTER_BANDS) {
      current(operation);
      const asset = input.assets.find((item) => item.band === band)!;
      const url = candidateOriginalUrl(
        input.reference,
        asset.assetId,
        input.locale,
        input.savedViewId,
      );
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          redirect: 'error',
          signal: operation,
        });
      } catch {
        current(operation);
        throw new CandidateReaderError('unavailable');
      }
      if (!response.ok || response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw statusError(response.status);
      }
      let size: number;
      try {
        size = declaredLength(response, remaining);
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      const bytes = await originalBytes(response, size, operation);
      remaining -= size;
      sizes.set(band, size);
      originals.push({ band, sha256: asset.sha256, bytes });
    }
    current(operation);
    let result: CandidateRasterWindowResult;
    try {
      result = await decode(
        { assets: originals, window: input.window, quality: input.quality },
        operation,
      );
    } catch (error) {
      if (
        operation.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      )
        throw new CandidateReaderError('cancelled');
      throw new CandidateReaderError('invalid');
    }
    current(operation);
    for (const band of CANDIDATE_RASTER_BANDS) {
      const asset = input.assets.find((item) => item.band === band)!;
      const url = candidateOriginalUrl(
        input.reference,
        asset.assetId,
        input.locale,
        input.savedViewId,
      );
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'HEAD',
          cache: 'no-store',
          redirect: 'error',
          signal: operation,
        });
      } catch {
        current(operation);
        throw new CandidateReaderError('unavailable');
      }
      if (!response.ok || response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw statusError(response.status);
      }
      if (
        declaredLength(response, CANDIDATE_RASTER_MAX_COMPRESSED_BYTES) !==
        sizes.get(band)
      )
        throw new CandidateReaderError('stale');
    }
    if ((await completeAssets(input, operation, fetch)) !== initialAssets)
      throw new CandidateReaderError('stale');
    if (
      initialSaved !== null &&
      (await checkedSavedOpen(input, operation, fetch)) !== initialSaved
    )
      throw new CandidateReaderError('stale');
    current(operation);
    return result;
  } catch (error) {
    if (signal.aborted) throw new CandidateReaderError('cancelled');
    if (deadline.aborted) throw new CandidateReaderError('unavailable');
    throw error;
  } finally {
    activeRead = false;
  }
}
