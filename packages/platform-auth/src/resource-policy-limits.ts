import {
  ResourceAdministrationEvaluationSchema,
  resourceAccessReferenceKey,
} from '@wiser/platform-contracts';
/** Pure policy gate. Caller supplies verified roles and the authoritative current policy snapshot. */
export function canAdministerResources(input: unknown): boolean {
  const parsed = ResourceAdministrationEvaluationSchema.safeParse(input);
  if (!parsed.success || !parsed.data.baseAllowed) return false;
  const p = parsed.data,
    now = Date.parse(p.now),
    start = Date.parse(p.startsAt),
    end = Date.parse(p.expiresAt);
  if (end <= now) return false;
  const limits = new Map(
    p.limits.map((x) => [resourceAccessReferenceKey(x.resource), x]),
  );
  return p.resources.every((ref) => {
    const limit = limits.get(resourceAccessReferenceKey(ref));
    return (
      limit !== undefined &&
      limit.tenantId === p.tenantId &&
      limit.projectId === p.projectId &&
      limit.status === 'active' &&
      Date.parse(limit.startsAt) <= now &&
      Date.parse(limit.expiresAt) > now &&
      start >= Date.parse(limit.startsAt) &&
      end <= Date.parse(limit.expiresAt) &&
      end - start <= limit.maxGrantDays * 86400000 &&
      limit.managementRoles.some((role) => p.roles.includes(role)) &&
      p.actions.every((action) => limit.allowedActions.includes(action))
    );
  });
}
