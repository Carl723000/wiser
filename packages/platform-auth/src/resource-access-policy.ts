import {
  ResourceAccessEvaluationSchema,
  resourceAccessReferenceKey,
  type ResourceAccessDecision,
} from '@wiser/platform-contracts';

/** Pure additional resource restriction. Existing session/scope/RLS/provider gates remain mandatory. */
export function evaluateResourceAccess(input: unknown): ResourceAccessDecision {
  const parsed = ResourceAccessEvaluationSchema.safeParse(input);
  const denied = (
    reason: ResourceAccessDecision['reason'],
  ): ResourceAccessDecision => ({
    allowed: false,
    reason,
    grantIds: [],
    validUntil: null,
  });
  if (!parsed.success) return denied('INVALID_POLICY');
  const policy = parsed.data;
  if (!policy.baseAllowed) return denied('BASE_DENIED');
  if (!policy.resourceAvailable) return denied('RESOURCE_UNAVAILABLE');
  if (!policy.providerAllowed) return denied('PROVIDER_DENIED');
  if (policy.mode === 'legacy')
    return { allowed: true, reason: 'LEGACY', grantIds: [], validUntil: null };
  const now = Date.parse(policy.now);
  const key = resourceAccessReferenceKey(policy.resource);
  const matching = policy.grants.filter(
    (grant) =>
      grant.tenantId === policy.tenantId &&
      grant.projectId === policy.projectId &&
      grant.actorId === policy.actorId &&
      grant.purpose === policy.purpose &&
      grant.status === 'active' &&
      Date.parse(grant.startsAt) <= now &&
      Date.parse(grant.expiresAt) > now &&
      grant.actions.includes(policy.action) &&
      grant.resources.some(
        (resource) => resourceAccessReferenceKey(resource) === key,
      ),
  );
  if (!matching.length) return denied('NO_GRANT');
  // Earliest expiry is a revalidation deadline, not permission to cache until the last grant expires.
  const expiry = matching.reduce(
    (first, grant) =>
      Date.parse(grant.expiresAt) < Date.parse(first) ? grant.expiresAt : first,
    matching[0]!.expiresAt,
  );
  return {
    allowed: true,
    reason: 'GRANTED',
    grantIds: matching.map((grant) => grant.id).sort(),
    validUntil: expiry,
  };
}
