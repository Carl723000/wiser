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

-- Explicit appointments; ordinary membership administrators gain no source-publishing power.
create table platform_private.resource_policy_roles (
 project_id uuid not null references platform_private.resource_access_settings(project_id) on delete restrict,
 role_key text not null check(role_key ~ '^[a-zA-Z0-9._:-]{1,96}$'),
 can_propose boolean not null default false,
 can_approve boolean not null default false,
 active boolean not null default true,
 configured_by uuid not null references platform.actors(id) on delete restrict,
 reason text not null check(length(btrim(reason)) between 5 and 1000),
 configured_at timestamptz not null default now(),
 check(can_propose or can_approve),
 primary key(project_id,role_key)
);
create table platform_private.resource_policy_requests (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references platform_private.resource_access_settings(project_id) on delete restrict,
 policy_id uuid not null,
 expected_policy_version integer not null check(expected_policy_version between 0 and 2147483646),
 resource jsonb not null check(platform_private.valid_resource_references(jsonb_build_array(resource))),
 allowed_actions text[] not null check(platform_private.valid_resource_actions(allowed_actions)),
 management_roles text[] not null check(cardinality(management_roles) between 1 and 32 and array_position(management_roles,null) is null),
 license_basis text not null check(length(btrim(license_basis)) between 5 and 1000),
 starts_at timestamptz not null,
 expires_at timestamptz not null check(expires_at>starts_at),
 max_grant_days integer not null check(max_grant_days between 1 and 366),
 reason text not null check(length(btrim(reason)) between 5 and 1000),
 applicant_id uuid not null references platform.actors(id) on delete restrict,
 -- Retained as audit evidence after session expiry/removal; never used without a live-session check.
 applicant_session_id uuid not null,
 status text not null default 'pending' check(status in ('pending','published','rejected','withdrawn')),
 version integer not null default 1 check(version>0),
 decided_by uuid references platform.actors(id) on delete restrict,
 decided_at timestamptz,
 decision_reason text check(length(btrim(decision_reason)) between 5 and 1000),
 published_version integer,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(project_id,policy_id,published_version) references platform_private.resource_policy_versions(project_id,policy_id,version) on delete restrict,
 check((status in ('pending','withdrawn') and decided_by is null and decided_at is null and decision_reason is null and published_version is null)
 or (status in ('published','rejected') and decided_by is not null and decided_by<>applicant_id and decided_at is not null and decision_reason is not null
 and ((status='published' and published_version is not null and published_version=expected_policy_version+1) or (status='rejected' and published_version is null))))
);
create function platform_private.guard_resource_policy_request() returns trigger language plpgsql set search_path='' as $$
declare role_count integer; published platform_private.resource_policy_versions;
begin
 if tg_op='DELETE' then raise exception using errcode='22023',message='Source proposal history cannot be deleted.'; end if;
 if tg_op='INSERT' then
  if new.status<>'pending' or new.version<>1 then raise exception using errcode='23514',message='Source proposals must begin pending.'; end if;
  select count(distinct r) into role_count from unnest(new.management_roles) r where r ~ '^[a-zA-Z0-9._:-]{1,96}$';
  if role_count<>cardinality(new.management_roles) then raise exception using errcode='23514',message='Invalid source management roles.'; end if;
  if not platform_private.valid_resource_references(jsonb_build_array(new.resource)) then raise exception using errcode='23514',message='Invalid source reference.'; end if;
  if new.resource->>'kind'='version' then
   new.resource := jsonb_build_object('kind','version','dataItemId',((new.resource->>'dataItemId')::uuid)::text,'versionId',((new.resource->>'versionId')::uuid)::text);
  end if;
 else
  if old.status<>'pending' or new.status not in ('published','rejected','withdrawn') or new.version<>old.version+1
  or (to_jsonb(new)-array['status','version','decided_by','decided_at','decision_reason','published_version','updated_at']) is distinct from
     (to_jsonb(old)-array['status','version','decided_by','decided_at','decision_reason','published_version','updated_at']) then
   raise exception using errcode='23514',message='Source proposal evidence is immutable; only pending decisions are allowed.';
  end if;
 end if;
 if new.status='published' then
  select * into published from platform_private.resource_policy_versions where project_id=new.project_id and policy_id=new.policy_id and version=new.published_version;
  if not found or published.resource<>new.resource or published.allowed_actions<>new.allowed_actions or published.management_roles<>new.management_roles
  or published.license_basis<>new.license_basis or published.starts_at<>new.starts_at or published.expires_at<>new.expires_at
  or published.max_grant_days<>new.max_grant_days or published.created_by<>new.applicant_id or published.approved_by<>new.decided_by then
   raise exception using errcode='23514',message='Published source permission must match the independently reviewed proposal.';
  end if;
 end if;
 return new;
end $$;
create trigger resource_policy_request_guard before insert or update or delete on platform_private.resource_policy_requests for each row execute function platform_private.guard_resource_policy_request();
revoke all on function platform_private.guard_resource_policy_request() from public,anon,authenticated,service_role;
do $$ declare relation_name text; begin
 foreach relation_name in array array['resource_policy_roles','resource_policy_requests'] loop
  execute format('alter table platform_private.%I enable row level security',relation_name);
  execute format('alter table platform_private.%I force row level security',relation_name);
  execute format('revoke all on platform_private.%I from public,anon,authenticated,service_role',relation_name);
 end loop;
end $$;
-- Publication and revocation already advance authority. Pending proposals do not change personal access.
create index resource_policy_roles_configurator_idx on platform_private.resource_policy_roles(configured_by);
create index resource_policy_requests_queue_idx on platform_private.resource_policy_requests(project_id,status,created_at,id);
create index resource_policy_requests_published_idx on platform_private.resource_policy_requests(project_id,policy_id,published_version);
create index resource_policy_requests_applicant_idx on platform_private.resource_policy_requests(applicant_id);
create index resource_policy_requests_decider_idx on platform_private.resource_policy_requests(decided_by);
