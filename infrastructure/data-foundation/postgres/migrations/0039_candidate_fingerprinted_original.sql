-- The canonical fingerprint stage binds content before the frozen review checkpoint.
-- Preserve 0037 history and the existing lifecycle constraint; never approve or publish.
create or replace function ingestion.guard_candidate_asset() returns trigger language plpgsql set search_path=pg_catalog as $$
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
        and asset.content_hash=new.source_hash and blob.byte_size=asset.byte_size
        and input.scan_status='CLEAN'
        and asset.lifecycle_state='FINGERPRINTED' and asset.version_id is null
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
