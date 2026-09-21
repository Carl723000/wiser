import { z } from 'zod';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import { OffsetDateTimeSchema } from '../common.ts';

const YearSchema = z.number().int().min(1800).max(2200);
const LabelSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim() === value &&
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    { message: 'Metadata labels must preserve a nonempty, printable value.' },
  );

export const ExternalMetadataInputSchema = z
  .strictObject({
    sourceId: PlatformUuidSchema,
    fromYear: YearSchema,
    toYear: YearSchema,
    offset: z.number().int().min(0).max(1_000_000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .refine((input) => input.fromYear <= input.toYear, {
    message: 'Invalid year range.',
  });

export const ExternalStationMetadataSchema = z.strictObject({
  stationCode: LabelSchema,
  year: YearSchema,
  province: LabelSchema.optional(),
  city: LabelSchema.optional(),
});

export const ExternalMetadataOutputSchema = z.strictObject({
  sourceId: PlatformUuidSchema,
  status: z.enum(['AVAILABLE', 'EMPTY']),
  items: z.array(ExternalStationMetadataSchema).max(100),
  total: z.number().int().min(0).max(1_000_000),
  nextOffset: z.number().int().min(1).max(1_000_000).optional(),
  checkedAt: OffsetDateTimeSchema,
  timePrecision: z.literal('year'),
});

export type ExternalMetadataInput = z.infer<typeof ExternalMetadataInputSchema>;
export type ExternalMetadataOutput = z.infer<
  typeof ExternalMetadataOutputSchema
>;
