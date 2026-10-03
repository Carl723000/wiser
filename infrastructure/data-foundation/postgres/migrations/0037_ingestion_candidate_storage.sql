-- Private, source-bound parse outcomes. These are not published catalog versions.
create table ingestion.candidate_batch (
  processing_batch_id uuid primary key,
  tenant_id uuid not null,
  project_id uuid not null,
  ingestion_id uuid not null,
  transform_plan_id uuid not null,
  operation_id uuid not null,
  review_hash bytea not null check (octet_length(review_hash) = 32),
  parser_version text not null check (length(parser_version) between 1 and 128),
  status text not null default 'PENDING' check (status in ('PENDING','READY','PARTIAL','UNAVAILABLE')),
  security_level text not null check (security.is_valid_security_level(security_level)),
  policy_version bigint not null check (policy_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check ((status = 'PENDING') = (completed_at is null)),
  foreign key (tenant_id,project_id,ingestion_id) references ingestion.session(tenant_id,project_id,ingestion_id),
  foreign key (tenant_id,project_id,transform_plan_id) references ingestion.transform_plan(tenant_id,project_id,transform_plan_id),
  foreign key (tenant_id,project_id,operation_id) references service.operation(tenant_id,project_id,operation_id),
  unique (tenant_id,project_id,processing_batch_id),
  unique (tenant_id,project_id,ingestion_id,review_hash,parser_version)
);

create table ingestion.candidate_asset (
  processing_batch_id uuid not null,
  asset_id uuid not null,
  tenant_id uuid not null,
  project_id uuid not null,
  source_hash bytea not null check (octet_length(source_hash) = 32),
  status text not null default 'PENDING' check (status in ('PENDING','READY','EMPTY','PARTIAL','UNSUPPORTED','INVALID','RESTRICTED')),
  reason text check (reason ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  record_count bigint check (record_count between 0 and 2000000),
  feature_count bigint check (feature_count between 0 and record_count),
  columns jsonb not null default '[]'::jsonb check (
    jsonb_typeof(columns)='array' and jsonb_array_length(columns)<=256
    and octet_length(columns::text)<=262144
  ),
  security_level text not null check (security.is_valid_security_level(security_level)),
  policy_version bigint not null check (policy_version > 0),
  primary key (processing_batch_id,asset_id),
  unique (tenant_id,project_id,processing_batch_id,asset_id),
  foreign key (tenant_id,project_id,processing_batch_id) references ingestion.candidate_batch(tenant_id,project_id,processing_batch_id),
  foreign key (tenant_id,project_id,asset_id) references catalog.asset(tenant_id,project_id,asset_id),
  check (case when status in ('READY','EMPTY','PARTIAL') then record_count is not null and feature_count is not null
    else record_count is null and feature_count is null end),
  check (status <> 'EMPTY' or (record_count=0 and feature_count=0)),
  check (status not in ('PARTIAL','UNSUPPORTED','INVALID','RESTRICTED') or reason is not null)
);

create table ingestion.candidate_record (
  processing_batch_id uuid not null,
  record_id uuid not null,
  asset_id uuid not null,
  tenant_id uuid not null,
  project_id uuid not null,
  record_index bigint not null check (record_index between 1 and 2000000),
  source_id text check (length(source_id) between 1 and 1024),
  record_values jsonb not null check (jsonb_typeof(record_values)='object' and octet_length(record_values::text)<=262144),
  geom geometry(Geometry,4326),
  source_crs text check (source_crs is null or length(source_crs) between 1 and 128),
  security_level text not null check (security.is_valid_security_level(security_level)),
  policy_version bigint not null check (policy_version > 0),
  primary key (processing_batch_id,record_id),
  unique (processing_batch_id,asset_id,record_index),
  foreign key (tenant_id,project_id,processing_batch_id,asset_id) references ingestion.candidate_asset(tenant_id,project_id,processing_batch_id,asset_id),
  check (geom is null or (not st_isempty(geom) and st_isvalid(geom)))
);
create index candidate_record_page on ingestion.candidate_record(tenant_id,project_id,processing_batch_id,asset_id,record_index);
create index candidate_record_geometry on ingestion.candidate_record using gist(geom) where geom is not null;

create function ingestion.candidate_worker_lease(
  requested_tenant uuid, requested_project uuid, requested_ingestion uuid,
  requested_operation uuid, requested_security text, requested_policy bigint
) returns boolean language sql stable set search_path=pg_catalog as $$
  select pg_has_role(current_user,'wiser_data_worker','MEMBER')
    and security.authorized_row(requested_tenant,requested_project,requested_security,requested_policy)
    and exists (select 1 from ingestion.job job
      where job.tenant_id=requested_tenant and job.project_id=requested_project
        and job.job_id=nullif(current_setting('wiser.candidate_job_id',true),'')::uuid
        and job.ingestion_id=requested_ingestion and job.operation_id=requested_operation
        and job.job_type='data.ingestion.process' and job.status='RUNNING'
        and job.lease_owner=current_setting('wiser.candidate_job_owner',true)
        and job.attempt_count=nullif(current_setting('wiser.candidate_job_attempt',true),'')::integer
        and job.lease_expires_at>clock_timestamp() and job.cancel_requested_at is null
        and (job.timeout_at is null or job.timeout_at>clock_timestamp())
        and job.security_level=requested_security and job.policy_version=requested_policy);
$$;

-- Subject references come from verified Auth. No identity or grants are invented here.
create function ingestion.candidate_readable(
  requested_tenant uuid, requested_project uuid, requested_ingestion uuid,
  requested_plan uuid, requested_hash bytea, requested_security text, requested_policy bigint
) returns boolean language sql stable set search_path=pg_catalog as $$
  select security.authorized_row(requested_tenant,requested_project,requested_security,requested_policy)
    and exists (select 1 from ingestion.session session
      join ingestion.transform_plan plan on plan.tenant_id=session.tenant_id
        and plan.project_id=session.project_id and plan.ingestion_id=session.ingestion_id
      join ingestion.project_review_policy policy on policy.tenant_id=session.tenant_id and policy.project_id=session.project_id
      where session.tenant_id=requested_tenant and session.project_id=requested_project
        and session.ingestion_id=requested_ingestion and session.owner_project_id=requested_project
        and session.security_level=requested_security and session.policy_version=requested_policy
        and session.state in ('REVIEW_REQUIRED','APPROVED','COMMITTED','PROJECTING','PUBLISHED','REJECTED')
        and plan.transform_plan_id=requested_plan and plan.plan_hash=requested_hash
        and plan.status in ('REVIEW_REQUIRED','APPROVED','REJECTED')
        and plan.plan #> '{assetManifest,reviewGovernance}'=session.review_policy_snapshot
        and policy.enabled and session.review_policy_snapshot=jsonb_build_object('mode',policy.mode,'revision',policy.revision)
        and not exists (select 1 from ingestion.transform_plan newer
          where newer.tenant_id=plan.tenant_id and newer.project_id=plan.project_id
            and newer.ingestion_id=plan.ingestion_id and newer.plan_version>plan.plan_version)
        and (ingestion.candidate_worker_lease(requested_tenant,requested_project,requested_ingestion,
          session.operation_id,requested_security,requested_policy)
          or (pg_has_role(current_user,'wiser_data_api','MEMBER') and (
            session.submitted_by_actor_id::text=nullif(current_setting('wiser.actor_id',true),'')
            or session.submitted_delegator_actor_id::text=nullif(current_setting('wiser.actor_id',true),'')))));
$$;

alter table ingestion.candidate_batch enable row level security;
alter table ingestion.candidate_batch force row level security;
create policy candidate_batch_read on ingestion.candidate_batch for select using (
  ingestion.candidate_readable(tenant_id,project_id,ingestion_id,transform_plan_id,review_hash,security_level,policy_version)
);
create policy candidate_batch_insert on ingestion.candidate_batch for insert with check (
  ingestion.candidate_worker_lease(tenant_id,project_id,ingestion_id,operation_id,security_level,policy_version)
);
create policy candidate_batch_update on ingestion.candidate_batch for update using (
  ingestion.candidate_worker_lease(tenant_id,project_id,ingestion_id,operation_id,security_level,policy_version)
) with check (ingestion.candidate_worker_lease(tenant_id,project_id,ingestion_id,operation_id,security_level,policy_version));

alter table ingestion.candidate_asset enable row level security;
alter table ingestion.candidate_asset force row level security;
create policy candidate_asset_read on ingestion.candidate_asset for select using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and exists (select 1 from ingestion.candidate_batch batch where batch.tenant_id=candidate_asset.tenant_id
    and batch.project_id=candidate_asset.project_id and batch.processing_batch_id=candidate_asset.processing_batch_id)
);
create policy candidate_asset_insert on ingestion.candidate_asset for insert with check (
  exists (select 1 from ingestion.candidate_batch batch where batch.tenant_id=candidate_asset.tenant_id
    and batch.project_id=candidate_asset.project_id and batch.processing_batch_id=candidate_asset.processing_batch_id
    and ingestion.candidate_worker_lease(batch.tenant_id,batch.project_id,batch.ingestion_id,batch.operation_id,batch.security_level,batch.policy_version))
);
create policy candidate_asset_update on ingestion.candidate_asset for update using (
  exists (select 1 from ingestion.candidate_batch batch where batch.tenant_id=candidate_asset.tenant_id
    and batch.project_id=candidate_asset.project_id and batch.processing_batch_id=candidate_asset.processing_batch_id
    and ingestion.candidate_worker_lease(batch.tenant_id,batch.project_id,batch.ingestion_id,batch.operation_id,batch.security_level,batch.policy_version))
);

alter table ingestion.candidate_record enable row level security;
alter table ingestion.candidate_record force row level security;
create policy candidate_record_read on ingestion.candidate_record for select using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and exists (select 1 from ingestion.candidate_batch batch where batch.tenant_id=candidate_record.tenant_id
    and batch.project_id=candidate_record.project_id and batch.processing_batch_id=candidate_record.processing_batch_id)
);
create policy candidate_record_insert on ingestion.candidate_record for insert with check (
  exists (select 1 from ingestion.candidate_batch batch where batch.tenant_id=candidate_record.tenant_id
    and batch.project_id=candidate_record.project_id and batch.processing_batch_id=candidate_record.processing_batch_id
    and ingestion.candidate_worker_lease(batch.tenant_id,batch.project_id,batch.ingestion_id,batch.operation_id,batch.security_level,batch.policy_version))
);

create function ingestion.guard_candidate_batch() returns trigger language plpgsql set search_path=pg_catalog as $$
declare
  session_row ingestion.session%rowtype;
  plan_row ingestion.transform_plan%rowtype;
  expected_status text;
begin
  if tg_op='DELETE' then raise exception 'candidate history is immutable' using errcode='42501'; end if;
  if not ingestion.candidate_worker_lease(new.tenant_id,new.project_id,new.ingestion_id,new.operation_id,new.security_level,new.policy_version) then
    raise exception 'candidate worker lease required' using errcode='42501';
  end if;
  select * into session_row from ingestion.session where tenant_id=new.tenant_id and project_id=new.project_id
    and ingestion_id=new.ingestion_id for share;
  if not found or session_row.state<>'REVIEW_REQUIRED' or session_row.operation_id<>new.operation_id
    or session_row.owner_project_id<>new.project_id or session_row.security_level<>new.security_level
    or session_row.policy_version<>new.policy_version or session_row.submitted_by_actor_id is null then
    raise exception 'candidate pending checkpoint required' using errcode='42501';
  end if;
  if not ingestion.assert_current_review_policy(session_row) then
    raise exception 'candidate independent review policy required' using errcode='42501';
  end if;
  select * into plan_row from ingestion.transform_plan where tenant_id=new.tenant_id and project_id=new.project_id
    and ingestion_id=new.ingestion_id and transform_plan_id=new.transform_plan_id for share;
  if not found or plan_row.status<>'REVIEW_REQUIRED' or plan_row.plan_hash<>new.review_hash
    or plan_row.plan->>'reviewHash' is distinct from encode(new.review_hash,'hex')
    or plan_row.plan #> '{assetManifest,reviewGovernance}' is distinct from session_row.review_policy_snapshot
    or jsonb_typeof(plan_row.plan->'assetIds') is distinct from 'array'
    or jsonb_array_length(plan_row.plan->'assetIds') not between 1 and 10000 then
    raise exception 'candidate frozen input binding required' using errcode='42501';
  end if;
  if tg_op='INSERT' then
    if new.status<>'PENDING' or new.completed_at is not null then
      raise exception 'candidate must start pending' using errcode='42501';
    end if;
    return new;
  end if;
  if row(new.processing_batch_id,new.tenant_id,new.project_id,new.ingestion_id,new.transform_plan_id,new.operation_id,
    new.review_hash,new.parser_version,new.security_level,new.policy_version,new.created_at)
    is distinct from row(old.processing_batch_id,old.tenant_id,old.project_id,old.ingestion_id,old.transform_plan_id,old.operation_id,
    old.review_hash,old.parser_version,old.security_level,old.policy_version,old.created_at)
    or old.status<>'PENDING' or new.status='PENDING' or new.completed_at is null then
    raise exception 'candidate identity and completed outcome are immutable' using errcode='42501';
  end if;
  if (select array_agg(asset.asset_id::text order by asset.asset_id::text) from ingestion.candidate_asset asset
    where asset.processing_batch_id=new.processing_batch_id)
    is distinct from (select array_agg(value order by value) from jsonb_array_elements_text(plan_row.plan->'assetIds'))
    or exists (select 1 from ingestion.candidate_asset asset where asset.processing_batch_id=new.processing_batch_id and asset.status='PENDING') then
    raise exception 'candidate original set or parse outcomes incomplete' using errcode='42501';
  end if;
  select case when bool_and(status in ('READY','EMPTY')) then 'READY'
    when bool_and(status not in ('READY','EMPTY','PARTIAL')) then 'UNAVAILABLE' else 'PARTIAL' end into expected_status
    from ingestion.candidate_asset where processing_batch_id=new.processing_batch_id;
  if new.status is distinct from expected_status then raise exception 'candidate aggregate outcome conflicts' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger candidate_batch_guard before insert or update or delete on ingestion.candidate_batch
  for each row execute function ingestion.guard_candidate_batch();

create function ingestion.guard_candidate_asset() returns trigger language plpgsql set search_path=pg_catalog as $$
declare
  batch_row ingestion.candidate_batch%rowtype;
  actual_records bigint;
  actual_features bigint;
  first_index bigint;
  last_index bigint;
begin
  if tg_op='DELETE' then raise exception 'candidate history is immutable' using errcode='42501'; end if;
  select * into batch_row from ingestion.candidate_batch where tenant_id=new.tenant_id and project_id=new.project_id
    and processing_batch_id=new.processing_batch_id for share;
  if not found or batch_row.status<>'PENDING' or batch_row.security_level<>new.security_level or batch_row.policy_version<>new.policy_version
    or not ingestion.candidate_worker_lease(batch_row.tenant_id,batch_row.project_id,batch_row.ingestion_id,batch_row.operation_id,batch_row.security_level,batch_row.policy_version)
    or not exists (select 1 from ingestion.input_asset input join catalog.asset asset
      on asset.tenant_id=input.tenant_id and asset.project_id=input.project_id and asset.asset_id=input.asset_id
      join catalog.content_blob blob on blob.tenant_id=asset.tenant_id and blob.project_id=asset.project_id and blob.content_blob_id=asset.content_blob_id
      join ingestion.transform_plan plan on plan.tenant_id=batch_row.tenant_id and plan.project_id=batch_row.project_id and plan.transform_plan_id=batch_row.transform_plan_id
      where input.tenant_id=new.tenant_id and input.project_id=new.project_id and input.ingestion_id=batch_row.ingestion_id and input.asset_id=new.asset_id
        and input.fingerprint=new.source_hash and blob.content_hash=new.source_hash
        and asset.lifecycle_state='QUARANTINED' and asset.version_id is null
        and plan.plan->'assetIds' ? new.asset_id::text
        and exists (select 1 from jsonb_array_elements(plan.plan #> '{assetManifest,assets}') original
          where original->>'assetId'=new.asset_id::text and original->>'sourceHash'=encode(new.source_hash,'hex'))) then
    raise exception 'candidate original hash or pending batch conflict' using errcode='42501';
  end if;
  if tg_op='INSERT' then
    if new.status<>'PENDING' or new.columns<>'[]'::jsonb or new.reason is not null then
      raise exception 'candidate asset must start pending' using errcode='42501';
    end if;
    return new;
  end if;
  if row(new.processing_batch_id,new.asset_id,new.tenant_id,new.project_id,new.source_hash,new.security_level,new.policy_version)
    is distinct from row(old.processing_batch_id,old.asset_id,old.tenant_id,old.project_id,old.source_hash,old.security_level,old.policy_version)
    or old.status<>'PENDING' or new.status='PENDING' then
    raise exception 'candidate original identity and completed outcome are immutable' using errcode='42501';
  end if;
  if exists (select 1 from jsonb_array_elements(new.columns) column_value
    where jsonb_typeof(column_value) is distinct from 'object'
      or jsonb_typeof(column_value->'key') is distinct from 'string'
      or jsonb_typeof(column_value->'label') is distinct from 'string'
      or length(column_value->>'key') not between 1 and 128
      or length(column_value->>'label') not between 1 and 512)
    or (select count(*) from jsonb_array_elements(new.columns))<>(select count(distinct value->>'key') from jsonb_array_elements(new.columns)) then
    raise exception 'candidate fields are invalid' using errcode='42501';
  end if;
  select count(*),count(*) filter(where geom is not null),min(record_index),max(record_index)
    into actual_records,actual_features,first_index,last_index from ingestion.candidate_record
    where processing_batch_id=new.processing_batch_id and asset_id=new.asset_id;
  if new.record_count is null then
    if actual_records<>0 then raise exception 'unknown candidate count cannot retain rows' using errcode='42501'; end if;
  elsif new.record_count<>actual_records or new.feature_count<>actual_features
    or (actual_records>0 and (first_index<>1 or last_index<>actual_records)) then
    raise exception 'candidate counts do not match original rows' using errcode='42501';
  end if;
  if exists (select 1 from ingestion.candidate_record record, lateral jsonb_object_keys(record.record_values) field
    where record.processing_batch_id=new.processing_batch_id and record.asset_id=new.asset_id
      and not exists(select 1 from jsonb_array_elements(new.columns) column_value where column_value->>'key'=field)) then
    raise exception 'candidate original field is undeclared' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger candidate_asset_guard before insert or update or delete on ingestion.candidate_asset
  for each row execute function ingestion.guard_candidate_asset();

create function ingestion.guard_candidate_record() returns trigger language plpgsql set search_path=pg_catalog as $$
declare
  batch_row ingestion.candidate_batch%rowtype;
begin
  if tg_op<>'INSERT' then raise exception 'candidate original rows are immutable' using errcode='42501'; end if;
  select batch.* into batch_row from ingestion.candidate_batch batch
    join ingestion.candidate_asset asset on asset.tenant_id=batch.tenant_id and asset.project_id=batch.project_id and asset.processing_batch_id=batch.processing_batch_id
    where batch.tenant_id=new.tenant_id and batch.project_id=new.project_id and batch.processing_batch_id=new.processing_batch_id
      and asset.asset_id=new.asset_id and asset.status='PENDING' and asset.security_level=new.security_level and asset.policy_version=new.policy_version for share of batch,asset;
  if not found or batch_row.status<>'PENDING' or batch_row.security_level<>new.security_level or batch_row.policy_version<>new.policy_version
    or not ingestion.candidate_worker_lease(batch_row.tenant_id,batch_row.project_id,batch_row.ingestion_id,batch_row.operation_id,batch_row.security_level,batch_row.policy_version)
    or (select count(*) from jsonb_object_keys(new.record_values))>256 then
    raise exception 'candidate record binding conflict' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger candidate_record_guard before insert or update or delete on ingestion.candidate_record
  for each row execute function ingestion.guard_candidate_record();

-- Invoker/RLS-bound assembly. No private storage keys, credentials or approval state.
create function ingestion.candidate_batch_result(requested_batch uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('reference',jsonb_build_object('kind','ingestion-candidate','ingestionId',batch.ingestion_id,
    'reviewHash',encode(batch.review_hash,'hex'),'processingBatchId',batch.processing_batch_id),
    'parserVersion',batch.parser_version,'status',batch.status,'createdAt',batch.created_at,
    'assets',(select coalesce(jsonb_agg(jsonb_build_object('assetId',asset.asset_id,'sourceHash',encode(asset.source_hash,'hex'),
      'status',asset.status,'reason',asset.reason,'recordCount',asset.record_count,'featureCount',asset.feature_count) order by asset.asset_id),'[]'::jsonb)
      from ingestion.candidate_asset asset where asset.processing_batch_id=batch.processing_batch_id))
  from ingestion.candidate_batch batch where batch.processing_batch_id=requested_batch and batch.status<>'PENDING';
$$;

revoke all on function ingestion.candidate_worker_lease(uuid,uuid,uuid,uuid,text,bigint) from public;
revoke all on function ingestion.candidate_readable(uuid,uuid,uuid,uuid,bytea,text,bigint) from public;
revoke all on function ingestion.guard_candidate_batch() from public;
revoke all on function ingestion.guard_candidate_asset() from public;
revoke all on function ingestion.guard_candidate_record() from public;
revoke all on function ingestion.candidate_batch_result(uuid) from public;
