import { z } from 'zod';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import { OffsetDateTimeSchema, Sha256Schema } from '../common.ts';
import { AnalysisAssetResultSchema } from '../analysis/index.ts';
import { IngestionReviewGovernanceContextSchema } from './review-governance.ts';

/** A candidate is not a catalog version; each parser run retains its own identity. */
export const IngestionCandidateReferenceSchema = z.strictObject({
  kind: z.literal('ingestion-candidate'),
  ingestionId: PlatformUuidSchema,
  reviewHash: Sha256Schema,
  processingBatchId: PlatformUuidSchema,
});
export type IngestionCandidateReference = z.infer<
  typeof IngestionCandidateReferenceSchema
>;

const CandidateAssetSchema = AnalysisAssetResultSchema.safeExtend({
  sourceHash: Sha256Schema,
});

/** Trusted Worker/authority input only; callers cannot issue this checkpoint. */
export const FrozenIngestionCandidateInputSchema = z.strictObject({
  ingestionId: PlatformUuidSchema,
  state: z.literal('REVIEW_REQUIRED'),
  reviewHash: Sha256Schema,
  processingBatchId: PlatformUuidSchema,
  reviewGovernance: IngestionReviewGovernanceContextSchema,
  assets: z
    .array(
      z.strictObject({ assetId: PlatformUuidSchema, sourceHash: Sha256Schema }),
    )
    .min(1)
    .max(10_000),
});

export const IngestionCandidateBatchSchema = z
  .strictObject({
    reference: IngestionCandidateReferenceSchema,
    parserVersion: z.string().min(1).max(128),
    status: z.enum(['READY', 'PARTIAL', 'UNAVAILABLE']),
    assets: z.array(CandidateAssetSchema).min(1).max(10_000),
    createdAt: OffsetDateTimeSchema,
  })
  .superRefine((batch, context) => {
    const ids = batch.assets.map((asset) => asset.assetId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['assets'],
        message: 'Candidate originals must be unique',
      });
    const full = batch.assets.every((asset) =>
      ['READY', 'EMPTY'].includes(asset.status),
    );
    const unavailable = batch.assets.every(
      (asset) => !['READY', 'EMPTY', 'PARTIAL'].includes(asset.status),
    );
    const expected = full ? 'READY' : unavailable ? 'UNAVAILABLE' : 'PARTIAL';
    if (batch.status !== expected)
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Candidate batch status must reflect actual parse outcomes',
      });
  });
export type IngestionCandidateBatch = z.infer<
  typeof IngestionCandidateBatchSchema
>;

// Bound before z.json traverses input. Cycles, deep objects, custom prototypes and
// accessors are never passed into recursive validation or JSON serialization.
function jsonUtf8Bytes(value: unknown): number {
  let size = 0;
  // JSON escapes lone surrogates; iteration preserves each valid surrogate pair.
  // Keep contracts portable without Node Buffer or browser DOM globals.
  for (const character of JSON.stringify(value)) {
    const code = character.charCodeAt(0);
    size +=
      character.length === 2 ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return size;
}

function boundedOriginalValues(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (depth > 16 || ++nodes > 16_384) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 262_144;
    if (typeof item !== 'object' || seen.has(item)) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      Array.isArray(item)
        ? prototype !== Array.prototype && prototype !== null
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    seen.add(item);
    let valid = true;
    const descriptors = Object.getOwnPropertyDescriptors(item) as Record<
      string,
      { readonly value?: unknown }
    >;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (
        !Object.hasOwn(descriptor, 'value') ||
        key.length > 512 ||
        !walk(descriptor.value, depth + 1)
      ) {
        valid = false;
        break;
      }
    }
    seen.delete(item);
    return valid;
  };
  if (!walk(value, 0)) return false;
  return jsonUtf8Bytes(value) <= 262_144;
}

const OriginalValuesSchema = z.preprocess(
  (value, context) => {
    if (!boundedOriginalValues(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate original values exceed the bounded JSON contract',
      });
      return z.NEVER;
    }
    return value;
  },
  z
    .record(z.string().min(1).max(128), z.json())
    .refine((values) => Object.keys(values).length <= 256),
);

export const IngestionCandidateRecordSchema = z.strictObject({
  recordId: PlatformUuidSchema,
  assetId: PlatformUuidSchema,
  index: z.number().int().min(1).max(2_000_000),
  sourceId: z.string().min(1).max(1024).nullable(),
  values: OriginalValuesSchema,
  hasGeometry: z.boolean(),
});
export type IngestionCandidateRecord = z.infer<
  typeof IngestionCandidateRecordSchema
>;

export const IngestionCandidateRecordPageSchema = z
  .strictObject({
    reference: IngestionCandidateReferenceSchema,
    assetId: PlatformUuidSchema,
    columns: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(128),
          label: z.string().min(1).max(512),
        }),
      )
      .max(256),
    records: z.array(IngestionCandidateRecordSchema).max(200),
    nextCursor: z.string().min(1).max(8192).nullable(),
  })
  .superRefine((page, context) => {
    const keys = new Set(page.columns.map((column) => column.key));
    if (keys.size !== page.columns.length)
      context.addIssue({
        code: 'custom',
        path: ['columns'],
        message: 'Candidate column keys must be unique',
      });
    const ids = new Set<string>();
    let previous = 0;
    for (const [index, record] of page.records.entries()) {
      if (
        record.assetId !== page.assetId ||
        ids.has(record.recordId) ||
        record.index <= previous ||
        Object.keys(record.values).some((key) => !keys.has(key))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['records', index],
          message:
            'Candidate rows must preserve one fixed asset, unique identity, source order and declared fields',
        });
      }
      ids.add(record.recordId);
      previous = record.index;
    }
    if (jsonUtf8Bytes(page) > 3 * 1024 * 1024)
      context.addIssue({
        code: 'custom',
        message: 'Candidate record page exceeds the response budget',
      });
  });
export type IngestionCandidateRecordPage = z.infer<
  typeof IngestionCandidateRecordPageSchema
>;
