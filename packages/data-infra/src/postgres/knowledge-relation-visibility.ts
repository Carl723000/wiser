/** SQL predicates shared by authoritative reads and rebuildable graph projections.
 * Aliases are application constants, never caller-supplied SQL. RLS remains active.
 */
function alias(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw Error('Invalid relation alias');
  return value;
}
export function relationSourceVisibleSql(name = 'b'): string {
  const b = alias(name);
  return `exists(select 1 from catalog.data_item_version v join catalog.data_item i using(tenant_id,project_id,data_item_id)
    where v.version_id=${b}.version_id and i.data_item_id=${b}.data_item_id and v.publication_status='PUBLISHED' and i.publication_status='PUBLISHED'
    and v.acceptance_status in ('PASSED','CONDITIONALLY_PASSED') and i.acceptance_status in ('PASSED','CONDITIONALLY_PASSED'))
    and not exists(select 1 from jsonb_array_elements(${b}.candidate->'evidence') e where not exists(select 1 from catalog.asset s where s.asset_id=(e->>'assetId')::uuid and s.version_id=${b}.version_id and s.content_hash=decode(e->>'sourceHash','hex') and s.lifecycle_state='RAW'))`;
}
export function relationVisibleSql(name = 'b'): string {
  const b = alias(name);
  return `(${relationSourceVisibleSql(b)}) and not exists (
    select 1 from (values (${b}.candidate->'subject'),(${b}.candidate->'object')) endpoint(entity)
    where entity ? 'reference' and not exists (
      select 1 from knowledge.assertion_binding rb join knowledge.assertion ra using(tenant_id,project_id,assertion_id)
      cross join lateral (values(rb.candidate->'subject'),(rb.candidate->'object')) target(value)
      where rb.tenant_id=${b}.tenant_id and rb.project_id=${b}.project_id
      and rb.data_item_id=(entity->'reference'->>'dataItemId')::uuid
      and rb.version_id=(entity->'reference'->>'versionId')::uuid
      and rb.mapping_version=entity->'reference'->>'mappingVersion'
      and value->>'key'=entity->'reference'->>'entityKey'
      and value->>'kind'=entity->>'kind' and value->>'label'=entity->>'label'
      and (value->'externalId') is not distinct from (entity->'externalId')
      and not (value ? 'reference') and ra.status in ('APPROVED','PENDING_REVIEW')
      and (${relationSourceVisibleSql('rb')})
    )
  )`;
}
