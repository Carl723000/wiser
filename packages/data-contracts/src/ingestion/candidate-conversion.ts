import { z } from 'zod';

// Red checkpoint: a declaration cannot yet establish server conversion trust.
export const CandidateConversionDeclarationSchema = z.strictObject({});
export const CandidateConversionCheckSchema = z.strictObject({});
export const GetCandidateConversionProvenanceInputSchema = z.strictObject({});
export const GetCandidateConversionProvenanceOutputSchema = z.strictObject({});
