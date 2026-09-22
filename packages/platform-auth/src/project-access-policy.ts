import type { PlatformSecurityLevel } from '@wiser/platform-contracts';

export type ProjectAccessPolicyError =
  | 'NOT_AUTHORIZED'
  | 'SELF_CHANGE_FORBIDDEN'
  | 'ROLE_NOT_ASSIGNABLE'
  | 'INVALID_EXPIRY'
  | 'PROTECTED_MEMBER';

export interface ProjectGrantCheck {
  readonly actorId: string;
  readonly targetActorId: string;
  readonly action: 'manage' | 'approve';
  readonly scopes: readonly string[];
  readonly role: {
    readonly key: string;
    readonly active: boolean;
    readonly scopes: readonly string[];
    readonly securityLevel: PlatformSecurityLevel;
  };
  readonly policy: {
    readonly roleKey: string;
    readonly maxDays: number;
  } | null;
  readonly managerSecurityLevel: PlatformSecurityLevel;
  readonly managerExpiresAt: string | null;
  readonly expiresAt: string;
  readonly now: number;
}

export interface ProjectRemovalCheck {
  readonly actorId: string;
  readonly targetActorId: string;
  readonly scopes: readonly string[];
  readonly targetHasManagementAuthority: boolean;
}

const SECURITY_RANK: Readonly<Record<PlatformSecurityLevel, number>> = {
  L0_PUBLIC: 0,
  L1_INTERNAL: 1,
  L2_RESTRICTED: 2,
  L3_CONFIDENTIAL: 3,
};

/** The caller supplies freshly loaded authority and an explicit clock. */
export function checkProjectGrant(
  input: ProjectGrantCheck,
): ProjectAccessPolicyError | null {
  const required =
    input.action === 'approve'
      ? 'platform.access.approve'
      : 'platform.membership.manage';
  if (!input.scopes.includes(required)) return 'NOT_AUTHORIZED';
  if (input.actorId === input.targetActorId) return 'SELF_CHANGE_FORBIDDEN';
  if (
    input.policy === null ||
    input.policy.roleKey !== input.role.key ||
    !input.role.active ||
    !Number.isInteger(input.policy.maxDays) ||
    input.policy.maxDays < 1 ||
    input.policy.maxDays > 366 ||
    input.role.scopes.some((scope) => scope.startsWith('platform.')) ||
    SECURITY_RANK[input.role.securityLevel] >
      SECURITY_RANK[input.managerSecurityLevel]
  ) {
    return 'ROLE_NOT_ASSIGNABLE';
  }
  const expiry = Date.parse(input.expiresAt);
  const managerExpiry =
    input.managerExpiresAt === null
      ? Infinity
      : Date.parse(input.managerExpiresAt);
  if (
    !Number.isFinite(input.now) ||
    !Number.isFinite(expiry) ||
    Number.isNaN(managerExpiry) ||
    expiry <= input.now ||
    expiry > input.now + input.policy.maxDays * 86_400_000 ||
    expiry > managerExpiry
  ) {
    return 'INVALID_EXPIRY';
  }
  return null;
}

/** Management members are intentionally reserved for the trusted maintenance workflow. */
export function checkProjectRemoval(
  input: ProjectRemovalCheck,
): ProjectAccessPolicyError | null {
  if (!input.scopes.includes('platform.membership.manage'))
    return 'NOT_AUTHORIZED';
  if (input.actorId === input.targetActorId) return 'SELF_CHANGE_FORBIDDEN';
  if (input.targetHasManagementAuthority) return 'PROTECTED_MEMBER';
  return null;
}
