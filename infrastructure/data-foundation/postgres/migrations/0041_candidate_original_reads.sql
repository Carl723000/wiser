-- Only one frozen original, under current API maintenance/review authority.
-- No publication, resource grant, storage address or new Auth identity is minted.
create function ingestion.candidate_original_readable(
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
        and ingestion.candidate_readable(batch.tenant_id,batch.project_id,batch.ingestion_id,
          batch.transform_plan_id,batch.review_hash,batch.security_level,batch.policy_version))
$$;

-- Preserve the existing restrictive version/action and owned-quarantine clauses
-- verbatim, including additive maintenance policies installed by 0040.
do $$ declare existing_qual text; begin
  select pg_get_expr(polqual,polrelid) into existing_qual from pg_policy
    where polrelid='catalog.asset'::regclass and polname='resource_read_scope'
      and not polpermissive and polcmd='r';
  if existing_qual is null then
    raise exception 'candidate original requires the existing restrictive asset scope';
  end if;
  execute format('alter policy resource_read_scope on catalog.asset using ((%s) or (
    version_id is null and lifecycle_state=''FINGERPRINTED'' and
    ingestion.candidate_original_readable(tenant_id,project_id,asset_id,security_level,policy_version)))',existing_qual);
end $$;

revoke all on function ingestion.candidate_original_readable(uuid,uuid,uuid,text,bigint) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wiser_data_runtime') then
    grant execute on function ingestion.candidate_original_readable(uuid,uuid,uuid,text,bigint) to wiser_data_runtime;
  end if;
end $$;
