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
