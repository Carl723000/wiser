import { z } from 'zod';
import { BusinessQuerySchema as BusinessQueryV1Schema } from './business-v1.ts';
export * from './business-v1.ts';
/** A query scope, never an assertion state or review decision. */
export const BusinessQueryV2Schema = z
  .strictObject({
    ...BusinessQueryV1Schema.shape,
    schemaVersion: z.literal(2),
    status: z.literal('APPROVED_AND_PENDING'),
  })
  .superRefine((value, context) => {
    const legacy = BusinessQueryV1Schema.safeParse({
      ...value,
      schemaVersion: 1,
      status: 'APPROVED',
    });
    if (!legacy.success)
      for (const issue of legacy.error.issues)
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
  });
export const BusinessQuerySchema = z.union([
  BusinessQueryV1Schema,
  BusinessQueryV2Schema,
]);
export type BusinessQuery = z.infer<typeof BusinessQuerySchema>;
export type BusinessQueryStatus = BusinessQuery['status'];
export function businessQueryStatuses(
  status: BusinessQueryStatus,
): readonly Exclude<BusinessQueryStatus, 'APPROVED_AND_PENDING'>[] {
  return status === 'APPROVED_AND_PENDING'
    ? (['APPROVED', 'PENDING_REVIEW'] as const)
    : [status];
}
