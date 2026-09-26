import { z } from 'zod';

const Id = z.string().uuid();
const Time = z.string().datetime({ offset: true });
const Field = z.enum(['stationCode', 'year', 'province', 'city']);

export const ExternalSourceManagementQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});

export const ExternalSourceManagementItemSchema = z
  .strictObject({
    sourceId: Id,
    name: z.string().trim().min(1).max(160),
    provider: z.string().trim().min(1).max(160),
    providerPermissionStatus: z.enum([
      'VERIFIED',
      'PENDING',
      'EXPIRED',
      'REVOKED',
      'UNKNOWN',
    ]),
    allowedFields: z.array(Field).max(4),
    allowedActions: z
      .array(z.enum(['source.discover', 'external.directory']))
      .max(2),
    fromYear: z.number().int().min(1800).max(2200).nullable(),
    toYear: z.number().int().min(1800).max(2200).nullable(),
    expiresAt: Time.nullable(),
    licenseBasis: z.string().trim().min(5).max(1000).nullable(),
    eligibleForProposal: z.boolean(),
    connectionStatus: z.literal('UNKNOWN'),
    wiserPolicyStatus: z.enum([
      'none',
      'scheduled',
      'active',
      'expired',
      'revoked',
    ]),
    policyId: Id.nullable(),
    expectedPolicyVersion: z.number().int().min(0).max(2147483646),
  })
  .refine(
    (item) =>
      !item.eligibleForProposal ||
      (item.providerPermissionStatus === 'VERIFIED' &&
        item.fromYear !== null &&
        item.toYear !== null &&
        item.fromYear <= item.toYear &&
        item.expiresAt !== null &&
        item.licenseBasis !== null &&
        item.allowedActions.length > 0 &&
        item.allowedFields.includes('stationCode') &&
        item.allowedFields.includes('year')),
  );

export const ExternalSourceManagementPageSchema = z.strictObject({
  items: z.array(ExternalSourceManagementItemSchema).max(20),
  hasMore: z.boolean(),
  checkedAt: Time,
  managementRoleOptions: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).max(64),
  canPropose: z.boolean(),
});

export type ExternalSourceManagementQuery = z.infer<
  typeof ExternalSourceManagementQuerySchema
>;
export type ExternalSourceManagementPage = z.infer<
  typeof ExternalSourceManagementPageSchema
>;
