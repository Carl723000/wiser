begin;
select no_plan();
select has_table('platform_private','resource_policy_versions','source license limits have immutable versions');
select has_table('platform_private','resource_policy_revocations','source revocation retains its policy');
select is((select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform_private' and c.relname in ('resource_policy_versions','resource_policy_revocations') and c.relrowsecurity and c.relforcerowsecurity),2::bigint,'source policy storage forces RLS');
select is((select count(*) from information_schema.role_table_grants where table_schema='platform_private' and table_name in ('resource_policy_versions','resource_policy_revocations') and grantee in ('anon','authenticated','service_role','PUBLIC')),0::bigint,'source policy is not editable through generic clients');
select is((select count(*) from platform_private.resource_policy_versions),0::bigint,'seed does not grant source licenses');
insert into platform_private.resource_access_settings(project_id,tenant_id,enabled_by) values('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000005');
insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by)
values('b2000000-0000-4000-8000-000000000001','89000000-0000-4000-8000-000000000099',1,'{"kind":"external-source","sourceId":"synthetic-public-directory"}',array['source.discover','external.directory'],array['data-steward'],'Synthetic source permission',now(),now()+interval '30 days',30,'10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000005');
select is((select revision from platform_private.resource_access_settings),2::bigint,'source policy publication advances revision');
select throws_ok($$update platform_private.resource_policy_versions set allowed_actions=array['original.read']$$,'22023',null,'a published policy cannot be overwritten');
select throws_ok($$delete from platform_private.resource_policy_versions$$,'22023',null,'source license history cannot be deleted');
select throws_ok($$insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by)
select project_id,policy_id,2,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,created_by from platform_private.resource_policy_versions$$,'23514',null,'source policy requires independent approval');
select throws_ok($$insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by)
select project_id,gen_random_uuid(),2,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by from platform_private.resource_policy_versions$$,'23514',null,'same resource cannot fork its policy identity');
select throws_ok($$insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by)
select project_id,policy_id,3,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by from platform_private.resource_policy_versions$$,'23514',null,'policy versions cannot skip history');
select throws_ok($$insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by)
select project_id,policy_id,2,resource,allowed_actions,array['data-steward','data-steward'],license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by from platform_private.resource_policy_versions$$,'23514',null,'duplicate management roles are rejected');
select throws_ok($$insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by)
select project_id,policy_id,2,resource||'{"extra":"not accepted"}'::jsonb,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by from platform_private.resource_policy_versions$$,'23514',null,'unknown fields cannot be normalized into an approved resource');
insert into platform_private.resource_policy_revocations(project_id,policy_id,version,revoked_by,reason)
values('b2000000-0000-4000-8000-000000000001','89000000-0000-4000-8000-000000000099',1,'10000000-0000-4000-8000-000000000005','Synthetic source revocation');
select is((select revision from platform_private.resource_access_settings),3::bigint,'revocation invalidates earlier authority snapshots');
select throws_ok($$delete from platform_private.resource_policy_revocations$$,'22023',null,'deleting revocation cannot revive permission');
set local role authenticated;
select throws_ok($$select * from platform_private.resource_policy_versions$$,'42501',null,'browser role cannot read private source licenses');
reset role;
set local role service_role;
select throws_ok($$select * from platform_private.resource_policy_versions$$,'42501',null,'generic Auth service role cannot edit project source licenses');
reset role;
select * from finish();
rollback;
