import { z } from 'zod';
import {
  compileResourceAccessScope,
  createPostgresResourceAuthorityLoader,
  type ResourceAuthorityQuery,
  type PlatformDelegationTransactionPool,
} from '@wiser/platform-auth';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
  PlatformSecurityLevelSchema,
  ResourceAccessAuthoritySnapshotSchema,
} from '@wiser/platform-contracts';

const subjectSchema = z.strictObject({
  tenantId: PlatformUuidSchema,
  projectId: PlatformUuidSchema,
  purpose: PlatformPurposeSchema,
});
const rowSchema = z.object({
  actor_id: PlatformUuidSchema,
  actor_type: z.literal('human'),
  tenant_id: PlatformUuidSchema,
  project_id: PlatformUuidSchema,
  scopes: z.array(z.string()),
  max_security_level: PlatformSecurityLevelSchema,
  authz_version: z.coerce.number().int().positive(),
  deadline: z.coerce.date(),
});
const eligibilitySql = `/* candidate.followup.assignee-eligibility: not authentication */
select actor.id actor_id,actor.actor_type,tenant.id tenant_id,project.id project_id,
 coalesce(array_agg(distinct role_scope.scope) filter(where role_scope.scope is not null),array[]::text[]) scopes,
 case coalesce(max(case role.max_security_level when 'L0_PUBLIC' then 0 when 'L1_INTERNAL' then 1 when 'L2_RESTRICTED' then 2 when 'L3_CONFIDENTIAL' then 3 end),0)
 when 0 then 'L0_PUBLIC' when 1 then 'L1_INTERNAL' when 2 then 'L2_RESTRICTED' else 'L3_CONFIDENTIAL' end max_security_level,
 greatest(actor.authz_version,tenant.version,project.version,tenant_membership.membership_version,project_membership.membership_version) authz_version,
 least(statement_timestamp()+interval '60 seconds',tenant_membership.expires_at,project_membership.expires_at,min(binding.expires_at)) deadline
from platform.actors actor
join platform.tenant_memberships tenant_membership on tenant_membership.actor_id=actor.id and tenant_membership.tenant_id=$2::uuid
 and tenant_membership.status='active' and tenant_membership.effective_at<=statement_timestamp()
 and (tenant_membership.expires_at is null or tenant_membership.expires_at>statement_timestamp())
join platform.tenants tenant on tenant.id=tenant_membership.tenant_id and tenant.status='active'
join platform.project_memberships project_membership on project_membership.actor_id=actor.id and project_membership.tenant_id=tenant.id and project_membership.project_id=$3::uuid
 and project_membership.status='active' and project_membership.effective_at<=statement_timestamp()
 and (project_membership.expires_at is null or project_membership.expires_at>statement_timestamp())
join platform.projects project on project.id=project_membership.project_id and project.tenant_id=tenant.id and project.status='active'
join platform.role_bindings binding on binding.actor_id=actor.id and binding.tenant_id=tenant.id
 and (binding.project_id is null or binding.project_id=project.id) and binding.status='active' and binding.effective_at<=statement_timestamp()
 and (binding.expires_at is null or binding.expires_at>statement_timestamp())
join platform.roles role on role.id=binding.role_id and role.status='active'
join platform.role_scopes role_scope on role_scope.role_id=role.id
where actor.id=$1::uuid and actor.actor_type='human' and actor.status='active'
group by actor.id,actor.actor_type,actor.authz_version,tenant.id,tenant.version,project.id,project.version,
 tenant_membership.membership_version,project_membership.membership_version,tenant_membership.expires_at,project_membership.expires_at
limit 1`;
export type CandidateFollowupAssigneeAuthority = ReturnType<
  typeof createCandidateFollowupAssigneeAuthority
>;
/** Current assignment eligibility only. No session is created, claimed or reused. */
export function createCandidateFollowupAssigneeAuthority(
  pool: PlatformDelegationTransactionPool,
  resourceQuery: ResourceAuthorityQuery,
) {
  const loadResource = createPostgresResourceAuthorityLoader(resourceQuery);
  return async (
    rawActorId: string,
    rawSubject: z.infer<typeof subjectSchema>,
  ) => {
    let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
    try {
      const actorId = PlatformUuidSchema.parse(rawActorId).toLowerCase(),
        subject = subjectSchema.parse(rawSubject);
      client = await pool.connect();
      const rows = await client.query(eligibilitySql, [
        actorId,
        subject.tenantId,
        subject.projectId,
      ]);
      if (rows.rows.length !== 1) return null;
      const row = rowSchema.parse(rows.rows[0]);
      if (
        row.actor_id.toLowerCase() !== actorId ||
        row.tenant_id !== subject.tenantId ||
        row.project_id !== subject.projectId ||
        row.deadline.valueOf() <= Date.now() ||
        !row.scopes.includes('data.operation.read') ||
        !row.scopes.includes('data.ingestion.write')
      )
        return null;
      const snapshot = ResourceAccessAuthoritySnapshotSchema.safeParse(
        await loadResource({ authorization: subject, principal: { actorId } }),
      );
      if (
        !snapshot.success ||
        snapshot.data.actorId !== actorId ||
        snapshot.data.tenantId !== subject.tenantId ||
        snapshot.data.projectId !== subject.projectId ||
        snapshot.data.purpose !== subject.purpose
      )
        return null;
      const { revision: _revision, ...scopeInput } = snapshot.data;
      const scope = compileResourceAccessScope(scopeInput);
      if (scope === null) return null;
      const deadline =
        scope.mode === 'managed' && scope.validUntil !== null
          ? new Date(
              Math.min(row.deadline.valueOf(), Date.parse(scope.validUntil)),
            )
          : row.deadline;
      if (deadline.valueOf() <= Date.now()) return null;
      return {
        actorId,
        actorType: row.actor_type,
        delegatedBy: null,
        purpose: subject.purpose,
        deadline: deadline.toISOString(),
        maxSecurityLevel: row.max_security_level,
        policyVersion: row.authz_version,
        maintainer: true as const,
        reviewer: row.scopes.includes('data.publish'),
        resourceScope: scope.mode === 'managed' ? scope : null,
      };
    } catch {
      return null;
    } finally {
      client?.release();
    }
  };
}
