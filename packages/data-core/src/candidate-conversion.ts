import {
  IngestionCandidateBatchSchema,
  jsonUtf8Bytes,
} from '@wiser/data-contracts';
import {
  CandidateConversionCheckSchema,
  CandidateWordStructureSchema,
  type CandidateConversionComparisonSummary,
} from '@wiser/data-contracts/candidate-conversion';

export const CANDIDATE_WORD_EQUIVALENCE_RULE = {
  id: 'candidate-word-equivalence',
  version: '1.0.0',
} as const;

/** Bound hostile inputs before recursive schema validation; never invoke accessors. */
function safeStructureInput(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 16 || ++nodes > 300_000) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= 262_144;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      Array.isArray(item)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    seen.add(item);
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(item),
    )) {
      if (Array.isArray(item) && key === 'length') continue;
      if (
        key.length > 256 ||
        !Object.hasOwn(descriptor, 'value') ||
        !visit(descriptor.value, depth + 1)
      )
        return false;
    }
    seen.delete(item);
    return true;
  };
  return visit(value, 0) && jsonUtf8Bytes(value) <= 16 * 1024 * 1024;
}

export type CandidateConversionComparison =
  | {
      readonly kind: 'EQUIVALENT' | 'DIFFERENT';
      readonly summary: CandidateConversionComparisonSummary;
    }
  | { readonly kind: 'UNVERIFIABLE'; readonly reason: 'INVALID_STRUCTURE' };

/** Exact physical structure comparison; normalization cannot hide empty/merged cells. */
export function compareCandidateConversionStructure(
  prepared: unknown,
  reconverted: unknown,
): CandidateConversionComparison {
  if (!safeStructureInput(prepared) || !safeStructureInput(reconverted))
    return { kind: 'UNVERIFIABLE', reason: 'INVALID_STRUCTURE' };
  const left = CandidateWordStructureSchema.safeParse(prepared),
    right = CandidateWordStructureSchema.safeParse(reconverted);
  if (!left.success || !right.success)
    return { kind: 'UNVERIFIABLE', reason: 'INVALID_STRUCTURE' };
  let count = 0;
  const differences: string[] = [];
  const difference = (path: string) => {
    count++;
    if (differences.length < 16) differences.push(path);
  };
  const compare = (a: unknown, b: unknown, path: string): void => {
    if (a === b) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) difference(`${path}.length`);
      for (let index = 0; index < Math.min(a.length, b.length); index++)
        compare(a[index], b[index], `${path}[${index}]`);
    } else if (
      a !== null &&
      b !== null &&
      typeof a === 'object' &&
      typeof b === 'object'
    ) {
      for (const [key, value] of Object.entries(a))
        compare(
          value,
          (b as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
    } else difference(path);
  };
  compare(left.data, right.data, '');
  const cells = left.data.tables.flatMap((table) =>
    table.rows.flatMap((row) => row.cells),
  );
  const summary = {
    tableCount: left.data.tables.length,
    physicalCellCount: cells.length,
    emptyCellCount: cells.filter((cell) => cell.text === '').length,
    paragraphCount: left.data.paragraphs.length,
    monthTitleCount: left.data.monthTitles.length,
    differenceCount: count,
    differences,
  };
  return { kind: count === 0 ? 'EQUIVALENT' : 'DIFFERENT', summary };
}

export type CandidateConversionEligibility =
  | { readonly eligible: true; readonly preparedAssetId: string }
  | {
      readonly eligible: false;
      readonly reason:
        | 'INVALID_INPUT'
        | 'CONVERSION_UNVERIFIED'
        | 'SOURCE_CHANGED'
        | 'SOURCE_NOT_READY'
        | 'UNEXPLAINED_PARTIAL';
    };

/** Caller must first establish current candidate authority and complete record pages. */
export function candidateConversionEligibility(
  batch: unknown,
  check: unknown,
  expectedRule: { readonly id: string; readonly version: string },
): CandidateConversionEligibility {
  const parsedBatch = IngestionCandidateBatchSchema.safeParse(batch),
    parsedCheck = CandidateConversionCheckSchema.safeParse(check);
  if (!parsedBatch.success || !parsedCheck.success)
    return { eligible: false, reason: 'INVALID_INPUT' };
  const b = parsedBatch.data,
    c = parsedCheck.data;
  if (
    c.state !== 'VERIFIED_EQUIVALENT' ||
    c.rule.id !== expectedRule.id ||
    c.rule.version !== expectedRule.version
  )
    return { eligible: false, reason: 'CONVERSION_UNVERIFIED' };
  const sameId = (a: string, other: string) =>
    a.toLowerCase() === other.toLowerCase();
  if (
    !sameId(b.reference.ingestionId, c.reference.ingestionId) ||
    !sameId(b.reference.processingBatchId, c.reference.processingBatchId) ||
    b.reference.reviewHash !== c.reference.reviewHash
  )
    return { eligible: false, reason: 'SOURCE_CHANGED' };
  const original = b.assets.find((asset) =>
    sameId(asset.assetId, c.original.assetId),
  );
  const prepared = b.assets.find((asset) =>
    sameId(asset.assetId, c.prepared.assetId),
  );
  const manifest = b.assets.find((asset) =>
    sameId(asset.assetId, c.manifest.assetId),
  );
  if (
    !original ||
    !prepared ||
    !manifest ||
    original.sourceHash !== c.original.sha256 ||
    prepared.sourceHash !== c.prepared.sha256 ||
    manifest.sourceHash !== c.manifest.sha256
  )
    return { eligible: false, reason: 'SOURCE_CHANGED' };
  if (prepared.status !== 'READY' || prepared.recordCount === null)
    return { eligible: false, reason: 'SOURCE_NOT_READY' };
  if (
    manifest.status !== 'UNSUPPORTED' ||
    manifest.reason !== 'SOURCE_MANIFEST' ||
    b.assets.some(
      (asset) =>
        !['READY', 'EMPTY'].includes(asset.status) &&
        !sameId(asset.assetId, original.assetId) &&
        !sameId(asset.assetId, manifest.assetId),
    )
  )
    return { eligible: false, reason: 'UNEXPLAINED_PARTIAL' };
  return { eligible: true, preparedAssetId: prepared.assetId };
}
