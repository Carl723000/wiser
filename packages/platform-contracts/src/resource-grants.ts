import { z } from 'zod';
import { ResourceAccessActionSchema } from './resource-access.ts';
import { ResourceBatchViewSchema } from './resource-batch.ts';
const Id = z.string().uuid(),
  Time = z.string().datetime({ offset: true });
export const ResourceGrantsQuerySchema = z.strictObject({
  actorId: Id.optional(),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  status: z.enum(['active', 'scheduled', 'expired', 'revoked']).optional(),
});
export const ResourceGrantRecordSchema = z.object({
  id: Id,
  actorId: Id,
  packageId: Id,
  packageVersion: z.number().int().positive(),
  packageName: z.string().max(160),
  presetId: Id,
  presetVersion: z.number().int().positive(),
  presetName: z.string().max(160),
  actions: z.array(ResourceAccessActionSchema).min(1).max(5),
  resourceCount: z.number().int().min(1).max(1000),
  purpose: z.string().max(96),
  startsAt: Time,
  expiresAt: Time,
  status: z.enum(['active', 'scheduled', 'expired', 'revoked']),
  revokedAt: Time.nullable(),
  reason: z.string().max(1000),
  revocationReason: z.string().max(1000).nullable(),
  createdBy: Id,
  approvedBy: Id,
});
export const ResourceGrantsPageSchema = z.object({
  items: z.array(ResourceGrantRecordSchema).max(20),
  hasMore: z.boolean(),
  checkedAt: Time,
});
export const ResourceGrantRevokeCommandSchema = z.strictObject({
  projectId: Id,
  grantId: Id,
  reason: z.string().trim().min(5).max(1000),
});
export const ResourceGrantRenewCommandSchema =
  ResourceGrantRevokeCommandSchema.extend({ expiresAt: Time });
export const ResourceGrantRevokeReceiptSchema = z.object({
  grantId: Id,
  revokedAt: Time,
  alreadyRevoked: z.boolean(),
  otherActiveGrantCount: z.number().int().nonnegative(),
});
export const ResourceGrantRenewReceiptSchema = z.object({
  previousGrantId: Id,
  batch: ResourceBatchViewSchema,
});
export type ResourceGrantsQuery = z.infer<typeof ResourceGrantsQuerySchema>;
export type ResourceGrantsPage = z.infer<typeof ResourceGrantsPageSchema>;
export type ResourceGrantRevokeCommand = z.infer<
  typeof ResourceGrantRevokeCommandSchema
>;
export type ResourceGrantRenewCommand = z.infer<
  typeof ResourceGrantRenewCommandSchema
>;
export type ResourceGrantRevokeReceipt = z.infer<
  typeof ResourceGrantRevokeReceiptSchema
>;
export type ResourceGrantRenewReceipt = z.infer<
  typeof ResourceGrantRenewReceiptSchema
>;
