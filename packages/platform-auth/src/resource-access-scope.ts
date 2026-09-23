import {
  ResourceAccessScopeInputSchema,
  ResourceAccessScopeSchema,
  ResourceAccessActionSchema,
  resourceAccessReferenceKey,
  type ResourceAccessGrantSnapshot,
  type ResourceAccessScope,
  type ResourceAccessAction,
  type ResourceAccessReference,
} from '@wiser/platform-contracts';

/** Pure bounded authority snapshot. Callers must still enforce scope/RLS/provider limits. */
export function compileResourceAccessScope(
  input: unknown,
): ResourceAccessScope | null {
  const parsed = ResourceAccessScopeInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const policy = parsed.data;
  if (policy.mode === 'legacy') return { mode: 'legacy' };
  const now = Date.parse(policy.now);
  const limits =
    policy.limits === undefined
      ? null
      : new Map(
          policy.limits.map((limit) => [
            resourceAccessReferenceKey(limit.resource),
            limit,
          ]),
        );
  let deadline: string | null = null;
  const restrictDeadline = (value: string) => {
    if (
      Date.parse(value) > now &&
      (deadline === null || Date.parse(value) < Date.parse(deadline))
    )
      deadline = value;
  };
  const collect = (
    actorId: string,
    grants: readonly ResourceAccessGrantSnapshot[],
  ) => {
    const maps = Object.fromEntries(
      ResourceAccessActionSchema.options.map((action) => [
        action,
        new Map<string, ResourceAccessReference>(),
      ]),
    ) as Record<ResourceAccessAction, Map<string, ResourceAccessReference>>;
    for (const grant of grants) {
      if (
        grant.status !== 'active' ||
        grant.tenantId !== policy.tenantId ||
        grant.projectId !== policy.projectId ||
        grant.actorId !== actorId ||
        grant.purpose !== policy.purpose
      )
        continue;
      restrictDeadline(grant.startsAt);
      restrictDeadline(grant.expiresAt);
      if (
        Date.parse(grant.startsAt) > now ||
        Date.parse(grant.expiresAt) <= now
      )
        continue;
      for (const action of grant.actions)
        for (const resource of grant.resources) {
          const key = resourceAccessReferenceKey(resource);
          if (limits !== null) {
            const limit = limits.get(key);
            if (
              !limit ||
              limit.tenantId !== policy.tenantId ||
              limit.projectId !== policy.projectId ||
              limit.status !== 'active' ||
              !limit.allowedActions.includes(action)
            )
              continue;
            restrictDeadline(limit.startsAt);
            restrictDeadline(limit.expiresAt);
            if (
              Date.parse(limit.startsAt) > now ||
              Date.parse(limit.expiresAt) <= now
            )
              continue;
          }
          maps[action].set(key, resource);
        }
    }
    return maps;
  };
  const subject = collect(policy.actorId, policy.grants);
  const delegator = policy.delegator
    ? collect(policy.delegator.actorId, policy.delegator.grants)
    : null;
  const permissions = Object.fromEntries(
    ResourceAccessActionSchema.options.map((action) => [
      action,
      [...subject[action].entries()]
        .filter(([key]) => !delegator || delegator[action].has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, resource]) => resource),
    ]),
  );
  const scope = ResourceAccessScopeSchema.safeParse({
    mode: 'managed',
    permissions,
    validUntil: deadline,
  });
  return scope.success ? scope.data : null;
}
