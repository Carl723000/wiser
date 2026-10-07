-- A bounded historical READY branch; no new state, Auth identity or grant.
-- The policy supplies the actual immutable batch row. Request JSON only narrows
-- the fixed selection and cannot declare its status or historical eligibility.
create function ingestion.candidate_historical_ready_readable(requested ingestion.candidate_batch)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare refs jsonb; frozen ingestion.transform_plan%rowtype; members jsonb; member jsonb;
begin
  if requested.status is distinct from 'READY' or requested.completed_at is null
    or requested.completed_at<requested.created_at
    or not pg_has_role(current_user,'wiser_data_api','MEMBER')
    or security.authorized_row(requested.tenant_id,requested.project_id,
      requested.security_level,requested.policy_version) is distinct from true then return false; end if;
  refs:=nullif(current_setting('wiser.candidate_fixed_refs',true),'')::jsonb;
  if service.valid_candidate_view_refs(refs) is distinct from true
    or not exists(select 1 from jsonb_array_elements(refs) ref
      where lower(ref->>'ingestionId')=requested.ingestion_id::text
        and lower(ref->>'processingBatchId')=requested.processing_batch_id::text
        and ref->>'reviewHash'=encode(requested.review_hash,'hex')) then return false; end if;

  -- Reuse the unchanged current-plan predicate on a real newer plan. This
  -- preserves current session/policy/purpose/submission/delegator checks and
  -- failure/cancellation closure without removing its latest-plan guard.
  select plan.* into frozen from ingestion.transform_plan plan
    join ingestion.session session on session.tenant_id=plan.tenant_id
      and session.project_id=plan.project_id and session.ingestion_id=plan.ingestion_id
    where plan.tenant_id=requested.tenant_id and plan.project_id=requested.project_id
      and plan.ingestion_id=requested.ingestion_id and plan.transform_plan_id=requested.transform_plan_id
      and plan.plan_hash=requested.review_hash and plan.status in ('REVIEW_REQUIRED','APPROVED','REJECTED')
      and plan.plan #> '{assetManifest,reviewGovernance}'=session.review_policy_snapshot;
  if not found or not exists(select 1 from ingestion.transform_plan newer
    where newer.tenant_id=frozen.tenant_id and newer.project_id=frozen.project_id
      and newer.ingestion_id=frozen.ingestion_id and newer.plan_version>frozen.plan_version
      and ingestion.candidate_readable(requested.tenant_id,requested.project_id,requested.ingestion_id,
        newer.transform_plan_id,newer.plan_hash,requested.security_level,requested.policy_version)) then return false; end if;

  -- Completion already checked the actual original bytes, all member outcomes
  -- and counts under the leased Worker guard. Recheck exact frozen membership
  -- against current CLEAN inputs without reading recursively protected children
  -- or catalog originals. Original delivery still checks actual bytes/security.
  members:=frozen.plan #> '{assetManifest,assets}';
  if frozen.plan->>'reviewHash' is distinct from encode(requested.review_hash,'hex')
    or jsonb_typeof(frozen.plan->'assetIds') is distinct from 'array'
    or jsonb_array_length(frozen.plan->'assetIds') not between 1 and 10000
    or jsonb_typeof(members) is distinct from 'array'
    or jsonb_array_length(members)<>jsonb_array_length(frozen.plan->'assetIds') then return false; end if;
  if (select array_agg(lower(value) order by lower(value)) from jsonb_array_elements_text(frozen.plan->'assetIds'))
    is distinct from (select array_agg(lower(value->>'assetId') order by lower(value->>'assetId')) from jsonb_array_elements(members))
    or (select count(distinct lower(value->>'assetId')) from jsonb_array_elements(members))<>jsonb_array_length(members) then return false; end if;
  for member in select value from jsonb_array_elements(members) loop
    if (member->>'assetId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') is distinct from true
      or (member->>'sourceHash' ~ '^[a-f0-9]{64}$') is distinct from true then return false; end if;
    if not exists(select 1 from ingestion.input_asset input
      where input.tenant_id=requested.tenant_id and input.project_id=requested.project_id
        and input.ingestion_id=requested.ingestion_id and input.asset_id=(member->>'assetId')::uuid
        and input.scan_status='CLEAN' and input.fingerprint=decode(member->>'sourceHash','hex')
        and security.authorized_row(input.tenant_id,input.project_id,input.security_level,input.policy_version)) then return false; end if;
  end loop;
  return true;
exception when data_exception then return false;
end $$;

alter policy candidate_batch_read on ingestion.candidate_batch using (
  ingestion.candidate_readable(tenant_id,project_id,ingestion_id,transform_plan_id,review_hash,security_level,policy_version)
  or ingestion.candidate_historical_ready_readable(candidate_batch)
);

-- Preserve every original-specific bound and the existing catalog policy.
create or replace function ingestion.candidate_original_readable(
  requested_tenant uuid, requested_project uuid, requested_asset uuid,
  requested_security text, requested_policy bigint
) returns boolean language sql stable set search_path=pg_catalog as $$
  select pg_has_role(current_user,'wiser_data_api','MEMBER')
    and security.authorized_row(requested_tenant,requested_project,requested_security,requested_policy)
    and requested_asset::text=current_setting('wiser.candidate_original_asset',true)
    and exists (select 1 from ingestion.candidate_batch batch
      join ingestion.candidate_asset original using(tenant_id,project_id,processing_batch_id)
      where batch.tenant_id=requested_tenant and batch.project_id=requested_project
        and batch.ingestion_id::text=current_setting('wiser.candidate_original_ingestion',true)
        and batch.processing_batch_id::text=current_setting('wiser.candidate_original_batch',true)
        and encode(batch.review_hash,'hex')=current_setting('wiser.candidate_original_review_hash',true)
        and original.asset_id=requested_asset and original.status not in ('PENDING','RESTRICTED')
        and batch.status<>'PENDING'
        and (ingestion.candidate_readable(batch.tenant_id,batch.project_id,batch.ingestion_id,
          batch.transform_plan_id,batch.review_hash,batch.security_level,batch.policy_version)
          or ingestion.candidate_historical_ready_readable(batch)))
$$;

revoke all on function ingestion.candidate_historical_ready_readable(ingestion.candidate_batch) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wiser_data_runtime') then
    grant execute on function ingestion.candidate_historical_ready_readable(ingestion.candidate_batch) to wiser_data_runtime;
  end if;
end $$;
