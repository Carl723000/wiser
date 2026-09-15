import { z } from 'zod';
import {
  RelationCandidateSchema,
  RelationEntitySchema,
  RelationStatusSchema,
} from '../knowledge-relations/index.ts';
const context =
  RelationCandidateSchema.shape.qualifiers.shape.context.unwrap().shape;
export const BusinessRelationFiltersSchema = z
  .strictObject({
    kind: z.union([z.literal('ALL'), RelationEntitySchema.shape.kind]),
    timeRole: z.union([z.literal('ALL'), context.timeRole]),
    from: z.iso.date().nullable(),
    to: z.iso.date().nullable(),
    includeUndated: z.boolean(),
  })
  .refine(
    (f) => !f.from || !f.to || f.from <= f.to,
    'Reversed business period',
  );
export const BusinessTableSelectionSchema = z
  .strictObject({
    recordId: z.uuid(),
    assertionId: z.uuid(),
    field: z.string().min(1).max(128),
    columns: z
      .array(z.number().int().min(1).max(1024))
      .min(1)
      .max(32)
      .refine((v) => new Set(v).size === v.length),
    keepFields: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(32)
      .refine((v) => new Set(v).size === v.length),
  })
  .refine((v) => v.keepFields.includes(v.field));
export const BusinessQuerySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    status: RelationStatusSchema,
    revisionMode: z.enum(['all', 'current']),
    filters: BusinessRelationFiltersSchema,
    tableSelections: z.array(BusinessTableSelectionSchema).max(256).optional(),
    // Compact immutable authority pins, materialized by the server on initial creation.
    assertionPins: z
      .array(z.tuple([z.uuid(), z.number().int().positive()]))
      .max(2000)
      .optional(),
  })
  .superRefine((v, c) => {
    if (
      v.assertionPins &&
      new Set(v.assertionPins.map((p) => p[0])).size !== v.assertionPins.length
    )
      c.addIssue({ code: 'custom', message: 'Duplicate assertion pin' });
    if (
      v.tableSelections &&
      new Set(v.tableSelections.map((p) => p.recordId + p.assertionId)).size !==
        v.tableSelections.length
    )
      c.addIssue({ code: 'custom', message: 'Duplicate table selection' });
  });
export type BusinessQuery = z.infer<typeof BusinessQuerySchema>;
export type BusinessRelationFilters = z.infer<
  typeof BusinessRelationFiltersSchema
>;
