import {
  ResourceAccessAuthoritySnapshotSchema,
  resourceAccessReferenceKey,
  type PlatformRequestContext,
  type ResourcePackageCommand,
} from '@wiser/platform-contracts';
import type { PlatformDelegationTransactionClient } from './postgres-platform-delegation-service.js';
import { createPostgresResourceAuthorityLoader } from './postgres-resource-authority.js';
import { canAdministerResources } from './resource-policy-limits.js';
import { resourceAdministrationFailure as fail } from './resource-administration-error.js';

/** Process-local, single-use authorization for the trusted metadata-only port.
 * It is never serialized, accepted from HTTP, or installed on a user's context. */
export interface ResourceManagementPermit {
  readonly kind: 'resource-management-metadata';
}
const permits = new WeakMap<
  ResourceManagementPermit,
  { binding: string; validUntil: string }
>();
function binding(
  context: PlatformRequestContext,
  resources: ResourcePackageCommand['resources'],
  actions: ResourcePackageCommand['allowedActions'],
) {
  const a = context.authorization,
    p = context.principal;
  return JSON.stringify([
    p.actorType,
    p.actorId,
    p.authUserId,
    p.sessionId,
    p.authenticationMethod,
    a.tenantId,
    a.projectId,
    a.purpose,
    a.authzVersion,
    a.maxSecurityLevel,
    [...a.roles].sort(),
    [...a.scopes].sort(),
    resources.map(resourceAccessReferenceKey).sort(),
    [...actions].sort(),
  ]);
}
export function consumeResourceManagementPermit(
  permit: unknown,
  context: PlatformRequestContext,
  resources: ResourcePackageCommand['resources'],
  actions: ResourcePackageCommand['allowedActions'],
): string | null {
  if (typeof permit !== 'object' || permit === null) return null;
  const key = permit as ResourceManagementPermit,
    state = permits.get(key);
  permits.delete(key);
  if (
    !state ||
    Date.parse(state.validUntil) <= Date.now() ||
    state.binding !== binding(context, resources, actions)
  )
    return null;
  return state.validUntil;
}

/** Recheck under the administration transaction's project/settings locks.
 * Source authority is independent of the operator's personal content grants. */
export async function assertResourceManagementPolicy(
  session: {
    client: PlatformDelegationTransactionClient;
    context: PlatformRequestContext;
  },
  resources: ResourcePackageCommand['resources'],
  actions: ResourcePackageCommand['allowedActions'],
  window?: { startsAt: string; expiresAt: string },
): Promise<ResourceManagementPermit> {
  const context = session.context,
    auth = context.authorization;
  const parsed = ResourceAccessAuthoritySnapshotSchema.safeParse(
    await createPostgresResourceAuthorityLoader((sql, values) =>
      session.client.query<{ snapshot: unknown }>(sql, values),
    )(context),
  );
  if (!parsed.success) fail('RESOURCE_UNAVAILABLE');
  const snapshot = parsed.data;
  if (
    snapshot.mode !== 'managed' ||
    !snapshot.limits ||
    snapshot.tenantId !== auth.tenantId ||
    snapshot.projectId !== auth.projectId ||
    snapshot.actorId !== context.principal.actorId ||
    snapshot.purpose !== auth.purpose
  )
    fail('RESOURCE_UNAVAILABLE');
  const baseAllowed = auth.scopes.some(
    (scope) =>
      scope === 'platform.membership.manage' ||
      scope === 'platform.access.approve',
  );
  if (window) {
    if (
      !canAdministerResources({
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        baseAllowed,
        roles: auth.roles,
        now: snapshot.now,
        ...window,
        resources,
        actions,
        limits: snapshot.limits,
      })
    )
      fail('RESOURCE_UNAVAILABLE');
  } else {
    // Definitions have no grant term. Check current management/action eligibility;
    // the proposed recipient period is checked separately at every batch transition.
    const now = Date.parse(snapshot.now);
    const limits = new Map(
      snapshot.limits.map((limit) => [
        resourceAccessReferenceKey(limit.resource),
        limit,
      ]),
    );
    if (
      !baseAllowed ||
      !resources.every((ref) => {
        const limit = limits.get(resourceAccessReferenceKey(ref));
        return (
          limit &&
          limit.tenantId === auth.tenantId &&
          limit.projectId === auth.projectId &&
          limit.status === 'active' &&
          Date.parse(limit.startsAt) <= now &&
          Date.parse(limit.expiresAt) > now &&
          limit.managementRoles.some((role) => auth.roles.includes(role)) &&
          actions.every((action) => limit.allowedActions.includes(action))
        );
      })
    )
      fail('RESOURCE_UNAVAILABLE');
  }
  const validUntil = new Date(
    Math.min(
      Date.now() + 5000,
      Date.parse(snapshot.now) + 5000,
      ...snapshot.limits
        .filter((limit) =>
          resources.some(
            (ref) =>
              resourceAccessReferenceKey(ref) ===
              resourceAccessReferenceKey(limit.resource),
          ),
        )
        .map((limit) => Date.parse(limit.expiresAt)),
    ),
  ).toISOString();
  const permit: ResourceManagementPermit = Object.freeze({
    kind: 'resource-management-metadata',
  });
  permits.set(permit, {
    binding: binding(context, resources, actions),
    validUntil,
  });
  return permit;
}
