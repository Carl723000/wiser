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
): Promise<void> {
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
    return;
  }
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
