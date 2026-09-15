import { z } from 'zod';
export const MAX_RELATION_RELATED_SOURCES = 63;
const Id = z.uuid();
const Text = z.string().trim().min(1).max(1024);
export const RelationEntityReferenceSchema = z.strictObject({
  dataItemId: Id,
  versionId: Id,
  mappingVersion: z.string().min(1).max(128),
  entityKey: z.string().min(1).max(256),
});
export const RelationEntitySchema = z.strictObject({
  key: z.string().min(1).max(256),
  label: Text,
  kind: z.enum([
    'ENTERPRISE',
    'MONITORING_POINT',
    'INDICATOR_RECORD',
    'RIVER_REACH',
    'BASIN',
    'EXTERNAL_ENTITY',
    'PERSON',
    'ORGANIZATION',
    'CLAIM',
    'EVENT',
    'DOCUMENT',
    'OBSERVATION',
    'POLICY',
    'MODEL_RUN',
    'PLACE',
  ]),
  externalId: z.string().min(1).max(256).nullable(),
  reference: RelationEntityReferenceSchema.optional(),
});
export const RelationEvidenceSchema = z.strictObject({
  assetId: Id,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  locator: Text,
  excerpt: z.string().max(4096).nullable(),
  polarity: z.enum(['SUPPORTS', 'CONTRADICTS']),
});
export const RelationCandidateSchema = z.strictObject({
  subject: RelationEntitySchema,
  predicate: z.enum([
    'HAS_DECLARED_MONITORING_POINT',
    'HAS_REPORTED_INDICATOR',
    'FLOWS_TO',
    'BELONGS_TO_BASIN',
    'CANDIDATE_RECEIVING_WATER',
    'IDENTITY_MATCH',
    'EXPRESSES_CLAIM',
    'REPORTS_CLAIM',
    'ABOUT_ENTITY',
    'OBSERVES_ENTITY',
    'OCCURRED_IN',
    'CITES_SOURCE',
    'DERIVED_FROM',
    'APPLIES_TO',
    'USES_DATA',
  ]),
  object: RelationEntitySchema,
  qualifiers: z.strictObject({
    measure: Text.nullable(),
    reportedValue: z.string().max(1024).nullable().default(null),
    reportedLimit: z.string().max(1024).nullable().default(null),
    unit: Text.nullable(),
    observedAt: Text.nullable(),
    missing: z.boolean(),
    spatialScope: Text.nullable(),
    limitations: z.array(Text).max(16),
    reportedConclusion: Text.nullable(),
    context: z
      .strictObject({
        recordNature: z.enum([
          'EXPERT_VIEW',
          'REPORTED_OBSERVATION',
          'PLANNING_TARGET',
          'SIMULATION',
          'HISTORICAL_EVENT',
          'INSTITUTIONAL_RECOMMENDATION',
          'SOURCE_RELATION',
          'UNKNOWN',
        ]),
        timeRole: z.enum([
          'STATEMENT_TIME',
          'PUBLICATION_TIME',
          'OBSERVATION_TIME',
          'EVENT_TIME',
          'VALIDITY_PERIOD',
          'UNKNOWN',
        ]),
        validFrom: Text.nullable(),
        validTo: Text.nullable(),
        locationRole: z.enum([
          'SUBJECT_AREA',
          'STUDY_AREA',
          'SAMPLING_LOCATION',
          'VENUE',
          'REFERENCE_LOCATION',
          'UNKNOWN',
        ]),
        applicability: Text,
      })
      .optional(),
  }),
  generation: z.strictObject({
    method: z.enum([
      'SOURCE_TABLE',
      'SOURCE_FIELDS',
      'MANUAL',
      'MODEL_SUGGESTED',
    ]),
    model: Text.nullable(),
  }),
  evidence: z.array(RelationEvidenceSchema).min(1).max(64),
  supersedesId: Id.nullable(),
});
export const RelationStatusSchema = z.enum([
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'CORRECTION_REQUIRED',
]);
const Source = z.strictObject({ dataItemId: Id, versionId: Id });
export const ImportRelationsInputSchema = Source.extend({
  mappingVersion: z.string().min(1).max(128),
  candidates: z.array(RelationCandidateSchema).min(1).max(100),
});
export const RelationAssertionSchema = Source.extend({
  assertionId: Id,
  version: z.number().int().positive(),
  mappingVersion: z.string(),
  candidate: RelationCandidateSchema,
  status: RelationStatusSchema,
  confidence: z.null(),
  createdAt: z.iso.datetime(),
  reviews: z
    .array(
      z.strictObject({
        reviewId: Id,
        reviewerId: Id,
        decision: RelationStatusSchema.exclude(['PENDING_REVIEW']),
        rationale: Text,
        createdAt: z.iso.datetime(),
      }),
    )
    .max(100),
});
export const ImportRelationsOutputSchema = z.strictObject({
  items: z.array(RelationAssertionSchema).max(100),
  createdCount: z.number().int().nonnegative(),
  reusedCount: z.number().int().nonnegative(),
});
export const RelationGetInputSchema = z.strictObject({ assertionId: Id });
export const RelationOutputSchema = z.strictObject({
  assertion: RelationAssertionSchema,
});
export const RelationReviewInputSchema = RelationGetInputSchema.extend({
  expectedVersion: z.number().int().positive(),
  decision: RelationStatusSchema.exclude(['PENDING_REVIEW']),
  rationale: Text,
});
export const RelationListInputV13Schema = Source.extend({
  relatedSources: z.array(Source).max(MAX_RELATION_RELATED_SOURCES).optional(),
  entityReference: RelationEntityReferenceSchema.optional(),
  status: RelationStatusSchema.default('APPROVED'),
  entityKey: z.string().min(1).max(256).optional(),
  mappingVersion: z.string().min(1).max(128).optional(),
  first: z.number().int().min(1).max(100).default(25),
  after: Id.optional(),
});
/** A persisted exploration scope keeps large source manifests out of GET URLs. */
export const RelationListInputSchema = z
  .strictObject({
    ...RelationListInputV13Schema.shape,
    dataItemId: Id.optional(),
    versionId: Id.optional(),
    queryId: Id.optional(),
  })
  .superRefine((input, context) => {
    const valid = input.queryId
      ? input.dataItemId === undefined &&
        input.versionId === undefined &&
        input.relatedSources === undefined
      : input.dataItemId !== undefined && input.versionId !== undefined;
    if (!valid)
      context.addIssue({
        code: 'custom',
        message:
          'Supply an exploration query or an inline source scope, never both',
      });
  });
// Retain published discovery bounds unchanged.

export const RelationListInputV12Schema = RelationListInputV13Schema.extend({
  relatedSources: z.array(Source).max(31).optional(),
});
export const RelationListInputV11Schema = RelationListInputV13Schema.extend({
  relatedSources: z.array(Source).max(11).optional(),
});
export const RelationListOutputSchema = z.strictObject({
  items: z.array(RelationAssertionSchema).max(100),
  totalCount: z.number().int().nonnegative(),
  nextCursor: Id.optional(),
});
export type RelationCandidate = z.infer<typeof RelationCandidateSchema>;
export type RelationAssertion = z.infer<typeof RelationAssertionSchema>;

export const RelationProjectionBatchSchema = z
  .array(
    z.strictObject({
      assertionId: Id,
      tenantId: Id,
      projectId: Id,
      dataItemId: Id,
      versionId: Id,
      mappingVersion: z.string().max(128),
      securityLevel: z.enum([
        'L0_PUBLIC',
        'L1_INTERNAL',
        'L2_RESTRICTED',
        'L3_CONFIDENTIAL',
      ]),
      policyVersion: z.number().int().positive(),
      active: z.boolean(),
      candidate: RelationCandidateSchema,
    }),
  )
  .max(100);
