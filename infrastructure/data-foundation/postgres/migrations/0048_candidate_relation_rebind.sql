-- Keeps all 0044 migration bytes and all candidate source/actor checks intact.
create table ingestion.candidate_relation_rebind (
  tenant_id uuid not null, project_id uuid not null,
  revision_id uuid not null, previous_revision_id uuid not null,
  mapping jsonb not null check(jsonb_typeof(mapping)='array' and jsonb_array_length(mapping) between 1 and 64 and octet_length(mapping::text)<=262144),
  created_at timestamptz not null default clock_timestamp(),
  primary key(tenant_id,project_id,revision_id),
  foreign key(tenant_id,project_id,revision_id) references ingestion.candidate_relation_revision(tenant_id,project_id,revision_id),
  foreign key(tenant_id,project_id,previous_revision_id) references ingestion.candidate_relation_revision(tenant_id,project_id,revision_id)
);
create function ingestion.guard_candidate_relation_rebind() returns trigger language plpgsql set search_path=pg_catalog as $$
declare prior ingestion.candidate_relation_revision%rowtype; next_revision ingestion.candidate_relation_revision%rowtype; member jsonb;
begin
  if tg_op<>'INSERT' then raise exception 'candidate rebind mapping is immutable' using errcode='42501'; end if;
  select * into prior from ingestion.candidate_relation_revision where tenant_id=new.tenant_id and project_id=new.project_id and revision_id=new.previous_revision_id;
  if not found then raise exception 'candidate rebind predecessor unavailable' using errcode='42501'; end if;
  select * into next_revision from ingestion.candidate_relation_revision where tenant_id=new.tenant_id and project_id=new.project_id and revision_id=new.revision_id;
  if not found or next_revision.supersedes_id is distinct from prior.revision_id or next_revision.relation_id<>prior.relation_id or next_revision.lineage_id<>prior.lineage_id or next_revision.revision<>prior.revision+1
    or not service.candidate_saved_authority_live() or current_setting('wiser.candidate_maintainer',true) is distinct from 'true'
    or not service.candidate_saved_owner(prior.submitted_by_actor_id,prior.submitted_actor_type,prior.submitted_delegator_actor_id)
    or not service.candidate_saved_owner(next_revision.submitted_by_actor_id,next_revision.submitted_actor_type,next_revision.submitted_delegator_actor_id)
    or not ingestion.candidate_relation_sources_readable(prior.tenant_id,prior.project_id,prior.content)
    or not ingestion.candidate_relation_sources_readable(next_revision.tenant_id,next_revision.project_id,next_revision.content)
    or jsonb_array_length(new.mapping)<>jsonb_array_length(prior.content->'evidence') or jsonb_array_length(new.mapping)<>jsonb_array_length(next_revision.content->'evidence') then
    raise exception 'candidate rebind requires exact current predecessor, owner and complete source mapping' using errcode='42501'; end if;
  for member in select value from jsonb_array_elements(new.mapping) loop
    if jsonb_typeof(member)<>'object' or (select count(*) from jsonb_object_keys(member))<>2 or not(member?'from' and member?'to')
      or not exists(select 1 from jsonb_array_elements(prior.content->'evidence') e where e=member->'from')
      or not exists(select 1 from jsonb_array_elements(next_revision.content->'evidence') e where e=member->'to') then
      raise exception 'candidate mapping does not match immutable evidence' using errcode='42501'; end if;
  end loop;
  -- Multiset equality preserves duplicate evidence ordinals without silently losing a member.
  if exists(select value from jsonb_array_elements(prior.content->'evidence') except all select value->'from' from jsonb_array_elements(new.mapping))
    or exists(select value from jsonb_array_elements(next_revision.content->'evidence') except all select value->'to' from jsonb_array_elements(new.mapping)) then
    raise exception 'candidate mapping must cover every old and new evidence member once' using errcode='42501'; end if;
  new.created_at:=clock_timestamp(); return new;
end $$;
create trigger candidate_relation_rebind_guard before insert or update or delete on ingestion.candidate_relation_rebind for each row execute function ingestion.guard_candidate_relation_rebind();
create function ingestion.require_candidate_relation_rebind() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.revision>1 and not exists(select 1 from ingestion.candidate_relation_rebind b where b.tenant_id=new.tenant_id and b.project_id=new.project_id and b.revision_id=new.revision_id and b.previous_revision_id=new.supersedes_id) then
    raise exception 'new candidate revision requires an explicit immutable rebind mapping' using errcode='42501'; end if;
  return null;
end $$;
create constraint trigger candidate_relation_rebind_complete after insert on ingestion.candidate_relation_revision deferrable initially deferred for each row execute function ingestion.require_candidate_relation_rebind();
alter table ingestion.candidate_relation_rebind enable row level security;
alter table ingestion.candidate_relation_rebind force row level security;
create policy candidate_relation_rebind_read on ingestion.candidate_relation_rebind for select using (
  exists(select 1 from ingestion.candidate_relation_revision r where r.tenant_id=candidate_relation_rebind.tenant_id and r.project_id=candidate_relation_rebind.project_id and r.revision_id=candidate_relation_rebind.revision_id)
  and exists(select 1 from ingestion.candidate_relation_revision r where r.tenant_id=candidate_relation_rebind.tenant_id and r.project_id=candidate_relation_rebind.project_id and r.revision_id=candidate_relation_rebind.previous_revision_id));
create policy candidate_relation_rebind_insert on ingestion.candidate_relation_rebind for insert with check (
  service.candidate_saved_authority_live() and current_setting('wiser.candidate_maintainer',true)='true'
  and exists(select 1 from ingestion.candidate_relation_revision r where r.tenant_id=candidate_relation_rebind.tenant_id and r.project_id=candidate_relation_rebind.project_id and r.revision_id=candidate_relation_rebind.revision_id)
  and exists(select 1 from ingestion.candidate_relation_revision r where r.tenant_id=candidate_relation_rebind.tenant_id and r.project_id=candidate_relation_rebind.project_id and r.revision_id=candidate_relation_rebind.previous_revision_id));
revoke all on ingestion.candidate_relation_rebind from public;
do $$ begin
  if to_regrole('wiser_data_runtime') is not null then revoke all on ingestion.candidate_relation_rebind from wiser_data_runtime; end if;
  if to_regrole('wiser_data_worker') is not null then revoke all on ingestion.candidate_relation_rebind from wiser_data_worker; end if;
  if to_regrole('wiser_data_api') is not null then revoke all on ingestion.candidate_relation_rebind from wiser_data_api; grant select,insert on ingestion.candidate_relation_rebind to wiser_data_api; end if;
end $$;
