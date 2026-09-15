-- Extend optional evidence pins without rewriting immutable bindings or relaxing tenant/project scope.
create or replace function knowledge.guard_relation_binding() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if not exists(select 1 from knowledge.assertion a join knowledge.evidence_fragment e using(tenant_id,project_id,evidence_fragment_id)
    where a.assertion_id=new.assertion_id and a.tenant_id=new.tenant_id and a.project_id=new.project_id
      and e.version_id=new.version_id and e.data_item_id=new.data_item_id
      and a.subject=new.candidate->'subject' and a.predicate=new.candidate->>'predicate' and a.object=new.candidate->'object'
      and a.confidence is null and a.status='PENDING_REVIEW') then
    raise exception 'Relation binding must match its pending source assertion' using errcode='23514';
  end if;
  if jsonb_array_length(new.candidate->'evidence') not between 1 and 64 or exists(
    select 1 from jsonb_array_elements(new.candidate->'evidence') e where not exists(
      select 1 from catalog.asset a where a.tenant_id=new.tenant_id and a.project_id=new.project_id and a.version_id=coalesce((e->'source'->>'versionId')::uuid,new.version_id)
        and a.asset_id=(e->>'assetId')::uuid and a.content_hash=decode(e->>'sourceHash','hex') and a.lifecycle_state='RAW'
        and security.security_rank(a.security_level)<=security.security_rank(new.security_level)
        and (not (e ? 'source') or exists(
          select 1 from catalog.data_item_version ev join catalog.data_item ei using(tenant_id,project_id,data_item_id)
          join service.analysis_run ar on ar.version_id=ev.version_id and ar.tenant_id=ev.tenant_id and ar.project_id=ev.project_id
          join service.analysis_asset aa on aa.analysis_id=ar.analysis_id and aa.asset_id=a.asset_id and aa.source_hash=a.content_hash and aa.status in ('READY','PARTIAL')
          join catalog.analysis_record er on er.analysis_id=ar.analysis_id and er.asset_id=a.asset_id and er.tenant_id=a.tenant_id and er.project_id=a.project_id
          where ev.version_id=a.version_id and ev.tenant_id=new.tenant_id and ev.project_id=new.project_id
            and ei.data_item_id=(e->'source'->>'dataItemId')::uuid
            and ev.publication_status='PUBLISHED' and ei.publication_status='PUBLISHED'
            and ev.acceptance_status in ('PASSED','CONDITIONALLY_PASSED') and ei.acceptance_status in ('PASSED','CONDITIONALLY_PASSED')
            and ar.analysis_id=(e->'source'->>'analysisId')::uuid and ar.completed_at is not null and ar.status in ('READY','PARTIAL')
            and er.record_id=(e->'source'->>'recordId')::uuid and e->>'locator'='record:'||er.record_id::text
            and (e->>'excerpt' is null or exists(select 1 from jsonb_each_text(er.record_values) field where strpos(field.value,e->>'excerpt')>0))
            and greatest(security.security_rank(ev.security_level),security.security_rank(ei.security_level),security.security_rank(ar.security_level),security.security_rank(er.security_level),security.security_rank(aa.security_level))<=security.security_rank(new.security_level)
        )))) then
    raise exception 'Relation evidence must bind saved source files' using errcode='23514';
  end if;
  return new;
end $$;
