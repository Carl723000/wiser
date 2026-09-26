import { z } from 'zod';
import {
  ResourceAccessActionSchema,
  ResourceAccessReferenceSchema,
  resourceAccessReferenceKey,
} from './resource-access-reference.ts';
const Id = z.string().uuid(),
  Time = z.string().datetime({ offset: true });
/** Trusted current publication/permission policy, not a manager-entered package description. */
export const ResourcePolicyLimitSchema = z
  .strictObject({
    id: Id,
    version: z.number().int().positive(),
    tenantId: Id,
    projectId: Id,
    resource: ResourceAccessReferenceSchema,
    allowedActions: z
      .array(ResourceAccessActionSchema)
      .min(1)
      .max(5)
      .refine((x) => new Set(x).size === x.length),
    managementRoles: z
      .array(
        z
          .string()
          .min(1)
          .max(96)
          .regex(/^[a-zA-Z0-9._:-]+$/),
      )
      .min(1)
      .max(32)
      .refine((x) => new Set(x).size === x.length),
    licenseBasis: z.string().trim().min(5).max(1000),
    status: z.enum(['active', 'revoked']),
    startsAt: Time,
    expiresAt: Time,
    maxGrantDays: z.number().int().min(1).max(366),
  })
  .refine((x) => Date.parse(x.startsAt) < Date.parse(x.expiresAt));
export const ResourcePolicyLimitsSchema = z
  .array(ResourcePolicyLimitSchema)
  .max(10000)
  .refine(
    (rows) =>
      new Set(rows.map((x) => resourceAccessReferenceKey(x.resource))).size ===
      rows.length,
  );
export type ResourcePolicyLimit = z.infer<typeof ResourcePolicyLimitSchema>;
export const ResourceAdministrationEvaluationSchema = z
  .strictObject({
    tenantId: Id,
    projectId: Id,
    baseAllowed: z.boolean(),
    roles: z.array(z.string().min(1).max(96)).max(128),
    now: Time,
    startsAt: Time,
    expiresAt: Time,
    resources: z
      .array(ResourceAccessReferenceSchema)
      .min(1)
      .max(1000)
      .refine(
        (rows) =>
          new Set(rows.map(resourceAccessReferenceKey)).size === rows.length,
      ),
    actions: z
      .array(ResourceAccessActionSchema)
      .min(1)
      .max(5)
      .refine((x) => new Set(x).size === x.length),
    limits: ResourcePolicyLimitsSchema,
  })
  .refine((x) => Date.parse(x.startsAt) < Date.parse(x.expiresAt));
