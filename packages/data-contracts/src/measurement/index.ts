import { z } from 'zod';
import { Sha256Schema } from '../common.ts';

const Text = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !!value.trim());
const Code = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !!value.trim());
export const MeasurementTrackSchema = z.enum(['REAL', 'SYNTHETIC']);
export type MeasurementTrack = z.infer<typeof MeasurementTrackSchema>;

/** Fixed source-local references, never newly minted catalog/authority identities. */
export const MeasurementDefinitionReferenceSchema = z.strictObject({
  definitionId: Code,
  definitionVersion: Code,
  sourceId: Code,
  sourceVersionId: Code,
  sourceSha256: Sha256Schema,
});
export type MeasurementDefinitionReference = z.infer<
  typeof MeasurementDefinitionReferenceSchema
>;
export const MeasurementEvidenceSchema = z.strictObject({
  locator: Text,
  text: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => !!value.trim()),
});

/** Trusted review facts; a schema cannot authenticate or issue this decision. */
export const MeasurementReviewSchema = z.strictObject({
  state: z.enum([
    'PENDING_REVIEW',
    'APPROVED',
    'REJECTED',
    'REQUIRES_CORRECTION',
  ]),
  submittedBy: Code,
  reviewedBy: Code.nullable(),
  decisionId: Code.nullable(),
  evidence: MeasurementEvidenceSchema.nullable(),
});
export const MeasurementDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reference: MeasurementDefinitionReferenceSchema,
  track: MeasurementTrackSchema,
  measurementType: z.enum(['CONTINUOUS', 'ORDINAL', 'CODE', 'UNKNOWN']),
  differenceUse: z.enum(['ALLOWED', 'EVIDENCE_ONLY', 'UNKNOWN']),
  sourceDeclaration: z.strictObject({
    state: z.enum(['DECLARED', 'UNKNOWN']),
    evidence: MeasurementEvidenceSchema,
  }),
  professionalReview: MeasurementReviewSchema,
  metric: z.strictObject({
    code: Code,
    definition: Text,
    evidence: MeasurementEvidenceSchema,
  }),
  unit: z
    .strictObject({ code: Code, evidence: MeasurementEvidenceSchema })
    .nullable(),
  method: z
    .strictObject({ code: Code, evidence: MeasurementEvidenceSchema })
    .nullable(),
  temporal: z.strictObject({
    kind: z.enum(['INSTANT', 'PERIOD', 'UNKNOWN']),
    precision: z.enum(['DAY', 'MONTH', 'YEAR', 'UNKNOWN']),
    role: z.enum([
      'OBSERVATION',
      'PUBLICATION',
      'EVENT',
      'ACQUISITION',
      'UNKNOWN',
    ]),
    /** Inclusive calendar units; an instant has length 1. No interpolation. */
    length: z.number().int().min(1).max(1200).nullable(),
    basis: Text,
    evidence: MeasurementEvidenceSchema,
  }),
  spatial: z.strictObject({
    kind: z.enum(['POINT', 'REACH', 'AREA', 'UNKNOWN']),
    support: Text,
    evidence: MeasurementEvidenceSchema,
  }),
  aggregation: z.strictObject({
    rule: z.enum(['SINGLE', 'MEAN', 'SUM', 'WEIGHTED_MEAN', 'UNKNOWN']),
    /** A fixed rule definition, not a free-text scale-note inference. */
    definition: Text,
    evidence: MeasurementEvidenceSchema,
    denominator: z.strictObject({
      kind: z.enum(['NONE', 'OBSERVATIONS', 'AREA', 'LENGTH', 'UNKNOWN']),
      unit: Code.nullable(),
      basis: Text,
      evidence: MeasurementEvidenceSchema,
    }),
  }),
});
export type MeasurementDefinition = z.infer<typeof MeasurementDefinitionSchema>;

export const MeasurementBindingSchema = z.strictObject({
  definition: MeasurementDefinitionReferenceSchema,
  track: MeasurementTrackSchema,
  /** An evidenced source-local sampling/support position, not an identity merge. */
  positionId: Code,
  denominator: z
    .strictObject({
      kind: z.enum(['OBSERVATIONS', 'AREA', 'LENGTH']),
      value: z.number().positive(),
      unit: Code,
      basis: Text,
      evidence: MeasurementEvidenceSchema,
    })
    .nullable(),
});
export type MeasurementBinding = z.infer<typeof MeasurementBindingSchema>;
