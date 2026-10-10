-- Preserve whole-record equality for already supported nested candidate geometry.
-- The column is Geometry,4326: native 15,0 leaves match the old default CRS
-- behavior. Keep simple/flat/empty on the original serializer, including errors.
-- No identity, authority, lifecycle, function privilege or historical row changes.
create or replace function ingestion.candidate_followup_sources_readable(requested_tenant uuid, requested_project uuid, sources jsonb) returns boolean
language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare evidence jsonb; found_source boolean; refs jsonb;
  previous text:=coalesce(current_setting('wiser.candidate_fixed_refs',true),'');
begin
  if not service.candidate_saved_authority_live() or jsonb_typeof(sources) is distinct from 'array'
    or jsonb_array_length(sources) not between 1 and 65 then return false; end if;
  if exists(select 1 from jsonb_array_elements(sources) source
    where ingestion.valid_candidate_followup_evidence(source) is distinct from true) then return false; end if;
  select jsonb_agg(reference) into refs from (select distinct source->'reference' reference from jsonb_array_elements(sources) source) selected;
  if service.valid_candidate_view_refs(refs) is distinct from true then return false; end if;
  perform set_config('wiser.candidate_fixed_refs',refs::text,true);
  for evidence in select value from jsonb_array_elements(sources) loop
    select exists(select 1 from ingestion.candidate_batch b
      join ingestion.candidate_asset a on a.tenant_id=b.tenant_id and a.project_id=b.project_id and a.processing_batch_id=b.processing_batch_id
      join ingestion.session s on s.tenant_id=b.tenant_id and s.project_id=b.project_id and s.ingestion_id=b.ingestion_id
      join ingestion.project_review_policy policy on policy.tenant_id=s.tenant_id and policy.project_id=s.project_id
      where b.tenant_id=requested_tenant and b.project_id=requested_project and b.status<>'PENDING'
        and b.ingestion_id=(evidence#>>'{reference,ingestionId}')::uuid
        and b.processing_batch_id=(evidence#>>'{reference,processingBatchId}')::uuid
        and b.review_hash=decode(evidence#>>'{reference,reviewHash}','hex')
        and a.asset_id=(evidence->>'assetId')::uuid and a.source_hash=decode(evidence->>'sourceHash','hex')
        and a.status not in ('PENDING','RESTRICTED')
        and s.submitted_by_actor_id is not null and s.submitted_actor_type in ('human','agent','service')
        and policy.enabled and s.review_policy_snapshot=jsonb_build_object('mode',policy.mode,'revision',policy.revision)
        and (not evidence ? 'recordId' or exists(select 1 from ingestion.candidate_record record
          where record.tenant_id=b.tenant_id and record.project_id=b.project_id and record.processing_batch_id=b.processing_batch_id
            and record.asset_id=a.asset_id and record.record_id=(evidence->>'recordId')::uuid
            and record.source_id=evidence->>'locator'
            and (not evidence ? 'geometry' or (record.geom is not null
              and (WITH RECURSIVE geometry_root AS MATERIALIZED (
 SELECT record.geom::public.geometry AS geom
), geometry_route AS MATERIALIZED (
 SELECT geom,CASE WHEN public.ST_GeometryType(geom)='ST_GeometryCollection' THEN EXISTS (
  SELECT 1 FROM generate_series(1,public.ST_NumGeometries(geom)) ordinal
  WHERE public.ST_GeometryType(public.ST_GeometryN(geom,ordinal))='ST_GeometryCollection'
 ) ELSE false END AS nested FROM geometry_root
), geometry_tree(path,geom) AS (
 SELECT ARRAY[]::integer[],geom FROM geometry_route WHERE nested
 UNION ALL
 SELECT t.path||ordinal,public.ST_GeometryN(t.geom,ordinal)
 FROM geometry_tree t CROSS JOIN LATERAL generate_series(1,
  CASE WHEN public.ST_GeometryType(t.geom)='ST_GeometryCollection'
  THEN public.ST_NumGeometries(t.geom) ELSE 0 END) ordinal
), geometry_tokens(path,token) AS (
 SELECT path,CASE WHEN path[array_length(path,1)]>1 THEN ',' ELSE '' END ||
  CASE WHEN public.ST_GeometryType(geom)='ST_GeometryCollection'
   THEN '{"type":"GeometryCollection","geometries":['
   ELSE public.ST_AsGeoJSON(geom,15,0) END FROM geometry_tree
 UNION ALL
 SELECT path||(public.ST_NumGeometries(geom)+1),']}'
 FROM geometry_tree WHERE public.ST_GeometryType(geom)='ST_GeometryCollection'
)
SELECT CASE WHEN nested THEN (SELECT string_agg(token,'' ORDER BY path) FROM geometry_tokens)
 ELSE public.st_asgeojson(record.geom,15) END FROM geometry_route)::jsonb=evidence->'geometry'
              and record.source_crs=evidence->>'sourceCrs'))))) into found_source;
    if not found_source then
      perform set_config('wiser.candidate_fixed_refs',previous,true); return false;
    end if;
  end loop;
  perform set_config('wiser.candidate_fixed_refs',previous,true); return true;
exception when others then
  perform set_config('wiser.candidate_fixed_refs',previous,true); return false;
end $$;
