import { z } from 'zod';
import {
  ExplorationQueryInputV111Schema as PreviousInput,
  ExplorationResultV111Schema as PreviousResult,
  QuerySpecSchema as PreviousSpec,
  ExplorationSummarySchema as PreviousSummary,
} from './v111.ts';
import { BusinessQuerySchema } from './business.ts';
export * from './v111.ts';
export * from './business.ts';
export const QuerySpecSchema = z
  .strictObject({
    ...PreviousSpec.shape,
    businessQuery: BusinessQuerySchema.optional(),
    scope: z.literal('project').optional(),
  })
  .superRefine((value, context) => {
    const { businessQuery, scope, ...previous } = value;
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
    if (
      scope &&
      (!businessQuery || value.versions || businessQuery.assertionPins)
    )
      context.addIssue({
        code: 'custom',
        message: 'Project membership is owned by the server',
      });
    if (businessQuery && ((!value.versions && !scope) || value.recordQuery))
      context.addIssue({
        code: 'custom',
        message:
          'Business scope needs fixed source versions and cannot mix a single-file condition',
      });
  });
export const ExplorationQueryInputSchema = z
  .strictObject({ ...PreviousInput.shape, spec: QuerySpecSchema.optional() })
  .superRefine((value, context) => {
    const {
      businessQuery: _business,
      scope: _scope,
      ...spec
    } = value.spec ?? {};
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
const CoverageCount = z.number().int().nonnegative().max(10000);
const VersionCoverageSchema = z.strictObject({
  recordedVersionCount: CoverageCount,
  unknownVersionCount: CoverageCount,
});
export const ExplorationResourceCoverageSchema = z.strictObject({
  temporal: VersionCoverageSchema,
  geometry: VersionCoverageSchema,
  approvedAssertionCount: z.null(),
  effectiveActions: z.null(),
});
export const ExplorationSummarySchema = PreviousSummary.extend({
  coverage: ExplorationResourceCoverageSchema.optional(),
}).superRefine((summary, context) => {
  const coverage = summary.coverage;
  if (!coverage) return;
  for (const kind of ['temporal', 'geometry'] as const)
    if (
      coverage[kind].recordedVersionCount +
        coverage[kind].unknownVersionCount !==
      summary.resourceCount
    )
      context.addIssue({
        code: 'custom',
        path: ['coverage', kind],
        message: 'Coverage counts must partition the authorized resource set',
      });
});
export const ExplorationResultSchema = z
  .strictObject({
    ...PreviousResult.shape,
    spec: QuerySpecSchema,
    summary: ExplorationSummarySchema.optional(),
    membership: z
      .strictObject({
        complete: z.literal(true),
        versionCount: z.number().int().min(0).max(10000),
        assertionCount: z.number().int().min(0).max(100000),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const { businessQuery: _business, scope: _scope, ...spec } = value.spec;
    const { membership, summary, ...previous } = value;
    if ((value.spec.scope === 'project') !== (membership !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['membership'],
        message: 'Project results require complete server membership counts',
      });
    const checked = PreviousResult.safeParse({
      ...previous,
      spec,
      ...(summary
        ? {
            summary: (() => {
              const { coverage: _coverage, ...prior } = summary;
              return prior;
            })(),
          }
        : {}),
    });
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
