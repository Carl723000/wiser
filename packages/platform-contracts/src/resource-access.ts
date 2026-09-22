import { z } from 'zod';

const Id = z.string().uuid();
const Timestamp = z.string().datetime({ offset: true });
export const ResourceAccessActionSchema = z.enum([
  'source.discover',
  'content.read',
  'original.read',
  'result.export',
  'external.directory',
]);
export type ResourceAccessAction = z.infer<typeof ResourceAccessActionSchema>;
export const ResourceAccessReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('version'), dataItemId: Id, versionId: Id }),
  z.strictObject({
    kind: z.literal('external-source'),
    sourceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  }),
]);
export type ResourceAccessReference = z.infer<
  typeof ResourceAccessReferenceSchema
>;
export const ResourceAccessGrantSnapshotSchema = z
  .strictObject({
    id: Id,
    tenantId: Id,
    projectId: Id,
    actorId: Id,
    purpose: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z][a-z0-9-]*$/),
    packageId: Id,
    packageVersion: z.number().int().positive(),
    presetId: Id,
    presetVersion: z.number().int().positive(),
    resources: z.array(ResourceAccessReferenceSchema).min(1).max(1000),
    actions: z.array(ResourceAccessActionSchema).min(1).max(5),
    startsAt: Timestamp,
    expiresAt: Timestamp,
    status: z.enum(['active', 'revoked']),
  })
  .superRefine((grant, ctx) => {
    if (Date.parse(grant.startsAt) >= Date.parse(grant.expiresAt))
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Grant expiry must follow activation.',
      });
    if (new Set(grant.actions).size !== grant.actions.length)
      ctx.addIssue({
        code: 'custom',
        path: ['actions'],
        message: 'Duplicate actions.',
      });
    const keys = grant.resources.map(resourceAccessReferenceKey);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: 'custom',
        path: ['resources'],
        message: 'Duplicate resource references.',
      });
  });
export type ResourceAccessGrantSnapshot = z.infer<
  typeof ResourceAccessGrantSnapshotSchema
>;

/** Identity is an immutable version or an explicit provider source; never a label. */
export function resourceAccessReferenceKey(
  resource: ResourceAccessReference,
): string {
  return resource.kind === 'version'
    ? `version:${resource.dataItemId}:${resource.versionId}`
    : `external-source:${resource.sourceId}`;
}

/** Internal authority input, never accepted directly from a browser request. */
export const ResourceAccessEvaluationSchema = z
  .strictObject({
    mode: z.enum(['legacy', 'managed']),
    tenantId: Id,
    projectId: Id,
    actorId: Id,
    purpose: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z][a-z0-9-]*$/),
    resource: ResourceAccessReferenceSchema,
    action: ResourceAccessActionSchema,
    now: Timestamp,
    baseAllowed: z.boolean(),
    resourceAvailable: z.boolean(),
    providerAllowed: z.boolean(),
    grants: z.array(ResourceAccessGrantSnapshotSchema).max(1000),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.grants.map((g) => g.id)).size !== input.grants.length)
      ctx.addIssue({
        code: 'custom',
        path: ['grants'],
        message: 'Duplicate grant identifiers.',
      });
  });
export type ResourceAccessEvaluation = z.infer<
  typeof ResourceAccessEvaluationSchema
>;
export type ResourceAccessDecision = {
  readonly allowed: boolean;
  readonly reason:
    | 'INVALID_POLICY'
    | 'BASE_DENIED'
    | 'RESOURCE_UNAVAILABLE'
    | 'PROVIDER_DENIED'
    | 'LEGACY'
    | 'NO_GRANT'
    | 'GRANTED';
  readonly grantIds: readonly string[];
  readonly validUntil: string | null;
};

const GrantList = z
  .array(ResourceAccessGrantSnapshotSchema)
  .max(1000)
  .refine(
    (grants) => new Set(grants.map((grant) => grant.id)).size === grants.length,
    { message: 'Duplicate grant identifiers.' },
  );
export const ResourceAccessScopeInputSchema = z.strictObject({
  mode: z.enum(['legacy', 'managed']),
  tenantId: Id,
  projectId: Id,
  actorId: Id,
  purpose: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z][a-z0-9-]*$/),
  now: Timestamp,
  grants: GrantList,
  delegator: z.strictObject({ actorId: Id, grants: GrantList }).optional(),
});
export type ResourceAccessScopeInput = z.infer<
  typeof ResourceAccessScopeInputSchema
>;
export const ResourceAccessScopeSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('legacy') }),
  z.strictObject({
    mode: z.literal('managed'),
    permissions: z.strictObject({
      'source.discover': z.array(ResourceAccessReferenceSchema).max(1000),
      'content.read': z.array(ResourceAccessReferenceSchema).max(1000),
      'original.read': z.array(ResourceAccessReferenceSchema).max(1000),
      'result.export': z.array(ResourceAccessReferenceSchema).max(1000),
      'external.directory': z.array(ResourceAccessReferenceSchema).max(1000),
    }),
    validUntil: Timestamp.nullable(),
  }),
]);
export type ResourceAccessScope = z.infer<typeof ResourceAccessScopeSchema>;
