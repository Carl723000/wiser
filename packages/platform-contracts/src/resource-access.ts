import { z } from 'zod';

const Id = z.string().uuid();
const Timestamp = z.string().datetime({ offset: true });
export {
  ResourceAccessActionSchema,
  ResourceAccessReferenceSchema,
  resourceAccessReferenceKey,
} from './resource-access-reference.ts';
export type {
  ResourceAccessAction,
  ResourceAccessReference,
} from './resource-access-reference.ts';
import {
  ResourceAccessActionSchema,
  ResourceAccessReferenceSchema,
  resourceAccessReferenceKey,
} from './resource-access-reference.ts';
import { ResourcePolicyLimitsSchema } from './resource-policy-limits.ts';
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
  limits: ResourcePolicyLimitsSchema.optional(),
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

export const ResourceAccessAuthoritySnapshotSchema =
  ResourceAccessScopeInputSchema.extend({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  });
export const ResourceAccessContextSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  scope: ResourceAccessScopeSchema,
});
export type ResourceAccessContext = z.infer<typeof ResourceAccessContextSchema>;
