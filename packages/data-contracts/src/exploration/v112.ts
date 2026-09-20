import { z } from 'zod';
import {
  ExplorationQueryInputV111Schema as PreviousInput,
  ExplorationResultV111Schema as PreviousResult,
  QuerySpecSchema as PreviousSpec,
} from './v111.ts';
import { BusinessQuerySchema } from './business.ts';
export * from './v111.ts';
export * from './business.ts';
export const QuerySpecSchema = z
  .strictObject({
    ...PreviousSpec.shape,
    businessQuery: BusinessQuerySchema.optional(),
  })
  .superRefine((value, context) => {
    const { businessQuery, ...previous } = value;
    const checked = PreviousSpec.safeParse(previous);
    if (!checked.success)
      for (const issue of checked.error.issues)
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
    if (businessQuery && value.spatialBounds)
      context.addIssue({
        code: 'custom',
        path: ['spatialBounds'],
        message:
          'Viewport filtering is not defined for a business relation scope',
      });
    if (businessQuery && (!value.versions || value.recordQuery))
      context.addIssue({
        code: 'custom',
        message:
          'Business scope needs fixed source versions and cannot mix a single-file condition',
      });
  });
export const ExplorationQueryInputSchema = z
  .strictObject({ ...PreviousInput.shape, spec: QuerySpecSchema.optional() })
  .superRefine((value, context) => {
    const { businessQuery: _business, ...spec } = value.spec ?? {};
    const checked = PreviousInput.safeParse({
      ...value,
      ...(value.spec ? { spec } : {}),
    });
    if (!checked.success)
      for (const issue of checked.error.issues)
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
  });
export const ExplorationResultSchema = z
  .strictObject({ ...PreviousResult.shape, spec: QuerySpecSchema })
  .superRefine((value, context) => {
    const { businessQuery: _business, ...spec } = value.spec;
    const checked = PreviousResult.safeParse({ ...value, spec });
    if (!checked.success)
      for (const issue of checked.error.issues)
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
  });
export type QuerySpec = z.infer<typeof QuerySpecSchema>;
export type ExplorationQueryInput = z.infer<typeof ExplorationQueryInputSchema>;
export type ExplorationResult = z.infer<typeof ExplorationResultSchema>;
