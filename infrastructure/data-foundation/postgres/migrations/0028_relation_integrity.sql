-- Internal integrity registry: never exposed through RLS-filtered business reads.
-- Conflicting legacy identities require explicit remediation; never choose a winner.
create table security.relation_entity_definition (
  tenant_id uuid not null,
  project_id uuid not null,
  version_id uuid not null,
  mapping_version text not null,
  entity_key text not null,
  definition jsonb not null,
  primary key (tenant_id,project_id,version_id,mapping_version,entity_key)
);
alter table security.relation_entity_definition enable row level security;
-- No runtime policies/grants: only its owning integrity trigger can access definitions.
revoke all on security.relation_entity_definition from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wiser_data_runtime') then
    revoke all on security.relation_entity_definition from wiser_data_runtime;
  end if;
  if exists (
    select 1 from knowledge.assertion_binding b
    cross join lateral (values(b.candidate->'subject'),(b.candidate->'object')) e(value)
    where not (value ? 'reference')
    group by b.tenant_id,b.project_id,b.version_id,b.mapping_version,value->>'key'
    having count(distinct jsonb_build_object('label',value->'label','kind',value->'kind','externalId',value->'externalId'))>1
  ) then
    raise exception 'Conflicting relation entity definitions require remediation' using errcode='23514';
  end if;
end $$;
insert into security.relation_entity_definition
select distinct b.tenant_id,b.project_id,b.version_id,b.mapping_version,value->>'key',
  jsonb_build_object('label',value->'label','kind',value->'kind','externalId',value->'externalId')
from knowledge.assertion_binding b
cross join lateral (values(b.candidate->'subject'),(b.candidate->'object')) e(value)
where not (value ? 'reference');
create function security.guard_relation_entity_definition() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare entity jsonb; expected jsonb; saved jsonb;
begin
  if not security.authorized_row(new.tenant_id,new.project_id,new.security_level,new.policy_version) then
    raise exception 'Relation integrity conflict' using errcode='23514';
  end if;
  for entity in select value from (values(new.candidate->'subject'),(new.candidate->'object')) e(value)
    where not (value ? 'reference') order by value->>'key'
  loop
    expected := jsonb_build_object('label',entity->'label','kind',entity->'kind','externalId',entity->'externalId');
    insert into security.relation_entity_definition values(new.tenant_id,new.project_id,new.version_id,new.mapping_version,entity->>'key',expected)
    on conflict do nothing;
    select definition into saved from security.relation_entity_definition
      where tenant_id=new.tenant_id and project_id=new.project_id and version_id=new.version_id
        and mapping_version=new.mapping_version and entity_key=entity->>'key' for update;
    if saved is distinct from expected then
      raise exception 'Relation integrity conflict' using errcode='23514';
    end if;
  end loop;
  return new;
end $$;
revoke all on function security.guard_relation_entity_definition() from public;
create trigger relation_entity_definition_guard before insert on knowledge.assertion_binding
for each row execute function security.guard_relation_entity_definition();
-- row_version starts at one and advances only with a corresponding immutable review.
create function knowledge.guard_relation_review_limit() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  if exists(select 1 from knowledge.assertion_binding where assertion_id=new.assertion_id)
    and (new.row_version < 2 or new.row_version > 101) then
    raise exception 'Relation review limit reached' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function knowledge.guard_relation_review_limit() from public;
create trigger relation_review_limit before insert on knowledge.review_record
for each row execute function knowledge.guard_relation_review_limit();
