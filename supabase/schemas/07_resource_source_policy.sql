-- Source license ceilings are trusted control-plane facts, separate from package descriptions.
-- No seed policy: existing legacy projects retain behavior; managed projects require explicit policies.
create table platform_private.resource_policy_versions (
 project_id uuid not null references platform_private.resource_access_settings(project_id) on delete restrict,
 policy_id uuid not null,
 version integer not null check(version>0),
 resource jsonb not null check(platform_private.valid_resource_references(jsonb_build_array(resource))),
 resource_key text generated always as (case when resource->>'kind'='version' then 'v:'||(resource->>'dataItemId')||':'||(resource->>'versionId') else 's:'||(resource->>'sourceId') end) stored,
 allowed_actions text[] not null check(platform_private.valid_resource_actions(allowed_actions)),
 management_roles text[] not null check(cardinality(management_roles) between 1 and 32 and array_position(management_roles,null) is null),
 license_basis text not null check(length(btrim(license_basis)) between 5 and 1000),
 starts_at timestamptz not null,
 expires_at timestamptz not null check(expires_at>starts_at),
 max_grant_days integer not null check(max_grant_days between 1 and 366),
 created_by uuid not null references platform.actors(id) on delete restrict,
 approved_by uuid not null references platform.actors(id) on delete restrict,
 created_at timestamptz not null default now(),
 check(created_by<>approved_by),
 primary key(project_id,policy_id,version),
 unique(project_id,resource_key,version)
);
create table platform_private.resource_policy_revocations (
 project_id uuid not null,
 policy_id uuid not null,
 version integer not null,
 revoked_by uuid not null references platform.actors(id) on delete restrict,
 reason text not null check(length(btrim(reason)) between 5 and 1000),
 revoked_at timestamptz not null default now(),
 primary key(project_id,policy_id,version),
 foreign key(project_id,policy_id,version) references platform_private.resource_policy_versions(project_id,policy_id,version) on delete restrict
);
create function platform_private.guard_resource_policy_version() returns trigger language plpgsql set search_path='' as $$
declare previous platform_private.resource_policy_versions; role_count integer; identity_key text;
begin
 -- Serialize publication for this project; concurrent writers cannot fork an identity/version chain.
 perform 1 from platform_private.resource_access_settings where project_id=new.project_id for update;
 select count(distinct r) into role_count from unnest(new.management_roles) r where r ~ '^[a-zA-Z0-9._:-]{1,96}$';
 if role_count<>cardinality(new.management_roles) then
  raise exception using errcode='23514',message='Invalid source-policy management roles.';
 end if;
 if not platform_private.valid_resource_references(jsonb_build_array(new.resource)) then
  raise exception using errcode='23514',message='Invalid source-policy resource reference.';
 end if;
 -- UUID resource spelling is canonical, avoiding a second identity for the same version.
 if new.resource->>'kind'='version' then
  new.resource := jsonb_build_object('kind','version','dataItemId',((new.resource->>'dataItemId')::uuid)::text,'versionId',((new.resource->>'versionId')::uuid)::text);
 end if;
 identity_key := case when new.resource->>'kind'='version' then 'v:'||(new.resource->>'dataItemId')||':'||(new.resource->>'versionId') else 's:'||(new.resource->>'sourceId') end;
 select * into previous from platform_private.resource_policy_versions
 where project_id=new.project_id and (policy_id=new.policy_id or resource_key=identity_key)
 order by version desc limit 1;
 if found then
  if previous.policy_id<>new.policy_id or previous.resource<>new.resource or new.version<>previous.version+1 then
   raise exception using errcode='23514',message='Source-policy identity and version chain must be preserved.';
  end if;
 elsif new.version<>1 then
  raise exception using errcode='23514',message='Source-policy history must begin at version one.';
 end if;
 return new;
end $$;
create trigger resource_policy_chain before insert on platform_private.resource_policy_versions for each row execute function platform_private.guard_resource_policy_version();
revoke all on function platform_private.guard_resource_policy_version() from public,anon,authenticated,service_role;
do $$ declare relation_name text; begin
 foreach relation_name in array array['resource_policy_versions','resource_policy_revocations'] loop
  execute format('alter table platform_private.%I enable row level security',relation_name);
  execute format('alter table platform_private.%I force row level security',relation_name);
  execute format('revoke all on platform_private.%I from public,anon,authenticated,service_role',relation_name);
  execute format('create trigger %I before update or delete on platform_private.%I for each row execute function platform_private.reject_project_access_history_change()',relation_name||'_immutable',relation_name);
  execute format('create trigger %I after insert on platform_private.%I for each row execute function platform_private.advance_resource_revision()',relation_name||'_revision',relation_name);
 end loop;
end $$;
create index resource_policy_creator_idx on platform_private.resource_policy_versions(created_by);
create index resource_policy_approver_idx on platform_private.resource_policy_versions(approved_by);
create index resource_policy_revoker_idx on platform_private.resource_policy_revocations(revoked_by);
