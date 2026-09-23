import { z } from 'zod';

const Id = z.string().uuid();
const SecurityLevel = z.enum([
  'L0_PUBLIC',
  'L1_INTERNAL',
  'L2_RESTRICTED',
  'L3_CONFIDENTIAL',
]);

/** A fixed-version selection list for explicitly appointed source stewards.
 * This is not a general catalog or content search response. */
export const ResourceManagementCatalogQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  search: z.string().trim().max(120).default(''),
});
export const ResourceManagementCatalogPageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        dataItemId: Id,
        versionId: Id,
        name: z.string().min(1),
        sourceOrganization: z.string().min(1),
        versionNumber: z.number().int().positive(),
        securityLevel: SecurityLevel,
        processingStage: z.string().min(1),
        publicationStatus: z.literal('PUBLISHED'),
        acceptanceStatus: z.enum(['PASSED', 'CONDITIONALLY_PASSED']),
        policyId: Id.nullable().default(null),
        expectedPolicyVersion: z.number().int().nonnegative().default(0),
      }),
    )
    .max(20),
  hasMore: z.boolean(),
  checkedAt: z.string().datetime({ offset: true }),
  managementRoleOptions: z
    .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
    .max(64)
    .default([]),
});
export type ResourceManagementCatalogQuery = z.infer<
  typeof ResourceManagementCatalogQuerySchema
>;
export type ResourceManagementCatalogPage = z.infer<
  typeof ResourceManagementCatalogPageSchema
>;
