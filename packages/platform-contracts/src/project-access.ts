import { z } from 'zod';

const Id = z.string().uuid();
const Timestamp = z.string().datetime({ offset: true });
const RoleKey = z
  .string()
  .min(2)
  .max(96)
  .regex(/^[a-z][a-z0-9-]*$/);
const Reason = z.string().trim().min(5).max(1000);

export const ProjectAccessGrantSchema = z.strictObject({
  projectId: Id,
  actorId: Id,
  roleKey: RoleKey,
  expiresAt: Timestamp,
  reason: Reason,
  expectedVersion: z.number().int().nonnegative(),
});
export const ProjectAccessRevokeSchema = z.strictObject({
  projectId: Id,
  actorId: Id,
  reason: Reason,
  expectedVersion: z.number().int().positive(),
});
export const ProjectAccessInviteSchema = z.strictObject({
  projectId: Id,
  email: z.string().trim().email().max(254),
  roleKey: RoleKey,
  expiresAt: Timestamp,
  reason: Reason,
});
export const ProjectAccessInvitationDeliverySchema = z.strictObject({
  projectId: Id,
  invitationId: Id,
  expectedVersion: z.number().int().positive(),
});
export type ProjectAccessInvitationDelivery = z.infer<
  typeof ProjectAccessInvitationDeliverySchema
>;
export const ProjectAccessPageSchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(100).default(''),
});

export type ProjectAccessGrant = z.infer<typeof ProjectAccessGrantSchema>;
export type ProjectAccessRevoke = z.infer<typeof ProjectAccessRevokeSchema>;
export type ProjectAccessInvite = z.infer<typeof ProjectAccessInviteSchema>;
export type ProjectAccessPage = z.infer<typeof ProjectAccessPageSchema>;

export interface ProjectAccessRoleView {
  readonly roleKey: string;
  readonly maxDays: number;
  readonly scopes: readonly string[];
}
export interface ProjectAccessProjectView {
  readonly projectId: string;
  readonly tenantId: string;
  readonly nameZh: string;
  readonly nameEn: string;
  readonly canManage: boolean;
  readonly canApprove: boolean;
  readonly requestsEnabled: boolean;
  readonly memberStatus: string | null;
  readonly expiresAt: string | null;
  readonly roles: readonly string[];
  readonly assignableRoles: readonly ProjectAccessRoleView[];
}
export interface ProjectAccessMemberView {
  readonly actorId: string;
  readonly displayName: string;
  readonly email: string;
  readonly status: string;
  readonly version: number;
  readonly expiresAt: string | null;
  readonly protected: boolean;
  readonly roles: readonly {
    readonly roleKey: string;
    readonly expiresAt: string | null;
  }[];
}
export interface ProjectAccessInvitationView {
  readonly id: string;
  readonly email: string;
  readonly roleKey: string;
  readonly expiresAt: string;
  readonly status: 'pending' | 'sending' | 'delivered' | 'failed' | 'granted';
  readonly deliveryMode: 'email' | 'existing';
  readonly lastErrorCode: 'DELIVERY_UNAVAILABLE' | 'GRANT_UNAVAILABLE' | null;
  readonly acceptedAt: string | null;
  readonly actorId: string | null;
  readonly version: number;
}
export interface ProjectAccessEventView {
  readonly id: string;
  readonly actorId: string;
  readonly subjectId: string;
  readonly action: string;
  readonly reason: string;
  readonly createdAt: string;
}

// Responses are allowlisted independently of database rows and future private fields.
export const ProjectAccessMemberViewSchema = z.object({
  actorId: Id,
  displayName: z.string(),
  email: z.string().email(),
  status: z.string(),
  version: z.number().int().positive(),
  expiresAt: Timestamp.nullable(),
  protected: z.boolean(),
  roles: z.array(
    z.object({ roleKey: RoleKey, expiresAt: Timestamp.nullable() }),
  ),
});
export const ProjectAccessProjectViewSchema = z.object({
  projectId: Id,
  tenantId: Id,
  nameZh: z.string(),
  nameEn: z.string(),
  canManage: z.boolean(),
  canApprove: z.boolean(),
  requestsEnabled: z.boolean(),
  memberStatus: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
  roles: z.array(RoleKey),
  assignableRoles: z.array(
    z.object({
      roleKey: RoleKey,
      maxDays: z.number().int().min(1).max(366),
      scopes: z.array(z.string()),
    }),
  ),
});
export const ProjectAccessMembersPageSchema = z.object({
  items: z.array(ProjectAccessMemberViewSchema).max(50),
  hasMore: z.boolean(),
});
export const ProjectAccessProjectsPageSchema = z.object({
  items: z.array(ProjectAccessProjectViewSchema).max(50),
  hasMore: z.boolean(),
});

export const ProjectAccessInvitationViewSchema = z.object({
  id: Id,
  email: z.string().email(),
  roleKey: RoleKey,
  expiresAt: Timestamp,
  status: z.enum(['pending', 'sending', 'delivered', 'failed', 'granted']),
  actorId: Id.nullable(),
  version: z.number().int().positive(),
  deliveryMode: z.enum(['email', 'existing']),
  lastErrorCode: z
    .enum(['DELIVERY_UNAVAILABLE', 'GRANT_UNAVAILABLE'])
    .nullable(),
  acceptedAt: Timestamp.nullable(),
});
export const ProjectAccessInvitationsPageSchema = z.object({
  items: z.array(ProjectAccessInvitationViewSchema).max(50),
  hasMore: z.boolean(),
});
