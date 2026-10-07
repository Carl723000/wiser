import { z } from 'zod';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import { CursorSchema, Sha256Schema } from '../common.ts';
import { ExplorationMapViewSchema } from '../exploration/saved.ts';
import {
  IngestionCandidateReferenceSchema,
  jsonUtf8Bytes,
} from './candidate.ts';
import {
  CANDIDATE_SAVED_VIEW_BYTES,
  IngestionCandidateSavedPageSchema,
  IngestionCandidateSavedReferencesSchema,
  IngestionCandidateSavedViewSpecSchema,
  IngestionCandidateSavedViewSchema,
  IngestionCandidateSavedRequestSchema,
  ListIngestionCandidateViewsInputSchema,
  OpenIngestionCandidateViewInputSchema,
  OpenIngestionCandidateViewOutputSchema,
  candidateSavedReferenceKey,
} from './candidate-saved.ts';

const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const day = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const monthNumber = Number(value.slice(5, 7));
    const dayNumber = Number(value.slice(8, 10));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const maximum =
      monthNumber === 2
        ? leap
          ? 29
          : 28
        : [4, 6, 9, 11].includes(monthNumber)
          ? 30
          : 31;
    return dayNumber <= maximum;
  }, 'Candidate topic day must be a valid calendar date');

export const IngestionCandidateTopicTimeRoleSchema = z.enum([
  'PUBLICATION',
  'OBSERVATION',
  'EVENT',
  'REPORT_PERIOD',
  'UNKNOWN',
]);
const periodFields = {
  timeRole: IngestionCandidateTopicTimeRoleSchema,
  includeUndated: z.boolean(),
};
/** Window granularity and display grouping are explicit, never inferred from v1. */
export const IngestionCandidateTopicPeriodSchema = z
  .discriminatedUnion('windowMode', [
    z.strictObject({
      ...periodFields,
      windowMode: z.literal('month'),
      from: month.nullable(),
      to: month.nullable(),
      displayUnit: z.enum(['month', 'year']),
    }),
    z.strictObject({
      ...periodFields,
      windowMode: z.literal('day'),
      from: day.nullable(),
      to: day.nullable(),
      displayUnit: z.enum(['day', 'month', 'year']),
    }),
  ])
  .refine(
    (value) =>
      value.from === null || value.to === null || value.from <= value.to,
    'Candidate topic window must be ordered',
  );

const recordFields = {
  reference: IngestionCandidateReferenceSchema,
  assetId: PlatformUuidSchema,
  recordId: PlatformUuidSchema,
};
export const IngestionCandidateTopicRecordPinSchema = z.strictObject({
  ...recordFields,
  sourceObjectKey: boundedText(256).optional(),
});
const recordKey = (
  value: z.infer<typeof IngestionCandidateTopicRecordPinSchema>,
) =>
  `${candidateSavedReferenceKey(value.reference)}:${value.assetId.toLowerCase()}:${value.recordId.toLowerCase()}`;
const assetKey = (value: {
  reference: z.infer<typeof IngestionCandidateReferenceSchema>;
  assetId: string;
}) =>
  `${candidateSavedReferenceKey(value.reference)}:${value.assetId.toLowerCase()}`;
function unique<T>(values: T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}
const identifiers = (maximum: number) =>
  z
    .array(boundedText(128))
    .min(1)
    .max(maximum)
    .refine((ids) => unique(ids, (id) => id));

export const IngestionCandidateTopicRulePinSchema = z.strictObject({
  kind: z.enum(['projection', 'readiness', 'requirement', 'impact']),
  ruleId: boundedText(128),
  version: boundedText(128),
});
const dependencyFields = {
  reference: IngestionCandidateReferenceSchema,
  assetId: PlatformUuidSchema,
  sourceHash: Sha256Schema,
  parserVersion: boundedText(128),
};
/** Hashes are server-verified pins; accepted syntax never certifies their authority. */
export const IngestionCandidateTopicDependencyPinSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ ...dependencyFields, kind: z.literal('asset') }),
    z.strictObject({
      ...dependencyFields,
      kind: z.literal('record'),
      recordId: PlatformUuidSchema,
      recordHash: Sha256Schema,
    }),
    z.strictObject({
      ...dependencyFields,
      kind: z.literal('geometry'),
      recordId: PlatformUuidSchema,
      recordHash: Sha256Schema,
      geometryHash: Sha256Schema,
    }),
  ],
);
export const IngestionCandidateTopicRelationPinSchema = z.strictObject({
  relationId: PlatformUuidSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  // Zero is this v2 contract's no-decision pin, not an approval or confidence value.
  decisionVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const bound = (value: unknown) =>
  jsonUtf8Bytes(value) <= CANDIDATE_SAVED_VIEW_BYTES;

export const IngestionCandidateTopicSpecSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    page: IngestionCandidateSavedPageSchema,
    focus: IngestionCandidateSavedViewSpecSchema.shape.focus,
    map: ExplorationMapViewSchema.optional(),
    period: IngestionCandidateTopicPeriodSchema,
    topic: z.strictObject({
      question: boundedText(2_000),
      regionIds: identifiers(32),
      needIds: identifiers(64),
      recordPins: z
        .array(IngestionCandidateTopicRecordPinSchema)
        .max(200)
        .refine((pins) => unique(pins, recordKey)),
    }),
    rulePins: z
      .array(IngestionCandidateTopicRulePinSchema)
      .min(4)
      .max(32)
      .refine(
        (pins) =>
          unique(pins, (pin) => `${pin.kind}:${pin.ruleId}`) &&
          new Set(pins.map((pin) => pin.kind)).size === 4,
        'Complete candidate topics must pin every adopted rule category once per rule ID',
      ),
    dependencyPins: z
      .array(IngestionCandidateTopicDependencyPinSchema)
      .min(1)
      .max(200)
      .refine((pins) =>
        unique(pins, (pin) =>
          pin.kind === 'asset'
            ? `asset:${assetKey(pin)}`
            : `${pin.kind}:${recordKey(pin)}`,
        ),
      ),
    relationPins: z
      .array(IngestionCandidateTopicRelationPinSchema)
      .max(100)
      .refine((pins) => unique(pins, (pin) => pin.relationId.toLowerCase())),
  })
  .superRefine((value, context) => {
    const assets = new Map(
      value.dependencyPins
        .filter((pin) => pin.kind === 'asset')
        .map((pin) => [assetKey(pin), pin]),
    );
    const records = new Set(
      value.dependencyPins.filter((pin) => pin.kind !== 'asset').map(recordKey),
    );
    const selections = new Set(value.topic.recordPins.map(recordKey));
    const recordHashes = new Map<string, string>();
    const consistent = value.dependencyPins.every((pin) => {
      const asset = assets.get(assetKey(pin));
      if (
        asset === undefined ||
        asset.sourceHash !== pin.sourceHash ||
        asset.parserVersion !== pin.parserVersion
      )
        return false;
      if (pin.kind === 'asset') return true;
      const key = recordKey(pin);
      const previous = recordHashes.get(key);
      if (
        !selections.has(key) ||
        (previous !== undefined && previous !== pin.recordHash)
      )
        return false;
      recordHashes.set(key, pin.recordHash);
      return true;
    });
    const page = value.page;
    const pageBound =
      page.kind === 'assets'
        ? [...assets.values()].some(
            (asset) =>
              candidateSavedReferenceKey(asset.reference) ===
              candidateSavedReferenceKey(page.reference),
          )
        : assets.has(assetKey(page));
    const focus = value.focus;
    const focusBound =
      !focus ||
      (assets.has(assetKey(focus)) &&
        (!focus.recordId ||
          selections.has(recordKey({ ...focus, recordId: focus.recordId }))));
    if (
      !consistent ||
      !pageBound ||
      !focusBound ||
      value.topic.recordPins.some((pin) => !records.has(recordKey(pin)))
    )
      context.addIssue({
        code: 'custom',
        path: ['dependencyPins'],
        message:
          'Candidate topic dependencies must fix every selected asset and whole record consistently',
      });
  })
  .refine(bound, 'Candidate topic specification exceeds 128 KiB');

export const CreateIngestionCandidateTopicInputSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(160),
    visibility: z.enum(['private', 'project']).default('private'),
    references: IngestionCandidateSavedReferencesSchema,
    viewSpec: IngestionCandidateTopicSpecSchema,
  })
  .refine((value) => {
    const members = new Set(value.references.map(candidateSavedReferenceKey));
    const spec = value.viewSpec;
    const selected = [
      spec.page.reference,
      ...(spec.focus ? [spec.focus.reference] : []),
      ...spec.topic.recordPins.map((pin) => pin.reference),
      ...spec.dependencyPins.map((pin) => pin.reference),
    ];
    return selected.every((reference) =>
      members.has(candidateSavedReferenceKey(reference)),
    );
  }, 'Every candidate topic selection must belong to the fixed manifest')
  .refine(bound, 'Candidate topic create input exceeds 128 KiB');

/** Explicit storage dispatch only; it neither upgrades legacy data nor grants reads. */
export function candidateSavedSpecVersion(value: unknown): 1 | 2 | null {
  if (IngestionCandidateSavedViewSpecSchema.safeParse(value).success) return 1;
  if (IngestionCandidateTopicSpecSchema.safeParse(value).success) return 2;
  return null;
}

export type IngestionCandidateTopicSpec = z.infer<
  typeof IngestionCandidateTopicSpecSchema
>;
export type CreateIngestionCandidateTopicInput = z.infer<
  typeof CreateIngestionCandidateTopicInputSchema
>;

/** Public topic metadata identifies the actual stored spec without upgrading it. */
export const IngestionCandidateTopicSavedViewSchema =
  IngestionCandidateSavedViewSchema.extend({
    specVersion: z.union([z.literal(1), z.literal(2)]),
  });
const savedTopicV1 = IngestionCandidateTopicSavedViewSchema.extend({
  specVersion: z.literal(1),
});
const savedTopicV2 = IngestionCandidateTopicSavedViewSchema.extend({
  specVersion: z.literal(2),
});
export const CreateIngestionCandidateTopicOutputSchema = z
  .strictObject({ savedView: savedTopicV2 })
  .refine(bound);
export const ListIngestionCandidateTopicsInputSchema =
  ListIngestionCandidateViewsInputSchema;
export const ListIngestionCandidateTopicsOutputSchema = z
  .strictObject({
    items: z.array(IngestionCandidateTopicSavedViewSchema).max(100),
    nextCursor: CursorSchema.nullable(),
  })
  .refine(bound);
export const OpenIngestionCandidateTopicInputSchema =
  OpenIngestionCandidateViewInputSchema;
const readableV1 = z
  .strictObject({
    status: z.literal('READABLE'),
    specVersion: z.literal(1),
    savedView: savedTopicV1,
    references: IngestionCandidateSavedReferencesSchema,
    viewSpec: IngestionCandidateSavedViewSpecSchema,
    request: IngestionCandidateSavedRequestSchema,
  })
  .refine((value) => {
    const { specVersion: _version, ...metadata } = value.savedView;
    return OpenIngestionCandidateViewOutputSchema.safeParse({
      kind: 'ingestion-candidate-view',
      savedView: metadata,
      references: value.references,
      viewSpec: value.viewSpec,
      request: value.request,
    }).success;
  }, 'Legacy topic reads must retain the original fixed view request')
  .refine(bound);
const readableV2 = z
  .strictObject({
    status: z.literal('READABLE'),
    specVersion: z.literal(2),
    savedView: savedTopicV2,
    references: IngestionCandidateSavedReferencesSchema,
    viewSpec: IngestionCandidateTopicSpecSchema,
    request: IngestionCandidateSavedRequestSchema,
  })
  .refine(
    (value) =>
      value.savedView.revokedAt === null &&
      CreateIngestionCandidateTopicInputSchema.safeParse({
        title: value.savedView.title,
        visibility: value.savedView.visibility,
        references: value.references,
        viewSpec: value.viewSpec,
      }).success,
    'Readable topics must retain all fixed selections and remain unrevoked',
  )
  .refine((value) => {
    const page = value.viewSpec.page;
    const capabilityId =
      page.kind === 'assets'
        ? 'data.ingestion.candidate.get'
        : page.kind === 'records'
          ? 'data.ingestion.candidate.records'
          : 'data.ingestion.candidate.geometry';
    return (
      value.request.capabilityId === capabilityId &&
      candidateSavedReferenceKey(value.request.input) ===
        candidateSavedReferenceKey(page.reference) &&
      value.request.input.first === page.first &&
      (page.kind === 'assets' ||
        ('assetId' in value.request.input &&
          value.request.input.assetId.toLowerCase() ===
            page.assetId.toLowerCase())) &&
      Boolean(value.request.input.after) ===
        Boolean(page.kind === 'assets' ? page.afterAssetId : page.afterRecordId)
    );
  }, 'Resume request must describe the saved fixed page')
  .refine(bound);
/** Only the authorized original saver can receive this content-free result. */
export const IngestionCandidateTopicUnavailableSchema = z.strictObject({
  status: z.literal('UNAVAILABLE'),
  viewId: PlatformUuidSchema,
});
export const OpenIngestionCandidateTopicOutputSchema = z
  .union([readableV1, readableV2, IngestionCandidateTopicUnavailableSchema])
  .refine(bound);
export type IngestionCandidateTopicSavedView = z.infer<
  typeof IngestionCandidateTopicSavedViewSchema
>;
export type CreateIngestionCandidateTopicOutput = z.infer<
  typeof CreateIngestionCandidateTopicOutputSchema
>;
export type ListIngestionCandidateTopicsInput = z.infer<
  typeof ListIngestionCandidateTopicsInputSchema
>;
export type ListIngestionCandidateTopicsOutput = z.infer<
  typeof ListIngestionCandidateTopicsOutputSchema
>;
export type OpenIngestionCandidateTopicInput = z.infer<
  typeof OpenIngestionCandidateTopicInputSchema
>;
export type OpenIngestionCandidateTopicOutput = z.infer<
  typeof OpenIngestionCandidateTopicOutputSchema
>;
