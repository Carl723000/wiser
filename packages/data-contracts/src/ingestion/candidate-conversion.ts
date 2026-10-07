import { z } from 'zod';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import { Sha256Schema } from '../common.ts';
import { IngestionCandidateReferenceSchema } from './candidate.ts';

const AssetIdentitySchema = z.strictObject({
  assetId: PlatformUuidSchema,
  sha256: Sha256Schema,
  byteSize: z.number().int().min(1).max(2_147_483_648),
});
const ManifestIdentitySchema = z.strictObject({
  assetId: PlatformUuidSchema,
  sha256: Sha256Schema,
});
const declarationShape = {
  original: AssetIdentitySchema,
  prepared: AssetIdentitySchema,
  manifest: ManifestIdentitySchema,
  sourceLocalWorkId: z.string().min(1).max(256),
  historicalToolVersion: z.string().min(1).max(128).nullable(),
};

function distinctMembers(
  value: {
    original: { assetId: string };
    prepared: { assetId: string };
    manifest: { assetId: string };
  },
  context: z.RefinementCtx,
): void {
  if (
    new Set(
      [
        value.original.assetId,
        value.prepared.assetId,
        value.manifest.assetId,
      ].map((id) => id.toLowerCase()),
    ).size !== 3
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'Original, prepared and manifest must be distinct frozen members',
    });
  }
}

/** A declaration identifies historical files; it cannot confer verification. */
export const CandidateConversionDeclarationSchema = z
  .strictObject({
    schemaVersion: z.literal('wiser.candidate-conversion-pair.v1'),
    ...declarationShape,
  })
  .superRefine(distinctMembers);
export type CandidateConversionDeclaration = z.infer<
  typeof CandidateConversionDeclarationSchema
>;

export const CandidateConversionComparisonSummarySchema = z
  .strictObject({
    tableCount: z.number().int().min(0).max(10_000),
    physicalCellCount: z.number().int().min(0).max(2_000_000),
    emptyCellCount: z.number().int().min(0).max(2_000_000),
    paragraphCount: z.number().int().min(0).max(2_000_000),
    monthTitleCount: z.number().int().min(0).max(2_000_000),
    differenceCount: z.number().int().min(0).max(2_000_000),
    // Paths only: no original cell text, tool stderr or storage address.
    differences: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[a-zA-Z0-9_.[\]-]+$/),
      )
      .max(16),
  })
  .superRefine((value, context) => {
    if (
      value.emptyCellCount > value.physicalCellCount ||
      value.monthTitleCount > value.paragraphCount ||
      value.differences.length !== Math.min(value.differenceCount, 16)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Comparison counts must match the bounded summary',
      });
    }
  });
export type CandidateConversionComparisonSummary = z.infer<
  typeof CandidateConversionComparisonSummarySchema
>;

export const CandidateConversionRuleSchema = z.strictObject({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
});
export const CandidateConversionCheckSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    resultId: PlatformUuidSchema,
    reference: IngestionCandidateReferenceSchema,
    ...declarationShape,
    kind: z.literal('HISTORICAL_EQUIVALENCE'),
    state: z.enum(['VERIFIED_EQUIVALENT', 'NOT_EQUIVALENT', 'UNVERIFIABLE']),
    rule: CandidateConversionRuleSchema,
    tool: z
      .strictObject({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(128),
        digest: Sha256Schema,
      })
      .nullable(),
    reconvertedSha256: Sha256Schema.nullable(),
    comparisonDigest: Sha256Schema.nullable(),
    comparison: CandidateConversionComparisonSummarySchema.nullable(),
    failureReason: z
      .enum([
        'TOOL_UNAVAILABLE',
        'CONVERSION_FAILED',
        'INVALID_STRUCTURE',
        'BUDGET_EXCEEDED',
        'STRUCTURE_DIFFERENT',
      ])
      .nullable(),
  })
  .superRefine((value, context) => {
    distinctMembers(value, context);
    if (value.state === 'UNVERIFIABLE') {
      if (
        value.failureReason === null ||
        value.failureReason === 'STRUCTURE_DIFFERENT' ||
        value.comparison !== null
      )
        context.addIssue({
          code: 'custom',
          message:
            'Unverifiable conversion must retain an honest bounded failure reason',
        });
      return;
    }
    if (
      value.tool === null ||
      value.reconvertedSha256 === null ||
      value.comparisonDigest === null ||
      value.comparison === null
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A compared result requires the actual trusted tool and full comparison digest',
      });
      return;
    }
    if (
      value.state === 'VERIFIED_EQUIVALENT'
        ? value.comparison.differenceCount !== 0 || value.failureReason !== null
        : value.comparison.differenceCount === 0 ||
          value.failureReason !== 'STRUCTURE_DIFFERENT'
    )
      context.addIssue({
        code: 'custom',
        message: 'Conversion state must reflect the actual comparison',
      });
  });
export type CandidateConversionCheck = z.infer<
  typeof CandidateConversionCheckSchema
>;

export const GetCandidateConversionProvenanceInputSchema =
  IngestionCandidateReferenceSchema.extend({
    preparedAssetId: PlatformUuidSchema,
  });
export const GetCandidateConversionProvenanceOutputSchema = z
  .strictObject({
    reference: IngestionCandidateReferenceSchema,
    preparedAssetId: PlatformUuidSchema,
    check: CandidateConversionCheckSchema.nullable(),
  })
  .superRefine((value, context) => {
    const check = value.check;
    if (
      check !== null &&
      (check.prepared.assetId.toLowerCase() !==
        value.preparedAssetId.toLowerCase() ||
        check.reference.ingestionId.toLowerCase() !==
          value.reference.ingestionId.toLowerCase() ||
        check.reference.processingBatchId.toLowerCase() !==
          value.reference.processingBatchId.toLowerCase() ||
        check.reference.reviewHash !== value.reference.reviewHash)
    )
      context.addIssue({
        code: 'custom',
        message:
          'Provenance must retain the fixed candidate and prepared member',
      });
  });
export type GetCandidateConversionProvenanceOutput = z.infer<
  typeof GetCandidateConversionProvenanceOutputSchema
>;

// Full physical Word structure, obtained from both actual byte streams by the trusted Worker.
const WidthSchema = z
  .strictObject({ type: z.string().min(1).max(16), value: z.string().max(32) })
  .nullable();
const TextLocatorSchema = z.strictObject({
  locator: z.string().min(1).max(256),
  text: z.string().max(262_144),
});
export const CandidateWordStructureSchema = z.strictObject({
  tables: z
    .array(
      z.strictObject({
        locator: z.string().min(1).max(256),
        width: WidthSchema,
        gridWidths: z.array(z.string().max(32)).max(1024),
        rows: z
          .array(
            z.strictObject({
              locator: z.string().min(1).max(256),
              cells: z
                .array(
                  z.strictObject({
                    locator: z.string().min(1).max(256),
                    column: z.number().int().min(1).max(1024),
                    columnSpan: z.number().int().min(1).max(1024),
                    verticalMerge: z.enum(['restart', 'continue']).nullable(),
                    width: WidthSchema,
                    text: z.string().max(262_144),
                  }),
                )
                .max(1024),
            }),
          )
          .max(10_000),
      }),
    )
    .max(10_000),
  paragraphs: z.array(TextLocatorSchema).max(100_000),
  monthTitles: z.array(TextLocatorSchema).max(100_000),
});
export type CandidateWordStructure = z.infer<
  typeof CandidateWordStructureSchema
>;
