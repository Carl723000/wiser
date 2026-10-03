-- Pending maintenance uses fresh API authority and immutable submission facts.
-- It grants no published content, approval, original download or new Auth identity.
create function ingestion.pending_subject_access(submitter uuid, subject_type text, delegator text)
returns boolean language plpgsql stable set search_path=pg_catalog as $$
declare scope jsonb; deadline timestamptz;
begin
  if not pg_has_role(current_user,'wiser_data_api','MEMBER')
    or submitter is null or subject_type not in ('human','agent','service')
    or subject_type is null
    or (subject_type='human' and nullif(delegator,'') is not null)
    or (subject_type<>'human' and coalesce(delegator,'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or coalesce(current_setting('wiser.candidate_purpose',true),'') !~ '^[a-z][a-z0-9-]{0,95}$'
  then return false; end if;
  scope:=nullif(current_setting('wiser.resource_scope',true),'')::jsonb;
  if scope is null or scope->>'mode' is distinct from 'managed'
    or jsonb_typeof(scope->'permissions') is distinct from 'object'
    or jsonb_typeof(scope->'validUntil') not in ('string','null')
    or not (scope ? 'validUntil') then return false; end if;
  -- null means no resource grants set a deadline, not a grant to published data.
  if jsonb_typeof(scope->'validUntil')='string' then
    deadline:=(scope->>'validUntil')::timestamptz;
    if deadline<=statement_timestamp() then return false; end if;
  end if;
  return (
    current_setting('wiser.candidate_maintainer',true)='true' and (
      (current_setting('wiser.actor_type',true)='human'
        and nullif(current_setting('wiser.delegated_by',true),'') is null
        and ((subject_type='human' and submitter::text=current_setting('wiser.actor_id',true))
          or delegator=current_setting('wiser.actor_id',true)))
      or (current_setting('wiser.actor_type',true) in ('agent','service')
        and subject_type=current_setting('wiser.actor_type',true)
        and submitter::text=current_setting('wiser.actor_id',true)
        and nullif(delegator,'') is not null
        and delegator=current_setting('wiser.delegated_by',true))
    )
  ) or (
    current_setting('wiser.candidate_reviewer',true)='true'
    and current_setting('wiser.actor_type',true)='human'
    and nullif(current_setting('wiser.delegated_by',true),'') is null
    and submitter::text<>current_setting('wiser.actor_id',true)
    and coalesce(delegator,'')<>current_setting('wiser.actor_id',true)
  );
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  return false;
end $$;

create policy pending_subject_scope on ingestion.session as restrictive for select using (
  (select security.resource_scope_legacy())
  or (owner_project_id=project_id and ingestion.pending_subject_access(
    submitted_by_actor_id,submitted_actor_type,submitted_delegator_actor_id::text))
);
create policy pending_subject_scope on ingestion.input_asset as restrictive for select using (
  (select security.resource_scope_legacy()) or ingestion_id in (select ingestion_id from ingestion.session)
);

-- Only completed, owned quarantine assets can become a new ingestion. The same
-- owned upload may INSERT ... RETURNING its assets while completing. Existing
-- version/action-grant visibility is retained verbatim for published assets.
drop policy resource_read_scope on catalog.asset;
create policy resource_read_scope on catalog.asset as restrictive for select using (
  (select security.resource_scope_legacy()) or version_id in (select id from security.resource_related_ids('version'))
  or (version_id is null and lifecycle_state='QUARANTINED'
    and current_setting('wiser.candidate_maintainer',true)='true'
    and current_setting('wiser.intake_capability',true) in ('data.uploadSession.complete','data.ingestion.create')
    and exists (select 1 from service.operation origin
      where origin.tenant_id=asset.tenant_id and origin.project_id=asset.project_id
        and origin.capability_id='data.uploadSession.create'
        and (origin.status='SUCCEEDED' or (origin.status='WAITING_INPUT'
          and current_setting('wiser.intake_capability',true)='data.uploadSession.complete'))
        and origin.request_payload->'assets' @> jsonb_build_array(jsonb_build_object('assetId',asset.asset_id::text))
        and origin.request_payload #>> '{intakeResponsibility,actorId}'=origin.actor_id::text
        and coalesce(origin.request_payload #>> '{intakeResponsibility,purpose}','') ~ '^[a-z][a-z0-9-]{0,95}$'
        and ingestion.pending_subject_access(origin.actor_id,
          origin.request_payload #>> '{intakeResponsibility,actorType}',
          origin.request_payload #>> '{intakeResponsibility,delegatedBy}')))
);
revoke all on function ingestion.pending_subject_access(uuid,text,text) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wiser_data_runtime') then
    grant execute on function ingestion.pending_subject_access(uuid,text,text) to wiser_data_runtime;
  end if;
end $$;
