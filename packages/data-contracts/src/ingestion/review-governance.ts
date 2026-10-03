import { z } from 'zod';
import { PlatformUuidSchema } from '@wiser/platform-contracts';

// Trusted authority metadata, never accepted as an ingestion command input.
export const IngestionReviewPolicySchema = z.strictObject({
  mode: z.literal('REQUIRE_INDEPENDENT_REVIEW'),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type IngestionReviewPolicy = z.infer<typeof IngestionReviewPolicySchema>;
export const IngestionReviewGovernanceContextSchema = z.strictObject({
  frozen: IngestionReviewPolicySchema,
  current: IngestionReviewPolicySchema,
});

export const IngestionSubmissionResponsibilitySchema = z.strictObject({
  actorId: PlatformUuidSchema,
  actorType: z.enum(['human', 'agent', 'service']),
  delegatedBy: PlatformUuidSchema.optional(),
});
