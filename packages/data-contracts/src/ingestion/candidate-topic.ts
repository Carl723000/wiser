import { z } from 'zod';
import {
  CreateIngestionCandidateViewInputSchema,
  IngestionCandidateSavedViewSpecSchema,
} from './candidate-saved.ts';

// Red recovery point: legacy support exists; complete topic v2 is not implemented.
export const IngestionCandidateTopicSpecSchema = z.strictObject({
  schemaVersion: z.literal(2),
});
export const CreateIngestionCandidateTopicInputSchema =
  CreateIngestionCandidateViewInputSchema;
export function candidateSavedSpecVersion(value: unknown): 1 | 2 | null {
  if (IngestionCandidateSavedViewSpecSchema.safeParse(value).success) return 1;
  if (IngestionCandidateTopicSpecSchema.safeParse(value).success) return 2;
  return null;
}
