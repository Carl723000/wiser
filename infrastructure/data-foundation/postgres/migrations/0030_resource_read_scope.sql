-- Resource grants remain authoritative in the control database. The trusted API
-- installs one freshly compiled scope as a transaction-local setting; callers
-- cannot set it. This migration stores no grants and enables no project.
create function security.resource_scope_legacy() returns boolean
language sql stable parallel safe set search_path=pg_catalog as $$
  select nullif(current_setting('wiser.resource_scope',true),'') is null
$$;

-- This set is used as an uncorrelated policy subquery so PostgreSQL can hash it
-- once per scan, instead of decoding up to 1,000 references for every record.
create function security.resource_version_members()
returns table(data_item_id uuid,version_id uuid)
language plpgsql stable parallel safe set search_path=pg_catalog as $$
declare scope jsonb; refs jsonb; action text; deadline timestamptz;
begin
  scope := nullif(current_setting('wiser.resource_scope',true),'')::jsonb;
  action := nullif(current_setting('wiser.resource_action',true),'');
  if scope is null or scope->>'mode' is distinct from 'managed'
    or action is null or action not in ('content.read','original.read','result.export')
    or jsonb_typeof(scope->'permissions') is distinct from 'object'
    or jsonb_typeof(scope->'validUntil') is distinct from 'string'
  then return; end if;
  deadline := (scope->>'validUntil')::timestamptz;
  if deadline <= statement_timestamp() then return; end if;
  refs := scope->'permissions'->action;
  if jsonb_typeof(refs) is distinct from 'array' then return; end if;
  if jsonb_array_length(refs)>1000 then return; end if;
  if exists(select 1 from jsonb_array_elements(refs) r where
    jsonb_typeof(r) is distinct from 'object' or r->>'kind' not in ('version','external-source')
    or r->>'kind' is null
    or (r->>'kind'='version' and (
      jsonb_typeof(r->'dataItemId') is distinct from 'string'
      or jsonb_typeof(r->'versionId') is distinct from 'string'
      or (r->>'dataItemId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (r->>'versionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
  then return; end if;
  if action='result.export' then
    if jsonb_typeof(scope->'permissions'->'content.read') is distinct from 'array' then return; end if;
    return query select distinct (r->>'dataItemId')::uuid,(r->>'versionId')::uuid
      from jsonb_array_elements(refs) r where r->>'kind'='version'
        and scope->'permissions'->'content.read' @> jsonb_build_array(r);
  else
    return query select distinct (r->>'dataItemId')::uuid,(r->>'versionId')::uuid
      from jsonb_array_elements(refs) r where r->>'kind'='version';
  end if;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  return;
end $$;

-- Restrictive policies intersect the existing tenant/project/security RLS.
-- Discovery-only grants do not expose full metadata, contacts, excerpts or URLs.
create policy resource_read_scope on catalog.data_item as restrictive for select using (
  (select security.resource_scope_legacy()) or data_item_id in (select data_item_id from catalog.data_item_version)
);
create policy resource_read_scope on catalog.data_item_version as restrictive for select using (
  (select security.resource_scope_legacy()) or (data_item_id,version_id) in (select data_item_id,version_id from security.resource_version_members())
);

do $$ declare target text; begin
  foreach target in array array[
    'catalog.asset','catalog.source_provenance','catalog.spatial_extent','catalog.temporal_extent',
    'knowledge.evidence_fragment','knowledge.assertion_binding','service.analysis_run',
    'service.projection_status','service.intake_assessment','quality.check_run'
  ] loop
    execute format('create policy resource_read_scope on %s as restrictive for select using (
      (select security.resource_scope_legacy()) or version_id in (select version_id from catalog.data_item_version)
    )',target);
  end loop;
  foreach target in array array['service.analysis_asset','catalog.analysis_record','service.analysis_amap_geometry'] loop
    execute format('create policy resource_read_scope on %s as restrictive for select using (
      (select security.resource_scope_legacy()) or analysis_id in (select analysis_id from service.analysis_run)
    )',target);
  end loop;
end $$;
create policy resource_read_scope on catalog.schema_version as restrictive for select using (
  (select security.resource_scope_legacy()) or schema_version_id in (select schema_version_id from catalog.data_item_version)
);
create policy resource_read_scope on catalog.field_definition as restrictive for select using (
  (select security.resource_scope_legacy()) or schema_version_id in (select schema_version_id from catalog.schema_version)
);
create policy resource_read_scope on catalog.content_blob as restrictive for select using (
  (select security.resource_scope_legacy()) or content_blob_id in (select content_blob_id from catalog.asset)
);
create policy resource_read_scope on knowledge.assertion as restrictive for select using (
  (select security.resource_scope_legacy()) or evidence_fragment_id in (select evidence_fragment_id from knowledge.evidence_fragment)
);
create policy resource_read_scope on knowledge.review_record as restrictive for select using (
  (select security.resource_scope_legacy()) or assertion_id in (select assertion_id from knowledge.assertion)
);
create policy resource_read_scope on lineage.edge as restrictive for select using (
  (select security.resource_scope_legacy()) or (
    from_version_id in (select version_id from catalog.data_item_version)
    and to_version_id in (select version_id from catalog.data_item_version))
);
revoke all on function security.resource_scope_legacy(),security.resource_version_members() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wiser_data_runtime') then
    grant execute on function security.resource_scope_legacy(),security.resource_version_members() to wiser_data_runtime;
  end if;
end $$;
