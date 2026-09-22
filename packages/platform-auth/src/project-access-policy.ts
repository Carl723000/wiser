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

export function checkProjectGrant(
  _input: ProjectGrantCheck,
): ProjectAccessPolicyError | null {
  throw new Error('Project grant policy is not implemented.');
}

export function checkProjectRemoval(
  _input: ProjectRemovalCheck,
): ProjectAccessPolicyError | null {
  throw new Error('Project removal policy is not implemented.');
}
