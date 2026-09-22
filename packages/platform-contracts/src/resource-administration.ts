import { z } from 'zod';
import {
  ResourceAccessActionSchema,
  ResourceAccessReferenceSchema,
  resourceAccessReferenceKey,
} from './resource-access.ts';
const Id = z.string().uuid();
const Version = z.number().int().min(0).max(2147483646);
const Reason = z.string().trim().min(5).max(1000);
const Actions = z
  .array(ResourceAccessActionSchema)
  .min(1)
  .max(5)
  .refine((v) => new Set(v).size === v.length);
export const ResourcePackageCommandSchema = z.strictObject({
  projectId: Id,
  packageId: Id,
  expectedVersion: Version,
  name: z.string().trim().min(1).max(160),
  resources: z
    .array(ResourceAccessReferenceSchema)
    .min(1)
    .max(1000)
    .refine(
      (refs) =>
        new Set(refs.map(resourceAccessReferenceKey)).size === refs.length,
    ),
  allowedActions: Actions,
  licenseBasis: Reason,
  reason: Reason,
});
export const ResourcePresetCommandSchema = z
  .strictObject({
    projectId: Id,
    presetId: Id,
    expectedVersion: Version,
    name: z.string().trim().min(1).max(160),
    actions: Actions,
    maxDays: z.number().int().min(1).max(366),
    approvalLevel: z.enum(['ordinary', 'important']),
    reason: Reason,
  })
  .refine(
    (preset) =>
      preset.approvalLevel === 'important' ||
      !preset.actions.some((action) =>
        ['original.read', 'result.export', 'external.directory'].includes(
          action,
        ),
      ),
    { message: 'Data egress and provider access require important approval.' },
  );
export const ResourceDefinitionReceiptSchema = z.strictObject({
  kind: z.enum(['package', 'preset']),
  id: Id,
  version: z.number().int().positive(),
  authorityRevision: z.number().int().positive(),
});
export type ResourcePackageCommand = z.infer<
  typeof ResourcePackageCommandSchema
>;
export type ResourcePresetCommand = z.infer<typeof ResourcePresetCommandSchema>;
export type ResourceDefinitionReceipt = z.infer<
  typeof ResourceDefinitionReceiptSchema
>;

export const ResourceDefinitionsQuerySchema = z.strictObject({
  kind: z.enum(['package', 'preset']),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  search: z.string().trim().max(160).default(''),
});
const DefinitionBase = {
  id: Id,
  version: z.number().int().positive(),
  name: z.string().max(160),
  createdAt: z.string().datetime({ offset: true }),
};
export const ResourceDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({
    ...DefinitionBase,
    kind: z.literal('package'),
    resourceCount: z.number().int().min(1).max(1000),
    allowedActions: Actions,
    licenseBasis: Reason,
  }),
  z.object({
    ...DefinitionBase,
    kind: z.literal('preset'),
    actions: Actions,
    maxDays: z.number().int().min(1).max(366),
    approvalLevel: z.enum(['ordinary', 'important']),
  }),
]);
export const ResourceDefinitionsPageSchema = z.object({
  items: z.array(ResourceDefinitionSchema).max(20),
  hasMore: z.boolean(),
  authorityRevision: z.number().int().positive(),
});
export type ResourceDefinitionsQuery = z.infer<typeof ResourceDefinitionsQuerySchema>;
export type ResourceDefinitionsPage = z.infer<typeof ResourceDefinitionsPageSchema>;
