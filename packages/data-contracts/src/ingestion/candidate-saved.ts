import { z } from 'zod';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import { CursorSchema, OffsetDateTimeSchema } from '../common.ts';
import { ExplorationMapViewSchema } from '../exploration/saved.ts';
import {
  IngestionCandidateReferenceSchema,
  jsonUtf8Bytes,
} from './candidate.ts';
import {
  IngestionCandidateReadInputSchema,
  IngestionCandidateRecordsInputSchema,
} from './candidate-read.ts';

export const CANDIDATE_SAVED_VIEW_BYTES = 128 * 1024;
export const candidateSavedReferenceKey = (
  ref: z.infer<typeof IngestionCandidateReferenceSchema>,
) =>
  `${ref.kind}:${ref.ingestionId.toLowerCase()}:${ref.processingBatchId.toLowerCase()}:${ref.reviewHash}`;
export const IngestionCandidateSavedReferencesSchema = z
  .array(IngestionCandidateReferenceSchema)
  .min(1)
  .max(100)
  .refine(
    (refs) =>
      new Set(refs.map(candidateSavedReferenceKey)).size === refs.length,
    'Fixed candidate references must be unique',
  );
const page = {
  reference: IngestionCandidateReferenceSchema,
  first: z.number().int().min(1).max(200).default(50),
};
export const IngestionCandidateSavedPageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...page,
    kind: z.literal('assets'),
    afterAssetId: PlatformUuidSchema.optional(),
  }),
  z.strictObject({
    ...page,
    kind: z.literal('records'),
    assetId: PlatformUuidSchema,
    afterRecordId: PlatformUuidSchema.optional(),
  }),
  z.strictObject({
    ...page,
    kind: z.literal('geometry'),
    assetId: PlatformUuidSchema,
    afterRecordId: PlatformUuidSchema.optional(),
  }),
]);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const IngestionCandidateSavedViewSpecSchema = z.strictObject({
  page: IngestionCandidateSavedPageSchema,
  focus: z
    .strictObject({
      reference: IngestionCandidateReferenceSchema,
      assetId: PlatformUuidSchema,
      recordId: PlatformUuidSchema.optional(),
    })
    .optional(),
  map: ExplorationMapViewSchema.optional(),
  period: z
    .strictObject({
      from: month.nullable(),
      to: month.nullable(),
      unit: z.enum(['month', 'year']),
      includeUndated: z.boolean(),
    })
    .refine((p) => p.from === null || p.to === null || p.from <= p.to)
    .optional(),
});
const fixedManifest = {
  references: IngestionCandidateSavedReferencesSchema,
  viewSpec: IngestionCandidateSavedViewSpecSchema,
};
function bound(value: unknown): boolean {
  return jsonUtf8Bytes(value) <= CANDIDATE_SAVED_VIEW_BYTES;
}
function containsSelection(
  value: z.infer<typeof IngestionCandidateSavedViewSpecSchema>,
  references: z.infer<typeof IngestionCandidateSavedReferencesSchema>,
) {
  const members = new Set(references.map(candidateSavedReferenceKey));
  return (
    members.has(candidateSavedReferenceKey(value.page.reference)) &&
    (!value.focus ||
      members.has(candidateSavedReferenceKey(value.focus.reference)))
  );
}
export const CreateIngestionCandidateViewInputSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(160),
    visibility: z.enum(['private', 'project']).default('private'),
    ...fixedManifest,
  })
  .refine(
    (v) => containsSelection(v.viewSpec, v.references),
    'All read selections must belong to the fixed manifest',
  )
  .refine(bound, 'Candidate saved-view input exceeds 128 KiB');
export const IngestionCandidateSavedViewSchema = z.strictObject({
  kind: z.literal('ingestion-candidate-view'),
  viewId: PlatformUuidSchema,
  title: z.string().min(1).max(160),
  visibility: z.enum(['private', 'project']),
  createdAt: OffsetDateTimeSchema,
  revokedAt: OffsetDateTimeSchema.nullable(),
});
export const CreateIngestionCandidateViewOutputSchema = z
  .strictObject({ savedView: IngestionCandidateSavedViewSchema })
  .refine(bound);
export const ListIngestionCandidateViewsInputSchema = z.strictObject({
  first: z.number().int().min(1).max(100).default(20),
  after: CursorSchema.optional(),
});
export const ListIngestionCandidateViewsOutputSchema = z
  .strictObject({
    items: z.array(IngestionCandidateSavedViewSchema).max(100),
    nextCursor: CursorSchema.nullable(),
  })
  .refine(bound);
export const OpenIngestionCandidateViewInputSchema = z.strictObject({
  viewId: PlatformUuidSchema,
});
export const IngestionCandidateSavedRequestSchema = z.discriminatedUnion(
  'capabilityId',
  [
    z.strictObject({
      capabilityId: z.literal('data.ingestion.candidate.get'),
      input: IngestionCandidateReadInputSchema,
    }),
    z.strictObject({
      capabilityId: z.literal('data.ingestion.candidate.records'),
      input: IngestionCandidateRecordsInputSchema,
    }),
    z.strictObject({
      capabilityId: z.literal('data.ingestion.candidate.geometry'),
      input: IngestionCandidateRecordsInputSchema,
    }),
  ],
);
export const OpenIngestionCandidateViewOutputSchema = z
  .strictObject({
    kind: z.literal('ingestion-candidate-view'),
    savedView: IngestionCandidateSavedViewSchema,
    ...fixedManifest,
    request: IngestionCandidateSavedRequestSchema,
  })
  .refine((v) => containsSelection(v.viewSpec, v.references))
  .refine((v) => {
    const page = v.viewSpec.page;
    const id =
      page.kind === 'assets'
        ? 'data.ingestion.candidate.get'
        : page.kind === 'records'
          ? 'data.ingestion.candidate.records'
          : 'data.ingestion.candidate.geometry';
    return (
      v.savedView.revokedAt === null &&
      v.request.capabilityId === id &&
      candidateSavedReferenceKey(v.request.input) ===
        candidateSavedReferenceKey(page.reference) &&
      v.request.input.first === page.first &&
      (page.kind === 'assets' ||
        ('assetId' in v.request.input &&
          v.request.input.assetId.toLowerCase() ===
            page.assetId.toLowerCase())) &&
      Boolean(v.request.input.after) ===
        Boolean(page.kind === 'assets' ? page.afterAssetId : page.afterRecordId)
    );
  }, 'Resume request must describe the saved fixed page')
  .refine(bound);
export const RevokeIngestionCandidateViewInputSchema =
  OpenIngestionCandidateViewInputSchema;
export const RevokeIngestionCandidateViewOutputSchema = z.strictObject({
  viewId: PlatformUuidSchema,
  revoked: z.literal(true),
});
export type IngestionCandidateSavedReferences = z.infer<
  typeof IngestionCandidateSavedReferencesSchema
>;
export type IngestionCandidateSavedViewSpec = z.infer<
  typeof IngestionCandidateSavedViewSpecSchema
>;
