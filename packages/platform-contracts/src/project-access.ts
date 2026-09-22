import { z } from 'zod';

const Id = z.string().uuid();
const Timestamp = z.string().datetime({ offset: true });
const RoleKey = z
  .string()
  .min(2)
  .max(96)
  .regex(/^[a-z][a-z0-9-]*$/);
const Reason = z.string().trim().min(5).max(1000);

export const ProjectAccessGrantSchema = z.never();
export const ProjectAccessRevokeSchema = z.never();
export const ProjectAccessInviteSchema = z.never();
export const ProjectAccessPageSchema = z.never();

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
  readonly status: 'pending' | 'delivered' | 'failed' | 'granted';
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
