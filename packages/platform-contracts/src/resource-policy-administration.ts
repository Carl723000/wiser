import { z } from 'zod';
import { ResourcePolicyLimitSchema } from './resource-policy-limits.ts';
const Id = z.string().uuid().toLowerCase(),
  Version = z.number().int().min(0).max(2147483646),
  Reason = z.string().trim().min(5).max(1000),
  Time = z.string().datetime({ offset: true });
const PolicyFields = ResourcePolicyLimitSchema.shape;
const Definition = {
  resource: PolicyFields.resource.transform((ref) =>
    ref.kind === 'version'
      ? {
          ...ref,
          dataItemId: ref.dataItemId.toLowerCase(),
          versionId: ref.versionId.toLowerCase(),
        }
      : ref,
  ),
  allowedActions: PolicyFields.allowedActions,
  managementRoles: PolicyFields.managementRoles,
  licenseBasis: PolicyFields.licenseBasis,
  startsAt: Time,
  expiresAt: Time,
  maxGrantDays: PolicyFields.maxGrantDays,
};
export const ResourcePolicyProposalSchema = z
  .strictObject({
    projectId: Id,
    policyId: Id,
    expectedPolicyVersion: Version,
    ...Definition,
    reason: Reason,
  })
  .refine((x) => Date.parse(x.startsAt) < Date.parse(x.expiresAt));
export const ResourcePolicyActionSchema = z.strictObject({
  projectId: Id,
  requestId: Id,
  expectedVersion: Version.min(1),
  reason: Reason,
});
export const ResourcePolicyDecisionSchema = ResourcePolicyActionSchema.extend({
  decision: z.enum(['publish', 'reject']),
});
export const ResourcePolicyRevokeSchema = z.strictObject({
  projectId: Id,
  policyId: Id,
  policyVersion: Version.min(1),
  reason: Reason,
});
export const ResourcePolicyRequestViewSchema = z.strictObject({
  id: Id,
  projectId: Id,
  policyId: Id,
  expectedPolicyVersion: Version,
  ...Definition,
  reason: Reason,
  applicantId: Id,
  status: z.enum(['pending', 'published', 'rejected', 'withdrawn']),
  version: Version.min(1),
  decidedBy: Id.nullable(),
  decisionReason: Reason.nullable(),
  publishedVersion: Version.min(1).nullable(),
  createdAt: Time,
  decidedAt: Time.nullable(),
});
export const ResourcePolicyRequestsQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  status: ResourcePolicyRequestViewSchema.shape.status.optional(),
});
export const ResourcePolicyRequestsPageSchema = z.strictObject({
  items: z
    .array(
      ResourcePolicyRequestViewSchema.extend({
        publicationState: z.enum([
          'none',
          'scheduled',
          'active',
          'expired',
          'revoked',
          'superseded',
        ]),
      }),
    )
    .max(20),
  hasMore: z.boolean(),
  canPropose: z.boolean(),
  canApprove: z.boolean(),
  checkedAt: Time,
});
export const ResourcePolicyRevokeReceiptSchema = z.strictObject({
  policyId: Id,
  policyVersion: Version.min(1),
  status: z.literal('revoked'),
});
export type ResourcePolicyProposal = z.infer<
  typeof ResourcePolicyProposalSchema
>;
export type ResourcePolicyAction = z.infer<typeof ResourcePolicyActionSchema>;
export type ResourcePolicyDecision = z.infer<
  typeof ResourcePolicyDecisionSchema
>;
export type ResourcePolicyRevoke = z.infer<typeof ResourcePolicyRevokeSchema>;
export type ResourcePolicyRequestView = z.infer<
  typeof ResourcePolicyRequestViewSchema
>;
export type ResourcePolicyRequestsQuery = z.infer<
  typeof ResourcePolicyRequestsQuerySchema
>;
export type ResourcePolicyRequestsPage = z.infer<
  typeof ResourcePolicyRequestsPageSchema
>;
export type ResourcePolicyRevokeReceipt = z.infer<
  typeof ResourcePolicyRevokeReceiptSchema
>;
