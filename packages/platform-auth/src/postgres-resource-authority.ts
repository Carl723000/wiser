import {
  ResourceAccessAuthoritySnapshotSchema,
  type PlatformRequestContext,
} from '@wiser/platform-contracts';
export type ResourceAuthorityQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: readonly { snapshot: unknown }[] }>;

// One statement gives settings, immutable versions, revocations and time the same snapshot.
// Read one beyond the authority bound: overflow fails closed, never a partial authorization.
const LOAD = `
with subjects as (
 select distinct actor_id from unnest(array[$3::uuid,$5::uuid]) actor_id where actor_id is not null
), live_grants as (
 select subject.actor_id,jsonb_build_object(
  'id',g.id,'tenantId',$1::uuid,'projectId',g.project_id,'actorId',g.actor_id,
  'purpose',g.purpose,'packageId',g.package_id,'packageVersion',g.package_version,
  'presetId',g.preset_id,'presetVersion',g.preset_version,
  'resources',package.resources,'actions',preset.actions,'startsAt',g.starts_at,
  'expiresAt',g.expires_at,'status','active') snapshot
 from subjects subject
 cross join lateral (
  select grant_row.* from platform_private.resource_grants grant_row
  where grant_row.project_id=$2::uuid and grant_row.actor_id=subject.actor_id
   and grant_row.purpose=$4::text and grant_row.expires_at>statement_timestamp()
   and not exists(select 1 from platform_private.resource_revocations revoked where revoked.grant_id=grant_row.id)
  order by grant_row.id limit 1001
 ) g
 join platform_private.resource_package_versions package
  on package.project_id=g.project_id and package.package_id=g.package_id and package.version=g.package_version
 join platform_private.resource_preset_versions preset
  on preset.project_id=g.project_id and preset.preset_id=g.preset_id and preset.version=g.preset_version
)
select jsonb_build_object(
 'mode',case when settings.project_id is null then 'legacy' else 'managed' end,
 'tenantId',project.tenant_id,'projectId',project.id,'actorId',$3::uuid,
 'purpose',$4::text,'now',statement_timestamp(),'revision',coalesce(settings.revision,0),
 'grants',coalesce((select jsonb_agg(snapshot) from live_grants where actor_id=$3::uuid),'[]'::jsonb)
) || case when $5::uuid is null then '{}'::jsonb else jsonb_build_object('delegator',jsonb_build_object(
 'actorId',$5::uuid,'grants',coalesce((select jsonb_agg(snapshot) from live_grants where actor_id=$5::uuid),'[]'::jsonb)
)) end snapshot
from platform.projects project
left join platform_private.resource_access_settings settings on settings.project_id=project.id and settings.tenant_id=project.tenant_id
where project.id=$2::uuid and project.tenant_id=$1::uuid and project.status='active'
limit 1
`;
export function createPostgresResourceAuthorityLoader(
  query: ResourceAuthorityQuery,
) {
  return async (context: PlatformRequestContext): Promise<unknown> => {
    const result = await query(LOAD, [
      context.authorization.tenantId,
      context.authorization.projectId,
      context.principal.actorId,
      context.authorization.purpose,
      context.principal.delegatedBy ?? null,
    ]);
    if (result.rows.length !== 1) return null;
    const parsed = ResourceAccessAuthoritySnapshotSchema.safeParse(
      result.rows[0]?.snapshot,
    );
    return parsed.success ? parsed.data : null;
  };
}
