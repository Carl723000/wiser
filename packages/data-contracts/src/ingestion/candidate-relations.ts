import { z } from 'zod';
import {
  PlatformUuidSchema,
  PlatformPurposeSchema,
} from '@wiser/platform-contracts';
import { Sha256Schema } from '../common.ts';
import {
  RelationCandidateSchema,
  RelationEntitySchema,
} from '../knowledge-relations/index.ts';
import {
  IngestionCandidateReferenceSchema,
  jsonUtf8Bytes,
} from './candidate.ts';

const Id = PlatformUuidSchema;
const RequiredQualifiers = RelationCandidateSchema.shape.qualifiers.extend({
  context: RelationCandidateSchema.shape.qualifiers.shape.context.unwrap(),
});
export const CandidateRelationEntityReferenceSchema = z.strictObject({
  reference: IngestionCandidateReferenceSchema,
  mappingVersion: z.string().min(1).max(128),
  entityKey: z.string().min(1).max(256),
});
export const CandidateRelationEntitySchema = RelationEntitySchema.omit({
  reference: true,
}).extend({
  reference: CandidateRelationEntityReferenceSchema.optional(),
});
export const CandidateRelationEvidenceSchema = z.strictObject({
  reference: IngestionCandidateReferenceSchema,
  assetId: Id,
  recordId: Id.optional(),
  sourceHash: Sha256Schema,
  locator: z.string().trim().min(1).max(1024),
  excerpt: z.string().max(4096).nullable(),
  polarity: z.enum(['SUPPORTS', 'CONTRADICTS']),
});
export const CandidateRelationContentSchema = RelationCandidateSchema.omit({
  subject: true,
  object: true,
  evidence: true,
  supersedesId: true,
})
  .extend({
    qualifiers: RequiredQualifiers,
    subject: CandidateRelationEntitySchema,
    object: CandidateRelationEntitySchema,
    evidence: z.array(CandidateRelationEvidenceSchema).min(1).max(64),
  })
  .refine(
    (value) => jsonUtf8Bytes(value) <= 100_000,
    'Candidate relation exceeds its byte budget',
  );
export const CandidateRelationPinSchema = z.strictObject({
  relationId: Id,
  revision: z.number().int().min(1).max(2_147_483_647),
  decisionVersion: z.number().int().min(0).max(100),
});
export const CandidateRelationReviewResponsibilitySchema = z
  .strictObject({
    actorId: Id,
    actorType: z.enum(['human', 'agent', 'service']),
    delegatedBy: Id.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.actorType === 'human') !== (value.delegatedBy === null))
      context.addIssue({
        code: 'custom',
        message: 'Frozen source responsibility is incomplete',
      });
  });
export const CandidateRelationResponsibilitySchema = z
  .strictObject({
    actorId: Id,
    actorType: z.enum(['human', 'agent', 'service']),
    delegatedBy: Id.nullable(),
    purpose: PlatformPurposeSchema,
  })
  .superRefine((value, context) => {
    if ((value.actorType === 'human') !== (value.delegatedBy === null))
      context.addIssue({
        code: 'custom',
        message:
          'Submission delegation must match the authenticated actor type',
      });
  });
export const CandidateRelationRevisionSchema = z.strictObject({
  revisionId: Id,
  relationId: Id,
  lineageId: Id,
  revision: z.number().int().min(1).max(2_147_483_647),
  supersedesId: Id.nullable(),
  reference: IngestionCandidateReferenceSchema,
  mappingVersion: z.string().min(1).max(128),
  ruleVersion: z.string().min(1).max(128),
  content: CandidateRelationContentSchema,
});
export const CandidateRelationCommandSchema = z
  .strictObject({
    revisions: z.array(CandidateRelationRevisionSchema).min(1).max(100),
  })
  .refine(
    (value) => jsonUtf8Bytes(value) <= 262_144,
    'Candidate relation command exceeds its byte budget',
  );
export const CandidateRelationStateSchema = z.enum([
  'PENDING_REVIEW',
  'CONFIRMED',
  'REJECTED',
  'CORRECTION_REQUIRED',
  'REVOKED',
  'WITHDRAWN',
]);
export type CandidateRelationRevision = z.infer<
  typeof CandidateRelationRevisionSchema
>;
export type CandidateRelationPin = z.infer<typeof CandidateRelationPinSchema>;
export type CandidateRelationResponsibility = z.infer<
  typeof CandidateRelationResponsibilitySchema
>;
export type CandidateRelationState = z.infer<
  typeof CandidateRelationStateSchema
>;
