-- Additional resource authority belongs to the existing Supabase control plane.
-- Absence of settings preserves legacy projects; managed settings cannot be deleted.
create function platform_private.valid_resource_references(refs jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare r jsonb; keys text[]; identity text; identities text[] := array[]::text[];
begin
 if refs is null or jsonb_typeof(refs)<>'array' then return false; end if;
 if jsonb_array_length(refs) not between 1 and 1000 then return false; end if;
 for r in select value from jsonb_array_elements(refs) loop
  if jsonb_typeof(r)<>'object' then return false; end if;
  select array_agg(key order by key) into keys from jsonb_object_keys(r) key;
  if r->>'kind'='version' then
   if keys<>array['dataItemId','kind','versionId'] or jsonb_typeof(r->'dataItemId')<>'string' or jsonb_typeof(r->'versionId')<>'string' then return false; end if;
   perform (r->>'dataItemId')::uuid, (r->>'versionId')::uuid;
   identity := 'v:'||((r->>'dataItemId')::uuid)::text||':'||((r->>'versionId')::uuid)::text;
  elsif r->>'kind'='external-source' then
   if keys<>array['kind','sourceId'] or jsonb_typeof(r->'sourceId')<>'string' or length(r->>'sourceId') not between 1 and 128 or (r->>'sourceId')!~'^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' then return false; end if;
   identity := 's:'||(r->>'sourceId');
  else return false;
  end if;
  if identity is null or identity=any(identities) then return false; end if;
  identities := array_append(identities,identity);
 end loop;
 return true;
exception when invalid_text_representation then return false;
end $$;
create function platform_private.valid_resource_actions(actions text[])
returns boolean language sql immutable set search_path = '' as $$
 select coalesce(cardinality(actions) between 1 and 5
 and array_position(actions,null) is null
 and actions <@ array['source.discover','content.read','original.read','result.export','external.directory']::text[]
 and cardinality(actions)=(select count(distinct action) from unnest(actions) action),false);
$$;
revoke all on function platform_private.valid_resource_references(jsonb),platform_private.valid_resource_actions(text[]) from public,anon,authenticated,service_role;

create table platform_private.resource_access_settings (
 project_id uuid primary key,
 tenant_id uuid not null,
 revision bigint not null default 1 check(revision between 1 and 9007199254740991),
 enabled_at timestamptz not null default now(),
 enabled_by uuid not null references platform.actors(id) on delete restrict,
 foreign key(project_id,tenant_id) references platform.projects(id,tenant_id) on delete restrict
);
create table platform_private.resource_package_versions (
 project_id uuid not null references platform_private.resource_access_settings(project_id) on delete restrict,
 package_id uuid not null,
 version integer not null check(version>0),
 name text not null check(length(name) between 1 and 160),
 resources jsonb not null check(platform_private.valid_resource_references(resources)),
 allowed_actions text[] not null check(platform_private.valid_resource_actions(allowed_actions)),
 license_basis text not null check(length(license_basis) between 5 and 1000),
 created_by uuid not null references platform.actors(id) on delete restrict,
 created_at timestamptz not null default now(),
 primary key(project_id,package_id,version)
);
create table platform_private.resource_preset_versions (
 project_id uuid not null references platform_private.resource_access_settings(project_id) on delete restrict,
 preset_id uuid not null,
 version integer not null check(version>0),
 name text not null check(length(name) between 1 and 160),
 actions text[] not null check(platform_private.valid_resource_actions(actions)),
 max_days integer not null check(max_days between 1 and 366),
 approval_level text not null check(approval_level in ('ordinary','important')),
 created_by uuid not null references platform.actors(id) on delete restrict,
 created_at timestamptz not null default now(),
 primary key(project_id,preset_id,version)
);
create table platform_private.resource_grants (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null,
 actor_id uuid not null references platform.actors(id) on delete restrict,
 package_id uuid not null, package_version integer not null,
 preset_id uuid not null, preset_version integer not null,
 purpose text not null check(length(purpose) between 1 and 96 and purpose~'^[a-z][a-z0-9-]*$'),
 starts_at timestamptz not null,
 expires_at timestamptz not null check(expires_at>starts_at),
 created_by uuid not null references platform.actors(id) on delete restrict,
 approved_by uuid not null references platform.actors(id) on delete restrict,
 reason text not null check(length(reason) between 5 and 1000),
 created_at timestamptz not null default now(),
 foreign key(project_id,package_id,package_version) references platform_private.resource_package_versions(project_id,package_id,version) on delete restrict,
 foreign key(project_id,preset_id,preset_version) references platform_private.resource_preset_versions(project_id,preset_id,version) on delete restrict,
 check(approved_by<>actor_id),
 unique(id,project_id)
);
create index resource_grants_actor_idx on platform_private.resource_grants(project_id,actor_id,purpose,expires_at);
create table platform_private.resource_revocations (
 grant_id uuid primary key,
 project_id uuid not null,
 revoked_by uuid not null references platform.actors(id) on delete restrict,
 reason text not null check(length(reason) between 5 and 1000),
 revoked_at timestamptz not null default now(),
 foreign key(grant_id,project_id) references platform_private.resource_grants(id,project_id) on delete restrict
);
create table platform_private.resource_access_events (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references platform_private.resource_access_settings(project_id) on delete restrict,
 actor_id uuid not null references platform.actors(id) on delete restrict,
 action text not null check(action in ('package.create','preset.create','preview','approve','reject','withdraw','grant','revoke','execute.failed','retire','source.propose','source.publish','source.reject','source.withdraw','source.revoke')),
 subject_id uuid not null,
 reason text not null check(length(reason) between 5 and 1000),
 before_state jsonb not null check(jsonb_typeof(before_state)='object' and octet_length(before_state::text)<=131072),
 after_state jsonb not null check(jsonb_typeof(after_state)='object' and octet_length(after_state::text)<=131072),
 created_at timestamptz not null default now()
);
create index resource_access_events_project_idx on platform_private.resource_access_events(project_id,created_at,id);

create function platform_private.guard_resource_settings() returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='22023',message='Managed resource protection cannot be removed.'; end if;
 if (to_jsonb(new)-'revision') is distinct from (to_jsonb(old)-'revision') or new.revision<>old.revision+1 then
  raise exception using errcode='22023',message='Resource authority revisions must advance monotonically.';
 end if;
 return new;
end $$;
create trigger resource_settings_guard before update or delete on platform_private.resource_access_settings for each row execute function platform_private.guard_resource_settings();
create function platform_private.advance_resource_revision() returns trigger language plpgsql set search_path = '' as $$
begin
 update platform_private.resource_access_settings set revision=revision+1 where project_id=new.project_id;
 return null;
end $$;
create function platform_private.guard_resource_grant() returns trigger language plpgsql set search_path = '' as $$
declare allowed text[]; requested text[]; days integer;
begin
 select allowed_actions into allowed from platform_private.resource_package_versions where project_id=new.project_id and package_id=new.package_id and version=new.package_version;
 select actions,max_days into requested,days from platform_private.resource_preset_versions where project_id=new.project_id and preset_id=new.preset_id and version=new.preset_version;
 if allowed is null or requested is null or not(requested<@allowed) or new.expires_at>new.starts_at+days*interval '1 day' then
  raise exception using errcode='23514',message='Grant exceeds immutable package or preset limits.';
 end if;
 return new;
end $$;
create trigger resource_grant_limits before insert on platform_private.resource_grants for each row execute function platform_private.guard_resource_grant();
revoke all on function platform_private.guard_resource_settings(),platform_private.advance_resource_revision(),platform_private.guard_resource_grant() from public,anon,authenticated,service_role;

do $$ declare relation_name text; begin
 foreach relation_name in array array['resource_access_settings','resource_package_versions','resource_preset_versions','resource_grants','resource_revocations','resource_access_events'] loop
  execute format('alter table platform_private.%I enable row level security',relation_name);
  execute format('alter table platform_private.%I force row level security',relation_name);
  execute format('revoke all on platform_private.%I from public,anon,authenticated,service_role',relation_name);
  if relation_name<>'resource_access_settings' then
   execute format('create trigger %I before update or delete on platform_private.%I for each row execute function platform_private.reject_project_access_history_change()',relation_name||'_immutable',relation_name);
  end if;
  if relation_name in ('resource_package_versions','resource_preset_versions','resource_grants','resource_revocations') then
   execute format('create trigger %I after insert on platform_private.%I for each row execute function platform_private.advance_resource_revision()',relation_name||'_revision',relation_name);
  end if;
 end loop;
end $$;
-- The API verifies live management/approval scope, exact resource versions and provider caps.
-- These tables never grant raw browser or service-role access, nor bypass Data RLS.

create index resource_settings_actor_idx on platform_private.resource_access_settings(enabled_by);
create index resource_settings_project_tenant_idx on platform_private.resource_access_settings(project_id,tenant_id);
create index resource_package_creator_idx on platform_private.resource_package_versions(created_by);
create index resource_preset_creator_idx on platform_private.resource_preset_versions(created_by);
create index resource_grants_actor_fk_idx on platform_private.resource_grants(actor_id);
create index resource_grants_package_idx on platform_private.resource_grants(project_id,package_id,package_version);
create index resource_grants_preset_idx on platform_private.resource_grants(project_id,preset_id,preset_version);
create index resource_grants_creator_idx on platform_private.resource_grants(created_by);
create index resource_grants_approver_idx on platform_private.resource_grants(approved_by);
create index resource_revocations_actor_idx on platform_private.resource_revocations(revoked_by);
create index resource_events_actor_idx on platform_private.resource_access_events(actor_id);

create index resource_revocations_grant_project_idx on platform_private.resource_revocations(grant_id,project_id);
