/** SQL predicates shared by authoritative reads and rebuildable graph projections.
 * Aliases are application constants, never caller-supplied SQL. RLS remains active.
 */
function alias(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw Error('Invalid relation alias');
  return value;
}
/** External evidence pins a completed parsed record as well as its original bytes.
 * Legacy local evidence keeps its original locator semantics. The pinned asset
 * is resolved before joins so each evidence does not rescan the whole catalog.
 */
export function relationEvidenceVisibleSql(
  evidence = 'e',
  owner = 'b',
): string {
  const e = alias(evidence),
    b = alias(owner);
  return `exists(with evidence_asset as materialized (
      select pinned.* from catalog.asset pinned where pinned.asset_id=(${e}->>'assetId')::uuid
      and pinned.version_id=coalesce((${e}->'source'->>'versionId')::uuid,${b}.version_id)
      and pinned.content_hash=decode(${e}->>'sourceHash','hex') and pinned.lifecycle_state='RAW'
    ) select 1 from evidence_asset s join catalog.data_item_version owner_version on owner_version.version_id=${b}.version_id
    where s.tenant_id=owner_version.tenant_id and s.project_id=owner_version.project_id
    and (not (${e} ? 'source') or exists(
      select 1 from catalog.data_item_version ev join catalog.data_item ei using(tenant_id,project_id,data_item_id)
      join service.analysis_run ar on ar.version_id=ev.version_id and ar.tenant_id=ev.tenant_id and ar.project_id=ev.project_id
      join service.analysis_asset aa on aa.analysis_id=ar.analysis_id and aa.asset_id=s.asset_id and aa.source_hash=s.content_hash and aa.status in ('READY','PARTIAL')
      join catalog.analysis_record er on er.analysis_id=ar.analysis_id and er.asset_id=s.asset_id and er.tenant_id=s.tenant_id and er.project_id=s.project_id
      where ev.version_id=s.version_id and ei.data_item_id=(${e}->'source'->>'dataItemId')::uuid
      and ev.publication_status='PUBLISHED' and ei.publication_status='PUBLISHED'
      and ev.acceptance_status in ('PASSED','CONDITIONALLY_PASSED') and ei.acceptance_status in ('PASSED','CONDITIONALLY_PASSED')
      and ar.analysis_id=(${e}->'source'->>'analysisId')::uuid and ar.completed_at is not null and ar.status in ('READY','PARTIAL')
      and er.record_id=(${e}->'source'->>'recordId')::uuid
      and ${e}->>'locator'='record:'||er.record_id::text
      and (${e}->>'excerpt' is null or exists(select 1 from jsonb_each_text(er.record_values) field where strpos(field.value,${e}->>'excerpt')>0))
    )))`;
}
export function relationSourceVisibleSql(name = 'b'): string {
  const b = alias(name);
  return `exists(select 1 from catalog.data_item_version v join catalog.data_item i using(tenant_id,project_id,data_item_id)
    where v.version_id=${b}.version_id and i.data_item_id=${b}.data_item_id and v.publication_status='PUBLISHED' and i.publication_status='PUBLISHED'
    and v.acceptance_status in ('PASSED','CONDITIONALLY_PASSED') and i.acceptance_status in ('PASSED','CONDITIONALLY_PASSED'))
    and not exists(select 1 from jsonb_array_elements(${b}.candidate->'evidence') e where not (${relationEvidenceVisibleSql('e', b)}))`;
}
// Resolve the pinned reference scope before expanding its endpoints and checking
// evidence. Materialization prevents unrelated bindings from repeating those checks.
export function relationVisibleSql(name = 'b'): string {
  const b = alias(name);
  return `(${relationSourceVisibleSql(b)}) and not exists (
    select 1 from (values (${b}.candidate->'subject'),(${b}.candidate->'object')) endpoint(entity)
    where entity ? 'reference' and not exists (
      with reference_bindings as materialized (
        select scoped.* from knowledge.assertion_binding scoped
        where scoped.tenant_id=${b}.tenant_id and scoped.project_id=${b}.project_id
        and scoped.data_item_id=(entity->'reference'->>'dataItemId')::uuid
        and scoped.version_id=(entity->'reference'->>'versionId')::uuid
        and scoped.mapping_version=entity->'reference'->>'mappingVersion'
      )
      select 1 from reference_bindings rb join knowledge.assertion ra using(tenant_id,project_id,assertion_id)
      cross join lateral (values(rb.candidate->'subject'),(rb.candidate->'object')) target(value)
      where value->>'key'=entity->'reference'->>'entityKey'
      and value->>'kind'=entity->>'kind' and value->>'label'=entity->>'label'
      and (value->'externalId') is not distinct from (entity->'externalId')
      and not (value ? 'reference') and ra.status in ('APPROVED','PENDING_REVIEW')
      and (${relationSourceVisibleSql('rb')})
    )
  )`;
}

/** Provenance/search reads must not expose a bound fragment after any source is withdrawn. */
export function relationFragmentVisibleSql(name = 'fragment'): string {
  const f = alias(name);
  return `not exists(select 1 from knowledge.assertion a join knowledge.assertion_binding b using(tenant_id,project_id,assertion_id)
    where a.evidence_fragment_id=${f}.evidence_fragment_id and not (${relationVisibleSql('b')}))`;
}
