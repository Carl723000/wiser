-- Private historical O/P equivalence, never a claim that historical P was generated here.
-- An active processing Worker writes once while the same frozen candidate is PENDING.
create function ingestion.valid_conversion_summary(value jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare field text; total bigint; differences jsonb;
begin
  if jsonb_typeof(value) is distinct from 'object' or octet_length(value::text)>8192
    or (select count(*) from jsonb_object_keys(value))<>7
    or not value ?& array['tableCount','physicalCellCount','emptyCellCount','paragraphCount','monthTitleCount','differenceCount','differences'] then return false; end if;
  foreach field in array array['tableCount','physicalCellCount','emptyCellCount','paragraphCount','monthTitleCount','differenceCount'] loop
    if jsonb_typeof(value->field) is distinct from 'number' or (value->>field) !~ '^[0-9]{1,7}$'
      or (value->>field)::bigint>2000000 then return false; end if;
  end loop;
  differences:=value->'differences'; total:=(value->>'differenceCount')::bigint;
  if (value->>'tableCount')::bigint>10000
    or (value->>'emptyCellCount')::bigint>(value->>'physicalCellCount')::bigint
    or (value->>'monthTitleCount')::bigint>(value->>'paragraphCount')::bigint
    or jsonb_typeof(differences) is distinct from 'array' then return false; end if;
  if jsonb_array_length(differences)<>least(total,16) or exists(select 1 from jsonb_array_elements(differences) path
    where jsonb_typeof(path) is distinct from 'string' or length(path #>> '{}') not between 1 and 256
      or (path #>> '{}') !~ '^[a-zA-Z0-9_.\[\]-]+$') then return false; end if;
  return true;
end;
$$;

create table ingestion.candidate_conversion_check (
  result_id uuid primary key,
  tenant_id uuid not null,
  project_id uuid not null,
  processing_batch_id uuid not null,
  ingestion_id uuid not null,
  review_hash bytea not null check(octet_length(review_hash)=32),
  original_asset_id uuid not null,
  original_hash bytea not null check(octet_length(original_hash)=32),
  original_byte_size bigint not null check(original_byte_size between 1 and 2147483648),
  prepared_asset_id uuid not null,
  prepared_hash bytea not null check(octet_length(prepared_hash)=32),
  prepared_byte_size bigint not null check(prepared_byte_size between 1 and 2147483648),
  manifest_asset_id uuid not null,
  manifest_hash bytea not null check(octet_length(manifest_hash)=32),
  source_local_work_id text not null check(length(source_local_work_id) between 1 and 256),
  historical_tool_version text check(length(historical_tool_version) between 1 and 128),
  result_kind text not null check(result_kind='HISTORICAL_EQUIVALENCE'),
  result_state text not null check(result_state in ('VERIFIED_EQUIVALENT','NOT_EQUIVALENT','UNVERIFIABLE')),
  rule_id text not null check(length(rule_id) between 1 and 128),
  rule_version text not null check(length(rule_version) between 1 and 128),
  tool_name text check(length(tool_name) between 1 and 128),
  tool_version text check(length(tool_version) between 1 and 128),
  tool_digest bytea check(octet_length(tool_digest)=32),
  reconverted_hash bytea check(octet_length(reconverted_hash)=32),
  comparison_digest bytea check(octet_length(comparison_digest)=32),
  comparison_summary jsonb check(comparison_summary is null or ingestion.valid_conversion_summary(comparison_summary)),
  failure_reason text check(failure_reason in ('TOOL_UNAVAILABLE','CONVERSION_FAILED','INVALID_STRUCTURE','BUDGET_EXCEEDED','STRUCTURE_DIFFERENT')),
  worker_job_id uuid not null,
  worker_job_attempt integer not null check(worker_job_attempt>0),
  worker_lease_owner text not null check(length(worker_lease_owner) between 1 and 256),
  operation_id uuid not null,
  submitted_by_actor_id uuid not null,
  submitted_actor_type text not null check(submitted_actor_type in ('human','agent','service')),
  submitted_delegator_actor_id uuid,
  review_governance jsonb not null check(jsonb_typeof(review_governance)='object' and octet_length(review_governance::text)<=256),
  -- This fixed processing purpose is not a caller's business authorization.
  purpose text not null check(purpose='candidate-conversion-verification'),
  security_level text not null check(security.is_valid_security_level(security_level)),
  policy_version bigint not null check(policy_version>0),
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,project_id,processing_batch_id,prepared_asset_id),
  foreign key(tenant_id,project_id,processing_batch_id) references ingestion.candidate_batch(tenant_id,project_id,processing_batch_id),
  foreign key(tenant_id,project_id,processing_batch_id,original_asset_id) references ingestion.candidate_asset(tenant_id,project_id,processing_batch_id,asset_id),
  foreign key(tenant_id,project_id,processing_batch_id,prepared_asset_id) references ingestion.candidate_asset(tenant_id,project_id,processing_batch_id,asset_id),
  foreign key(tenant_id,project_id,processing_batch_id,manifest_asset_id) references ingestion.candidate_asset(tenant_id,project_id,processing_batch_id,asset_id),
  foreign key(tenant_id,project_id,worker_job_id) references ingestion.job(tenant_id,project_id,job_id),
  foreign key(tenant_id,project_id,operation_id) references service.operation(tenant_id,project_id,operation_id),
  check(original_asset_id<>prepared_asset_id and original_asset_id<>manifest_asset_id and prepared_asset_id<>manifest_asset_id),
  check((submitted_actor_type='human' and submitted_delegator_actor_id is null) or (submitted_actor_type in ('agent','service') and submitted_delegator_actor_id is not null)),
  check((tool_name is null)=(tool_version is null) and (tool_name is null)=(tool_digest is null)),
  check(case when result_state='UNVERIFIABLE' then failure_reason is not null and failure_reason<>'STRUCTURE_DIFFERENT' and comparison_summary is null
    else tool_name is not null and reconverted_hash is not null and comparison_digest is not null and comparison_summary is not null
      and case when result_state='VERIFIED_EQUIVALENT' then failure_reason is null and comparison_summary->>'differenceCount'='0'
        else failure_reason is not null and failure_reason='STRUCTURE_DIFFERENT' and (comparison_summary->>'differenceCount')::bigint>0 end end)
);

create function ingestion.guard_candidate_conversion_check() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare batch ingestion.candidate_batch%rowtype; session_row ingestion.session%rowtype; plan_row ingestion.transform_plan%rowtype; member record;
begin
  if tg_op<>'INSERT' then raise exception 'conversion check history is immutable' using errcode='42501'; end if;
  select * into batch from ingestion.candidate_batch where tenant_id=new.tenant_id and project_id=new.project_id
    and processing_batch_id=new.processing_batch_id for update;
  if not found or batch.status<>'PENDING' or batch.ingestion_id<>new.ingestion_id or batch.review_hash<>new.review_hash
    or batch.operation_id<>new.operation_id or batch.security_level<>new.security_level or batch.policy_version<>new.policy_version
    or not ingestion.candidate_worker_lease(batch.tenant_id,batch.project_id,batch.ingestion_id,batch.operation_id,batch.security_level,batch.policy_version)
    or new.worker_job_id is distinct from nullif(current_setting('wiser.candidate_job_id',true),'')::uuid
    or new.worker_job_attempt is distinct from nullif(current_setting('wiser.candidate_job_attempt',true),'')::integer
    or new.worker_lease_owner is distinct from current_setting('wiser.candidate_job_owner',true) then
    raise exception 'conversion result requires the current pending Worker lease' using errcode='42501'; end if;
  select * into session_row from ingestion.session where tenant_id=new.tenant_id and project_id=new.project_id and ingestion_id=new.ingestion_id for share;
  if not found or session_row.state<>'REVIEW_REQUIRED' or session_row.operation_id<>new.operation_id
    or row(session_row.submitted_by_actor_id,session_row.submitted_actor_type,session_row.submitted_delegator_actor_id)
      is distinct from row(new.submitted_by_actor_id,new.submitted_actor_type,new.submitted_delegator_actor_id)
    or session_row.review_policy_snapshot is distinct from new.review_governance
    or not ingestion.assert_current_review_policy(session_row) then
    raise exception 'conversion result requires immutable submission responsibility and current governance' using errcode='42501'; end if;
  select * into plan_row from ingestion.transform_plan where tenant_id=new.tenant_id and project_id=new.project_id
    and transform_plan_id=batch.transform_plan_id and ingestion_id=new.ingestion_id for share;
  if not found or plan_row.status<>'REVIEW_REQUIRED' or plan_row.plan_hash<>new.review_hash
    or plan_row.plan #> '{assetManifest,reviewGovernance}' is distinct from new.review_governance
    or exists(select 1 from ingestion.transform_plan newer where newer.tenant_id=plan_row.tenant_id and newer.project_id=plan_row.project_id
      and newer.ingestion_id=plan_row.ingestion_id and newer.plan_version>plan_row.plan_version) then
    raise exception 'conversion result requires the latest exact frozen plan' using errcode='42501'; end if;
  for member in select * from (values(new.original_asset_id,new.original_hash,new.original_byte_size),
    (new.prepared_asset_id,new.prepared_hash,new.prepared_byte_size),(new.manifest_asset_id,new.manifest_hash,null::bigint)) as members(asset_id,source_hash,byte_size) loop
    if not exists(select 1 from ingestion.candidate_asset candidate
      join ingestion.input_asset input on input.tenant_id=candidate.tenant_id and input.project_id=candidate.project_id and input.asset_id=candidate.asset_id and input.ingestion_id=new.ingestion_id
      join catalog.asset asset on asset.tenant_id=input.tenant_id and asset.project_id=input.project_id and asset.asset_id=input.asset_id
      join catalog.content_blob blob on blob.tenant_id=asset.tenant_id and blob.project_id=asset.project_id and blob.content_blob_id=asset.content_blob_id
      where candidate.tenant_id=new.tenant_id and candidate.project_id=new.project_id and candidate.processing_batch_id=new.processing_batch_id
        and candidate.asset_id=member.asset_id and candidate.source_hash=member.source_hash
        and input.fingerprint=member.source_hash and input.scan_status='CLEAN' and asset.content_hash=member.source_hash and blob.content_hash=member.source_hash
        and asset.byte_size=blob.byte_size and (member.byte_size is null or member.byte_size=asset.byte_size)
        and asset.lifecycle_state='FINGERPRINTED' and asset.version_id is null
        and plan_row.plan->'assetIds' ? member.asset_id::text
        and exists(select 1 from jsonb_array_elements(plan_row.plan #> '{assetManifest,assets}') frozen
          where frozen->>'assetId'=member.asset_id::text and frozen->>'sourceHash'=encode(member.source_hash,'hex')
            and frozen->>'size'=asset.byte_size::text and frozen->>'mediaType'=asset.media_type
            and frozen->>'ordinal'=input.ordinal::text and frozen->>'quarantineObjectRef'=asset.storage_key)) then
      raise exception 'conversion result member does not match actual frozen original bytes' using errcode='42501'; end if;
  end loop;
  new.created_at:=clock_timestamp();
  return new;
end;
$$;
create trigger candidate_conversion_check_guard before insert or update or delete on ingestion.candidate_conversion_check
  for each row execute function ingestion.guard_candidate_conversion_check();

-- The carrier and completed parse must commit together; no supplementary result
-- can be attached to an old completed batch by a new insert.
create function ingestion.guard_candidate_conversion_commit() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare batch ingestion.candidate_batch%rowtype;
begin
  select * into batch from ingestion.candidate_batch where tenant_id=new.tenant_id and project_id=new.project_id
    and processing_batch_id=new.processing_batch_id for share;
  if not found or batch.status='PENDING' then
    raise exception 'conversion check and candidate completion must commit together' using errcode='42501'; end if;
  -- The final fence serializes with cancellation and rechecks timeout/lease at commit.
  perform 1 from ingestion.job where tenant_id=new.tenant_id and project_id=new.project_id and job_id=new.worker_job_id for update;
  if not ingestion.candidate_worker_lease(batch.tenant_id,batch.project_id,batch.ingestion_id,batch.operation_id,batch.security_level,batch.policy_version)
    or new.worker_job_id is distinct from nullif(current_setting('wiser.candidate_job_id',true),'')::uuid
    or new.worker_job_attempt is distinct from nullif(current_setting('wiser.candidate_job_attempt',true),'')::integer
    or new.worker_lease_owner is distinct from current_setting('wiser.candidate_job_owner',true) then
    raise exception 'conversion lease, cancellation or timeout changed before commit' using errcode='42501'; end if;
  return null;
end;
$$;
create constraint trigger candidate_conversion_commit_guard after insert on ingestion.candidate_conversion_check
  deferrable initially deferred for each row execute function ingestion.guard_candidate_conversion_commit();

alter table ingestion.candidate_conversion_check enable row level security;
alter table ingestion.candidate_conversion_check force row level security;
create policy candidate_conversion_read on ingestion.candidate_conversion_check for select using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and exists(select 1 from ingestion.candidate_batch batch where batch.tenant_id=candidate_conversion_check.tenant_id
    and batch.project_id=candidate_conversion_check.project_id and batch.processing_batch_id=candidate_conversion_check.processing_batch_id
    and (batch.status<>'PENDING' or ingestion.candidate_worker_lease(batch.tenant_id,batch.project_id,batch.ingestion_id,batch.operation_id,batch.security_level,batch.policy_version)))
);
create policy candidate_conversion_insert on ingestion.candidate_conversion_check for insert with check (
  ingestion.candidate_worker_lease(tenant_id,project_id,ingestion_id,operation_id,security_level,policy_version)
);
revoke all on ingestion.candidate_conversion_check from public;
-- Existing roles can be narrowed now; bootstrap runs must append the same grants
-- in provision-runtime.sql after role creation. Triggers and FORCE RLS also deny API writes.
do $$
begin
  if to_regrole('wiser_data_runtime') is not null then execute 'revoke all on ingestion.candidate_conversion_check from wiser_data_runtime'; end if;
  if to_regrole('wiser_data_api') is not null then execute 'revoke all on ingestion.candidate_conversion_check from wiser_data_api'; execute 'grant select on ingestion.candidate_conversion_check to wiser_data_api'; end if;
  if to_regrole('wiser_data_worker') is not null then execute 'revoke all on ingestion.candidate_conversion_check from wiser_data_worker'; execute 'grant select,insert on ingestion.candidate_conversion_check to wiser_data_worker'; end if;
end;
$$;
