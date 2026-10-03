-- Fixed display configuration only. Candidates and Supabase remain authoritative.
create function service.valid_candidate_view_reference(ref jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
begin
  return jsonb_typeof(ref)='object'
    and (select count(*)=4 from jsonb_object_keys(ref))
    and ref->>'kind'='ingestion-candidate'
    and ref->>'ingestionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and ref->>'processingBatchId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and ref->>'reviewHash' ~ '^[a-f0-9]{64}$';
exception when others then return false;
end $$;

create function service.valid_candidate_view_refs(refs jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if jsonb_typeof(refs) is distinct from 'array'
    or jsonb_array_length(refs) not between 1 and 100
    or octet_length(refs::text)>131072 then return false; end if;
  return not exists(select 1 from jsonb_array_elements(refs) r
      where service.valid_candidate_view_reference(r) is distinct from true)
    and (select count(distinct (lower(r->>'ingestionId'),lower(r->>'processingBatchId'),r->>'reviewHash'))
      =jsonb_array_length(refs) from jsonb_array_elements(refs) r);
exception when others then return false;
end $$;

create function service.valid_candidate_view_spec(spec jsonb, refs jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare page jsonb; focus jsonb; map_view jsonb; camera jsonb; period jsonb; period_key text;
  uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(spec) is distinct from 'object' or octet_length(spec::text)>131072
    or not service.valid_candidate_view_refs(refs)
    or exists(select 1 from jsonb_object_keys(spec) k where k not in ('page','focus','map','period')) then return false; end if;
  page:=spec->'page';
  if jsonb_typeof(page) is distinct from 'object'
    or (page->>'kind' in ('assets','records','geometry')) is distinct from true
    or service.valid_candidate_view_reference(page->'reference') is distinct from true
    or not exists(select 1 from jsonb_array_elements(refs) r
      where lower(r->>'ingestionId')=lower(page#>>'{reference,ingestionId}')
        and lower(r->>'processingBatchId')=lower(page#>>'{reference,processingBatchId}')
        and r->>'reviewHash'=page#>>'{reference,reviewHash}')
    or jsonb_typeof(page->'first') is distinct from 'number'
    or (page->>'first') !~ '^[0-9]+$' or (page->>'first')::numeric not between 1 and 200
    or exists(select 1 from jsonb_object_keys(page) k where k not in
      ('kind','reference','first','assetId','afterAssetId','afterRecordId')) then return false; end if;
  if page->>'kind'='assets' then
    if page ? 'assetId' or page ? 'afterRecordId'
      or (page ? 'afterAssetId' and (page->>'afterAssetId' ~* uuid_pattern) is distinct from true) then return false; end if;
  elsif (page->>'assetId' ~* uuid_pattern) is distinct from true or page ? 'afterAssetId'
    or (page ? 'afterRecordId' and (page->>'afterRecordId' ~* uuid_pattern) is distinct from true) then return false; end if;
  if spec ? 'focus' then
    focus:=spec->'focus';
    if jsonb_typeof(focus) is distinct from 'object'
      or service.valid_candidate_view_reference(focus->'reference') is distinct from true
      or (focus->>'assetId' ~* uuid_pattern) is distinct from true
      or (focus ? 'recordId' and (focus->>'recordId' ~* uuid_pattern) is distinct from true)
      or exists(select 1 from jsonb_object_keys(focus) k where k not in ('reference','assetId','recordId'))
      or not exists(select 1 from jsonb_array_elements(refs) r
        where lower(r->>'ingestionId')=lower(focus#>>'{reference,ingestionId}')
          and lower(r->>'processingBatchId')=lower(focus#>>'{reference,processingBatchId}')
          and r->>'reviewHash'=focus#>>'{reference,reviewHash}') then return false; end if;
  end if;
  if spec ? 'map' then
    map_view:=spec->'map';
    if jsonb_typeof(map_view) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(map_view) k where k not in ('camera','layers')) then return false; end if;
    if map_view ? 'camera' then
      camera:=map_view->'camera';
      if jsonb_typeof(camera) is distinct from 'object' or (select count(*) from jsonb_object_keys(camera))<>5
        or exists(select 1 from jsonb_object_keys(camera) k where k not in ('longitude','latitude','zoom','bearing','pitch'))
        or (select count(*) from jsonb_each(camera) v where jsonb_typeof(v.value)='number')<>5
        or (camera->>'longitude')::numeric not between -180 and 180
        or (camera->>'latitude')::numeric not between -85.051129 and 85.051129
        or (camera->>'zoom')::numeric not between 0 and 24
        or (camera->>'bearing')::numeric not between -180 and 180
        or (camera->>'pitch')::numeric not between 0 and 85 then return false; end if;
    end if;
    if map_view ? 'layers' then
      if jsonb_typeof(map_view->'layers') is distinct from 'object'
        or (select count(*) from jsonb_object_keys(map_view->'layers'))<>3
        or exists(select 1 from jsonb_each(map_view->'layers') v
          where v.key not in ('points','lines','polygons') or jsonb_typeof(v.value)<>'boolean') then return false; end if;
    end if;
  end if;
  if spec ? 'period' then
    period:=spec->'period';
    if jsonb_typeof(period) is distinct from 'object' or (select count(*) from jsonb_object_keys(period))<>4
      or exists(select 1 from jsonb_object_keys(period) k where k not in ('from','to','unit','includeUndated'))
      or (period->>'unit' in ('month','year')) is distinct from true
      or jsonb_typeof(period->'includeUndated') is distinct from 'boolean' then return false; end if;
    foreach period_key in array array['from','to'] loop
      if jsonb_typeof(period->period_key) is distinct from 'null'
        and (jsonb_typeof(period->period_key) is distinct from 'string' or (period->>period_key) !~ '^[0-9]{4}-(0[1-9]|1[0-2])$') then return false; end if;
    end loop;
    if period->>'from'>period->>'to' then return false; end if;
  end if;
  return true;
exception when others then return false;
end $$;

-- Transaction-local Auth facts only; neither a saved row nor its creator grants access.
create function service.candidate_saved_authority_live() returns boolean
language plpgsql volatile set search_path=pg_catalog as $$
declare actor_type text:=current_setting('wiser.actor_type',true);
  delegate text:=nullif(current_setting('wiser.delegated_by',true),'');
  deadline text:=nullif(current_setting('wiser.candidate_view_deadline',true),'');
  resource_scope text:=nullif(current_setting('wiser.resource_scope',true),'');
  resource jsonb;
begin
  if not pg_has_role(current_user,'wiser_data_api','MEMBER')
    or nullif(current_setting('wiser.actor_id',true),'') is null
    or nullif(current_setting('wiser.purpose',true),'') is null
    or current_setting('wiser.purpose',true) is distinct from current_setting('wiser.candidate_purpose',true)
    or deadline is null or deadline::timestamptz<=clock_timestamp()
    or actor_type is null or not ((actor_type='human' and delegate is null)
      or (actor_type in ('agent','service') and delegate is not null))
    or not (current_setting('wiser.candidate_maintainer',true)='true'
      or (current_setting('wiser.candidate_reviewer',true)='true' and actor_type='human' and delegate is null)) then return false; end if;
  if resource_scope is not null then
    resource:=resource_scope::jsonb;
    if resource->>'mode' is distinct from 'managed'
      or jsonb_typeof(resource->'permissions') is distinct from 'object'
      or (jsonb_typeof(resource->'validUntil') is distinct from 'null'
        and ((resource->>'validUntil') is null or (resource->>'validUntil')::timestamptz<=clock_timestamp())) then return false; end if;
  end if;
  return true;
exception when others then return false;
end $$;

create function service.candidate_saved_owner(actor uuid, actor_type text, delegate uuid) returns boolean
language sql stable set search_path=pg_catalog as $$
  select coalesce((current_setting('wiser.actor_type',true)='human'
      and nullif(current_setting('wiser.delegated_by',true),'') is null
      and ((actor_type='human' and delegate is null and actor::text=current_setting('wiser.actor_id',true))
        or delegate::text=current_setting('wiser.actor_id',true)))
    or (current_setting('wiser.actor_type',true) in ('agent','service')
      and actor_type=current_setting('wiser.actor_type',true)
      and actor::text=current_setting('wiser.actor_id',true)
      and delegate is not null and delegate::text=current_setting('wiser.delegated_by',true)),false);
$$;

create function service.candidate_saved_refs_readable(refs jsonb) returns boolean
language plpgsql volatile set search_path=pg_catalog as $$
declare readable integer;
begin
  if not service.candidate_saved_authority_live() or not service.valid_candidate_view_refs(refs) then return false; end if;
  -- Invoker: the existing forced candidate RLS verifies submitter/delegator and independent review.
  -- This helper never reads saved views, so it introduces no saved/session RLS recursion.
  select count(*) into readable from jsonb_array_elements(refs) r
    join ingestion.candidate_batch b on b.ingestion_id=(r->>'ingestionId')::uuid
      and b.processing_batch_id=(r->>'processingBatchId')::uuid
      and b.review_hash=decode(r->>'reviewHash','hex') where b.status<>'PENDING';
  return readable=jsonb_array_length(refs);
exception when others then return false;
end $$;

create table service.ingestion_candidate_saved_view (
  view_id uuid primary key, tenant_id uuid not null, project_id uuid not null,
  actor_id uuid not null, actor_type text not null check(actor_type in ('human','agent','service')),
  delegated_by uuid, purpose text not null check(length(purpose) between 1 and 256),
  security_level text not null check(security.is_valid_security_level(security_level)),
  policy_version bigint not null check(policy_version>0),
  title text not null check(length(btrim(title)) between 1 and 160),
  visibility text not null check(visibility in ('private','project')),
  candidate_refs jsonb not null check(service.valid_candidate_view_refs(candidate_refs)),
  view_spec jsonb not null check(service.valid_candidate_view_spec(view_spec,candidate_refs)),
  created_at timestamptz not null, revoked_at timestamptz check(revoked_at>=created_at),
  check((actor_type='human' and delegated_by is null) or (actor_type in ('agent','service') and delegated_by is not null)),
  check(octet_length(jsonb_build_object('title',title,'visibility',visibility,'references',candidate_refs,'viewSpec',view_spec)::text)<=131072)
);
create index candidate_saved_scope on service.ingestion_candidate_saved_view(tenant_id,project_id,purpose,created_at desc,view_id desc) where revoked_at is null;
alter table service.ingestion_candidate_saved_view enable row level security;
alter table service.ingestion_candidate_saved_view force row level security;
create policy candidate_saved_read on service.ingestion_candidate_saved_view for select using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true) and service.candidate_saved_refs_readable(candidate_refs)
  and (service.candidate_saved_owner(actor_id,actor_type,delegated_by) or (visibility='project' and revoked_at is null))
);
create policy candidate_saved_create on service.ingestion_candidate_saved_view for insert with check (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and actor_id::text=current_setting('wiser.actor_id',true) and actor_type=current_setting('wiser.actor_type',true)
  and coalesce(delegated_by::text,'')=coalesce(current_setting('wiser.delegated_by',true),'')
  and purpose=current_setting('wiser.purpose',true) and revoked_at is null
  and service.candidate_saved_refs_readable(candidate_refs)
);
create policy candidate_saved_revoke on service.ingestion_candidate_saved_view for update using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true)
  and service.candidate_saved_owner(actor_id,actor_type,delegated_by)
  and service.candidate_saved_refs_readable(candidate_refs)
) with check (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true)
  and service.candidate_saved_owner(actor_id,actor_type,delegated_by)
  and service.candidate_saved_refs_readable(candidate_refs)
);
create function service.guard_candidate_saved_view() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at')
    or new.revoked_at is null or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'Candidate saved view is immutable' using errcode='23514'; end if;
  return new;
end $$;
create trigger candidate_saved_immutable before update on service.ingestion_candidate_saved_view for each row execute function service.guard_candidate_saved_view();
revoke all on service.ingestion_candidate_saved_view from public;
revoke all on function service.valid_candidate_view_reference(jsonb), service.valid_candidate_view_refs(jsonb),
  service.valid_candidate_view_spec(jsonb,jsonb), service.candidate_saved_authority_live(),
  service.candidate_saved_owner(uuid,text,uuid), service.candidate_saved_refs_readable(jsonb), service.guard_candidate_saved_view() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wiser_data_runtime') then
    grant select,insert on service.ingestion_candidate_saved_view to wiser_data_runtime;
    revoke update,delete on service.ingestion_candidate_saved_view from wiser_data_runtime;
    grant update(revoked_at) on service.ingestion_candidate_saved_view to wiser_data_runtime;
    grant execute on function service.valid_candidate_view_reference(jsonb),service.valid_candidate_view_refs(jsonb),
      service.valid_candidate_view_spec(jsonb,jsonb),service.candidate_saved_authority_live(),
      service.candidate_saved_owner(uuid,text,uuid),service.candidate_saved_refs_readable(jsonb) to wiser_data_runtime;
  end if;
end $$;
