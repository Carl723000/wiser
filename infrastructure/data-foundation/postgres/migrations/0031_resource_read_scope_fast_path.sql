-- Do not expand the managed resource joins into every caller's query plan.
-- These invoker functions read RLS-visible child rows, so a resource grant
-- continues to intersect tenant, project, security and policy-version rules.
create function security.resource_related_ids(target_kind text)
returns table(id uuid)
language plpgsql stable parallel restricted set search_path=pg_catalog as $$
begin
  if security.resource_scope_legacy() then return; end if;

  case target_kind
    when 'item' then
      return query select distinct v.data_item_id from catalog.data_item_version v;
    when 'version' then
      return query select v.version_id from catalog.data_item_version v;
    when 'analysis' then
      return query select a.analysis_id from service.analysis_run a;
    when 'field' then
      return query select s.schema_version_id from catalog.schema_version s;
    when 'evidence' then
      return query select e.evidence_fragment_id from knowledge.evidence_fragment e;
    when 'assertion' then
      return query select a.assertion_id from knowledge.assertion a;
    else
      return;
  end case;
end $$;

create function security.resource_related_item_versions()
returns table(data_item_id uuid,version_id uuid)
language plpgsql stable parallel restricted set search_path=pg_catalog as $$
begin
  if security.resource_scope_legacy() then return; end if;
  return query select v.data_item_id,v.version_id
    from catalog.data_item_version v;
end $$;

create function security.resource_related_item_schemas()
returns table(data_item_id uuid,schema_version_id uuid)
language plpgsql stable parallel restricted set search_path=pg_catalog as $$
begin
  if security.resource_scope_legacy() then return; end if;
  return query select v.data_item_id,v.schema_version_id
    from catalog.data_item_version v where v.schema_version_id is not null;
end $$;

create function security.resource_related_asset_versions()
returns table(asset_id uuid,version_id uuid)
language plpgsql stable parallel restricted set search_path=pg_catalog as $$
begin
  if security.resource_scope_legacy() then return; end if;
  return query select a.asset_id,a.version_id
    from catalog.asset a where a.version_id is not null;
end $$;

-- Content-addressed blobs may be shared by sources with identical bytes.
-- A visible asset only authorizes the blob whose identity facts match it.
create function security.resource_related_blob_facts()
returns table(content_blob_id uuid,content_hash bytea,byte_size bigint)
language plpgsql stable parallel restricted set search_path=pg_catalog as $$
begin
  if security.resource_scope_legacy() then return; end if;
  return query select a.content_blob_id,a.content_hash,a.byte_size
    from catalog.asset a
    where a.content_blob_id is not null and a.content_hash is not null;
end $$;

revoke all on function security.resource_related_ids(text),security.resource_related_item_versions(),
  security.resource_related_item_schemas(),security.resource_related_asset_versions(),
  security.resource_related_blob_facts() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wiser_data_runtime') then
    grant execute on function security.resource_related_ids(text),security.resource_related_item_versions(),
      security.resource_related_item_schemas(),security.resource_related_asset_versions(),
      security.resource_related_blob_facts()
      to wiser_data_runtime;
  end if;
end $$;

-- The unchanged 0030 policy on catalog.data_item_version checks the exact
-- item/version grant. Every helper above selects through that policy (directly
-- or through another RLS-protected child), rather than bypassing it.
alter policy resource_read_scope on catalog.data_item using (
  case when (select security.resource_scope_legacy()) then true
    else data_item_id in (select id from security.resource_related_ids('item')) end
);
alter policy resource_read_scope on knowledge.assertion_binding using (
  case when (select security.resource_scope_legacy()) then true
    else (data_item_id,version_id) in (
      select data_item_id,version_id from security.resource_related_item_versions()
    ) end
);
do $$ declare target text; begin
  foreach target in array array[
    'catalog.asset','service.analysis_run','quality.check_run'
  ] loop
    execute format('alter policy resource_read_scope on %s using (
      case when (select security.resource_scope_legacy()) then true
        else version_id in (select id from security.resource_related_ids(''version'')) end
    )',target);
  end loop;
  foreach target in array array[
    'catalog.source_provenance','catalog.spatial_extent','catalog.temporal_extent',
    'service.projection_status','service.intake_assessment'
  ] loop
    execute format('alter policy resource_read_scope on %s using (
      case when (select security.resource_scope_legacy()) then true
        else (data_item_id,version_id) in (
          select data_item_id,version_id from security.resource_related_item_versions()
        ) end
    )',target);
  end loop;
  foreach target in array array[
    'service.analysis_asset','catalog.analysis_record','service.analysis_amap_geometry'
  ] loop
    execute format('alter policy resource_read_scope on %s using (
      case when (select security.resource_scope_legacy()) then true
        else analysis_id in (select id from security.resource_related_ids(''analysis'')) end
    )',target);
  end loop;
end $$;
alter policy resource_read_scope on knowledge.evidence_fragment using (
  case when (select security.resource_scope_legacy()) then true
    else (data_item_id,version_id) in (
      select data_item_id,version_id from security.resource_related_item_versions()
    ) and (asset_id is null or (asset_id,version_id) in (
      select asset_id,version_id from security.resource_related_asset_versions()
    )) end
);
alter policy resource_read_scope on catalog.schema_version using (
  case when (select security.resource_scope_legacy()) then true
    else (data_item_id,schema_version_id) in (
      select data_item_id,schema_version_id from security.resource_related_item_schemas()
    ) end
);
alter policy resource_read_scope on catalog.field_definition using (
  case when (select security.resource_scope_legacy()) then true
    else schema_version_id in (select id from security.resource_related_ids('field')) end
);
alter policy resource_read_scope on catalog.content_blob using (
  case when (select security.resource_scope_legacy()) then true
    else (content_blob_id,content_hash,byte_size) in (
      select content_blob_id,content_hash,byte_size from security.resource_related_blob_facts()
    ) end
);
alter policy resource_read_scope on knowledge.assertion using (
  case when (select security.resource_scope_legacy()) then true
    else evidence_fragment_id in (select id from security.resource_related_ids('evidence')) end
);
alter policy resource_read_scope on knowledge.review_record using (
  case when (select security.resource_scope_legacy()) then true
    else assertion_id in (select id from security.resource_related_ids('assertion')) end
);
alter policy resource_read_scope on lineage.edge using (
  case when (select security.resource_scope_legacy()) then true
    else (from_data_item_id,from_version_id) in (
      select data_item_id,version_id from security.resource_related_item_versions()
    ) and (to_data_item_id,to_version_id) in (
      select data_item_id,version_id from security.resource_related_item_versions()
    ) end
);
