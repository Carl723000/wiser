import { z } from 'zod';
import { CursorSchema, OffsetDateTimeSchema } from '../common.ts';
import { jsonUtf8Bytes } from './candidate.ts';
import { IngestionCandidateSavedReferencesSchema } from './candidate-saved.ts';
import {
  CandidateRelationEvidenceSchema,
  CandidateRelationPinSchema,
  CandidateRelationRevisionSchema,
  CandidateRelationStateSchema,
} from './candidate-relations.ts';
const bounded = (value: unknown) => jsonUtf8Bytes(value) <= 262_144;
export const CandidateRelationProposalSchema =
  CandidateRelationRevisionSchema.pick({
    reference: true,
    mappingVersion: true,
    ruleVersion: true,
    content: true,
  });
export const CandidateRelationSnapshotSchema = z.strictObject({
  revision: CandidateRelationRevisionSchema,
  decisionVersion: CandidateRelationPinSchema.shape.decisionVersion,
  state: CandidateRelationStateSchema,
  createdAt: OffsetDateTimeSchema,
});
export const CreateCandidateRelationsInputSchema = z
  .strictObject({
    proposals: z.array(CandidateRelationProposalSchema).min(1).max(100),
  })
  .refine(bounded, 'Candidate relation command exceeds 256 KiB');
export const CreateCandidateRelationsOutputSchema = z.strictObject({
  relations: z.array(CandidateRelationSnapshotSchema).min(1).max(100),
});
export const GetCandidateRelationInputSchema =
  CandidateRelationPinSchema.extend({
    references: IngestionCandidateSavedReferencesSchema,
  });
export const GetCandidateRelationOutputSchema = z.strictObject({
  relation: CandidateRelationSnapshotSchema,
});
export const ListCandidateRelationsInputSchema = z.strictObject({
  references: IngestionCandidateSavedReferencesSchema,
  first: z.number().int().min(1).max(100).default(20),
  after: CursorSchema.optional(),
});
export const ListCandidateRelationsOutputSchema = z
  .strictObject({
    relations: z.array(CandidateRelationSnapshotSchema).max(100),
    nextCursor: CursorSchema.nullable(),
  })
  .refine(
    (v) => jsonUtf8Bytes(v) <= 1024 * 1024,
    'Candidate relation page exceeds 1 MiB',
  );
const decision = {
  ...CandidateRelationPinSchema.shape,
  references: IngestionCandidateSavedReferencesSchema,
  rationale: z.string().trim().min(1).max(1024),
};
export const ReviewCandidateRelationInputSchema = z
  .strictObject({
    ...decision,
    status: z.enum(['CONFIRMED', 'REJECTED', 'CORRECTION_REQUIRED', 'REVOKED']),
  })
  .refine(bounded, 'Candidate relation command exceeds 256 KiB');
export const WithdrawCandidateRelationInputSchema = z
  .strictObject(decision)
  .refine(bounded, 'Candidate relation command exceeds 256 KiB');
export const CandidateRelationRebindMappingSchema = z.strictObject({
  from: CandidateRelationEvidenceSchema,
  to: CandidateRelationEvidenceSchema,
});
export const RebindCandidateRelationInputSchema = z
  .strictObject({
    ...CandidateRelationPinSchema.shape,
    references: IngestionCandidateSavedReferencesSchema,
    replacement: CandidateRelationProposalSchema,
    mapping: z.array(CandidateRelationRebindMappingSchema).min(1).max(64),
  })
  .refine(bounded, 'Candidate relation command exceeds 256 KiB');
export const RebindCandidateRelationOutputSchema =
  GetCandidateRelationOutputSchema;
export const ReviewCandidateRelationOutputSchema =
  GetCandidateRelationOutputSchema;
export const WithdrawCandidateRelationOutputSchema =
  GetCandidateRelationOutputSchema;
export type CandidateRelationSnapshot = z.infer<
  typeof CandidateRelationSnapshotSchema
>;
