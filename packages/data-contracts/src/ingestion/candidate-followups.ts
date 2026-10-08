import { z } from 'zod';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import {
  OffsetDateTimeSchema,
  PageRequestFields,
  Sha256Schema,
} from '../common.ts';
import {
  IngestionCandidateReferenceSchema,
  jsonUtf8Bytes,
} from './candidate.ts';
import { IngestionCandidateGeometrySchema } from './candidate-read.ts';

const Id = PlatformUuidSchema;
const Note = z.string().trim().min(1).max(4096);
export const CandidateFollowupResponsibilitySchema = z
  .strictObject({
    actorId: Id,
    actorType: z.enum(['human', 'agent', 'service']),
    delegatedBy: Id.nullable(),
    purpose: PlatformPurposeSchema.optional(),
  })
  .refine(
    (value) => (value.actorType === 'human') === (value.delegatedBy === null),
    'Authenticated delegation is required',
  );
export const CandidateFollowupEvidenceSchema = z
  .strictObject({
    reference: IngestionCandidateReferenceSchema,
    assetId: Id,
    recordId: Id.optional(),
    sourceHash: Sha256Schema,
    locator: z.string().trim().min(1).max(1024),
    geometry: IngestionCandidateGeometrySchema.optional(),
    sourceCrs: z.string().trim().min(1).max(128).optional(),
  })
  .refine(
    (value) =>
      (value.geometry === undefined) === (value.sourceCrs === undefined) &&
      (value.geometry === undefined || value.recordId !== undefined),
    'Whole geometry requires a record and source CRS',
  );
export const CandidateFollowupRecordEvidenceSchema =
  CandidateFollowupEvidenceSchema.safeExtend({
    recordId: Id,
    geometry: IngestionCandidateGeometrySchema,
    sourceCrs: z.string().trim().min(1).max(128),
  });
export const CandidateFollowupCorrectionSchema = z.strictObject({
  scope: z.literal('WHOLE_RECORD'),
  old: CandidateFollowupRecordEvidenceSchema,
  new: CandidateFollowupRecordEvidenceSchema,
  mappingReason: Note,
});
const bounded = <T extends z.ZodType>(schema: T) =>
  schema.refine(
    (value) => jsonUtf8Bytes(value) <= 131_072,
    'Followup command exceeds its byte budget',
  );
const createFields = {
  ruleId: z.string().trim().min(1).max(128),
  ruleVersion: z.string().trim().min(1).max(128),
  reason: Note,
};
export const CreateCandidateFollowupInputSchema = bounded(
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('GAP'),
      source: CandidateFollowupEvidenceSchema,
      ...createFields,
    }),
    z.strictObject({
      type: z.literal('CORRECTION'),
      source: CandidateFollowupRecordEvidenceSchema,
      ...createFields,
    }),
  ]),
);
const commandFields = {
  followupId: Id,
  expectedVersion: z.number().int().min(1).max(199),
  note: Note,
};
export const ActCandidateFollowupInputSchema = bounded(
  z.discriminatedUnion('action', [
    z.strictObject({ ...commandFields, action: z.literal('CLAIM') }),
    z.strictObject({
      ...commandFields,
      action: z.literal('HANDOFF'),
      targetActorId: Id,
    }),
    z.strictObject({
      ...commandFields,
      action: z.literal('SUPPLEMENT'),
      evidence: z.array(CandidateFollowupEvidenceSchema).min(1).max(64),
      correction: CandidateFollowupCorrectionSchema.optional(),
    }),
    z.strictObject({ ...commandFields, action: z.literal('SUBMIT_REVIEW') }),
    z.strictObject({ ...commandFields, action: z.literal('REOPEN') }),
  ]),
);
export const ReviewCandidateFollowupInputSchema = bounded(
  z.strictObject({ ...commandFields, decision: z.enum(['CLOSE', 'RETURN']) }),
);
export const GetCandidateFollowupInputSchema = z.strictObject({
  followupId: Id,
});
export const ListCandidateFollowupsInputSchema = z.strictObject({
  ...PageRequestFields,
  ...IngestionCandidateReferenceSchema.shape,
  state: z.enum(['OPEN', 'WORKING', 'REVIEW_PENDING', 'CLOSED']).optional(),
});
export const CandidateFollowupStateSchema = z.enum([
  'OPEN',
  'WORKING',
  'REVIEW_PENDING',
  'CLOSED',
]);
export const CandidateFollowupSnapshotSchema = z.strictObject({
  followupId: Id,
  type: z.enum(['GAP', 'CORRECTION']),
  state: CandidateFollowupStateSchema,
  rowVersion: z.number().int().min(1).max(200),
  source: CandidateFollowupEvidenceSchema,
  createdBy: CandidateFollowupResponsibilitySchema,
  evidence: z.array(CandidateFollowupEvidenceSchema).max(64),
  assignee: CandidateFollowupResponsibilitySchema.nullable(),
  responsibilities: z
    .array(CandidateFollowupResponsibilitySchema)
    .min(1)
    .max(1000),
});
export const CandidateFollowupEventSchema = z.strictObject({
  eventId: Id,
  rowVersion: z.number().int().min(1).max(200),
  expectedVersion: z.number().int().min(0).max(199),
  action: z.enum([
    'CREATE',
    'CLAIM',
    'HANDOFF',
    'SUPPLEMENT',
    'SUBMIT_REVIEW',
    'CLOSE',
    'RETURN',
    'REOPEN',
  ]),
  actor: CandidateFollowupResponsibilitySchema,
  target: CandidateFollowupResponsibilitySchema.nullable(),
  stateAfter: CandidateFollowupStateSchema,
  evidence: z.array(CandidateFollowupEvidenceSchema).max(64),
  correction: CandidateFollowupCorrectionSchema.nullable(),
  note: Note,
  createdAt: OffsetDateTimeSchema,
});
export const CandidateFollowupSchema = CandidateFollowupSnapshotSchema.extend({
  ruleId: createFields.ruleId,
  ruleVersion: createFields.ruleVersion,
  reason: Note,
  createdBy: CandidateFollowupResponsibilitySchema,
  createdAt: OffsetDateTimeSchema,
  technicalOnly: z.literal(true),
  events: z.array(CandidateFollowupEventSchema).min(1).max(200),
}).refine(
  (value) =>
    value.events.length === value.rowVersion &&
    value.events.every(
      (event, i) => event.rowVersion === i + 1 && event.expectedVersion === i,
    ),
  'Complete append-only history is required',
);
export const CandidateFollowupOutputSchema = z.strictObject({
  followup: CandidateFollowupSchema,
});
export const ListCandidateFollowupsOutputSchema = z.strictObject({
  items: z.array(CandidateFollowupSchema).max(100),
  nextCursor: z.string().max(8192).nullable(),
});
export type CandidateFollowupEvidence = z.infer<
  typeof CandidateFollowupEvidenceSchema
>;
export type CandidateFollowupResponsibility = z.infer<
  typeof CandidateFollowupResponsibilitySchema
>;
export type CandidateFollowupSnapshot = z.infer<
  typeof CandidateFollowupSnapshotSchema
>;
