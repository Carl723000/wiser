-- Private candidate knowledge: immutable content revisions and separate decisions.
-- No catalog-version aliases, published assertion writes, source grants or new Auth authority.
create function ingestion.candidate_relation_keys(value jsonb, required text[], optional text[] default array[]::text[]) returns boolean
language sql immutable set search_path=pg_catalog as $$
  select coalesce(jsonb_typeof(value)='object' and value ?& required
    and not exists(select 1 from jsonb_object_keys(value) key where key<>all(required||optional)),false);
$$;
create function ingestion.candidate_relation_text(value jsonb, maximum integer, nullable boolean default false) returns boolean
language sql immutable set search_path=pg_catalog as $$
  select coalesce((nullable and jsonb_typeof(value)='null') or
    (jsonb_typeof(value)='string' and length(btrim(value#>>'{}')) between 1 and maximum),false);
$$;
create function ingestion.valid_candidate_relation_entity(value jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if not ingestion.candidate_relation_keys(value,array['key','label','kind','externalId'],array['reference'])
    or not ingestion.candidate_relation_text(value->'key',256) or not ingestion.candidate_relation_text(value->'label',1024)
    or not ingestion.candidate_relation_text(value->'externalId',256,true)
    or (value->>'kind' in ('ENTERPRISE','MONITORING_POINT','INDICATOR_RECORD','RIVER_REACH','BASIN','EXTERNAL_ENTITY','PERSON','ORGANIZATION','CLAIM','EVENT','DOCUMENT','OBSERVATION','POLICY','MODEL_RUN','PLACE')) is distinct from true then return false; end if;
  if value ? 'reference' and (not ingestion.candidate_relation_keys(value->'reference',array['reference','mappingVersion','entityKey'])
    or service.valid_candidate_view_reference(value#>'{reference,reference}') is distinct from true
    or not ingestion.candidate_relation_text(value#>'{reference,mappingVersion}',128)
    or not ingestion.candidate_relation_text(value#>'{reference,entityKey}',256)
    or value#>>'{reference,entityKey}' is distinct from value->>'key') then return false; end if;
  return true;
exception when others then return false;
end $$;
create function ingestion.valid_candidate_relation_content(value jsonb, primary_ref jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare q jsonb; context jsonb; evidence jsonb; entity jsonb; endpoint_sources jsonb;
  uuid_pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if service.valid_candidate_view_reference(primary_ref) is distinct from true
    or not ingestion.candidate_relation_keys(value,array['subject','predicate','object','qualifiers','generation','evidence'])
    or octet_length(value::text)>100000 or not ingestion.valid_candidate_relation_entity(value->'subject')
    or not ingestion.valid_candidate_relation_entity(value->'object')
    or (value->>'predicate' in ('HAS_DECLARED_MONITORING_POINT','HAS_REPORTED_INDICATOR','FLOWS_TO','BELONGS_TO_BASIN','CANDIDATE_RECEIVING_WATER','IDENTITY_MATCH','EXPRESSES_CLAIM','REPORTS_CLAIM','ABOUT_ENTITY','OBSERVES_ENTITY','OCCURRED_IN','CITES_SOURCE','DERIVED_FROM','APPLIES_TO','USES_DATA')) is distinct from true then return false; end if;
  q:=value->'qualifiers'; context:=q->'context';
  if not ingestion.candidate_relation_keys(q,array['measure','reportedValue','reportedLimit','unit','observedAt','missing','spatialScope','limitations','reportedConclusion','context'])
    or not ingestion.candidate_relation_keys(context,array['recordNature','timeRole','validFrom','validTo','locationRole','applicability'])
    or (context->>'recordNature' in ('EXPERT_VIEW','REPORTED_OBSERVATION','PLANNING_TARGET','SIMULATION','HISTORICAL_EVENT','INSTITUTIONAL_RECOMMENDATION','SOURCE_RELATION','UNKNOWN')) is distinct from true
    or (context->>'timeRole' in ('STATEMENT_TIME','PUBLICATION_TIME','OBSERVATION_TIME','EVENT_TIME','VALIDITY_PERIOD','UNKNOWN')) is distinct from true
    or (context->>'locationRole' in ('SUBJECT_AREA','STUDY_AREA','SAMPLING_LOCATION','VENUE','REFERENCE_LOCATION','UNKNOWN')) is distinct from true
    or not ingestion.candidate_relation_text(context->'applicability',1024)
    or not ingestion.candidate_relation_text(context->'validFrom',1024,true) or not ingestion.candidate_relation_text(context->'validTo',1024,true)
    or (context->>'timeRole'='OBSERVATION_TIME' and context->>'recordNature'<>'REPORTED_OBSERVATION')
    or jsonb_typeof(q->'missing') is distinct from 'boolean' or jsonb_typeof(q->'limitations') is distinct from 'array'
    or jsonb_array_length(q->'limitations')>16 or exists(select 1 from jsonb_array_elements(q->'limitations') item where not ingestion.candidate_relation_text(item,1024)) then return false; end if;
  foreach entity in array array[q->'measure',q->'unit',q->'observedAt',q->'spatialScope',q->'reportedConclusion'] loop
    if not ingestion.candidate_relation_text(entity,1024,true) then return false; end if;
  end loop;
  foreach entity in array array[q->'reportedValue',q->'reportedLimit'] loop
    if not (jsonb_typeof(entity)='null' or (jsonb_typeof(entity)='string' and length(entity#>>'{}')<=1024)) then return false; end if;
  end loop;
  if not ingestion.candidate_relation_keys(value->'generation',array['method','model'])
    or (value#>>'{generation,method}' in ('SOURCE_TABLE','SOURCE_FIELDS','MANUAL','MODEL_SUGGESTED')) is distinct from true
    or not ingestion.candidate_relation_text(value#>'{generation,model}',1024,true) then return false; end if;
  if value->>'predicate'='IDENTITY_MATCH' then
    if value#>>'{subject,kind}' is distinct from value#>>'{object,kind}'
      or context->>'recordNature'<>'SOURCE_RELATION' or not (value->'subject' ? 'reference') or not (value->'object' ? 'reference')
      or value#>'{subject,reference,reference}'=value#>'{object,reference,reference}' then return false; end if;
    endpoint_sources:=jsonb_build_array(value#>'{subject,reference,reference}',value#>'{object,reference,reference}');
    if not endpoint_sources @> jsonb_build_array(primary_ref) then return false; end if;
  else
    if value->'subject' ? 'reference' or value->'object' ? 'reference' then return false; end if;
    endpoint_sources:=jsonb_build_array(primary_ref);
  end if;
  -- Mirror registered endpoint rules without changing the published legacy validator.
  if case value->>'predicate'
    when 'IDENTITY_MATCH' then value#>>'{subject,kind}' not in ('PERSON','ORGANIZATION','ENTERPRISE','MONITORING_POINT','RIVER_REACH','BASIN','PLACE','EXTERNAL_ENTITY')
    when 'EXPRESSES_CLAIM' then value#>>'{subject,kind}' not in ('PERSON','ORGANIZATION') or value#>>'{object,kind}'<>'CLAIM'
    when 'REPORTS_CLAIM' then value#>>'{subject,kind}'<>'DOCUMENT' or value#>>'{object,kind}'<>'CLAIM'
    when 'ABOUT_ENTITY' then value#>>'{subject,kind}' not in ('CLAIM','EVENT','DOCUMENT','POLICY','MODEL_RUN')
    when 'OBSERVES_ENTITY' then value#>>'{subject,kind}'<>'OBSERVATION' or value#>>'{object,kind}' not in ('MONITORING_POINT','RIVER_REACH','BASIN','PLACE','ENTERPRISE','EXTERNAL_ENTITY') or context->>'recordNature'<>'REPORTED_OBSERVATION'
    when 'OCCURRED_IN' then value#>>'{subject,kind}'<>'EVENT' or value#>>'{object,kind}' not in ('RIVER_REACH','BASIN','PLACE')
    when 'CITES_SOURCE' then value#>>'{subject,kind}' not in ('DOCUMENT','CLAIM') or value#>>'{object,kind}'<>'DOCUMENT'
    when 'DERIVED_FROM' then value#>>'{subject,kind}' not in ('DOCUMENT','CLAIM','MODEL_RUN','OBSERVATION') or value#>>'{object,kind}' not in ('DOCUMENT','OBSERVATION','MODEL_RUN','EXTERNAL_ENTITY')
    when 'APPLIES_TO' then value#>>'{subject,kind}' not in ('POLICY','CLAIM')
    when 'USES_DATA' then value#>>'{subject,kind}'<>'MODEL_RUN' or value#>>'{object,kind}' not in ('DOCUMENT','OBSERVATION','EXTERNAL_ENTITY')
    else value#>>'{subject,kind}' not in ('ENTERPRISE','MONITORING_POINT','INDICATOR_RECORD','RIVER_REACH','BASIN','EXTERNAL_ENTITY') or value#>>'{object,kind}' not in ('ENTERPRISE','MONITORING_POINT','INDICATOR_RECORD','RIVER_REACH','BASIN','EXTERNAL_ENTITY') end then return false; end if;
  if jsonb_typeof(value->'evidence') is distinct from 'array' or jsonb_array_length(value->'evidence') not between 1 and 64 then return false; end if;
  for evidence in select * from jsonb_array_elements(value->'evidence') loop
    if not ingestion.candidate_relation_keys(evidence,array['reference','assetId','sourceHash','locator','excerpt','polarity'],array['recordId'])
      or service.valid_candidate_view_reference(evidence->'reference') is distinct from true
      or not endpoint_sources @> jsonb_build_array(evidence->'reference')
      or (evidence->>'assetId' ~* uuid_pattern) is distinct from true
      or (evidence ? 'recordId' and (evidence->>'recordId' ~* uuid_pattern) is distinct from true)
      or (evidence->>'sourceHash' ~ '^[a-f0-9]{64}$') is distinct from true
      or not ingestion.candidate_relation_text(evidence->'locator',1024)
      or not (jsonb_typeof(evidence->'excerpt')='null' or (jsonb_typeof(evidence->'excerpt')='string' and length(evidence->>'excerpt')<=4096))
      or (evidence->>'polarity' in ('SUPPORTS','CONTRADICTS')) is distinct from true then return false; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(endpoint_sources) endpoint where not exists
    (select 1 from jsonb_array_elements(value->'evidence') evidence where evidence->'reference'=endpoint)) then return false; end if;
  return true;
exception when others then return false;
end $$;

-- This invoker predicate reads candidate/source authority only, never any relation
-- table. Relation -> evidence/responsibility policies therefore cannot recurse.
create function ingestion.candidate_relation_sources_readable(requested_tenant uuid, requested_project uuid, content jsonb) returns boolean
language plpgsql volatile set search_path=pg_catalog as $$
declare evidence jsonb; found_source boolean;
begin
  if not service.candidate_saved_authority_live() or jsonb_typeof(content->'evidence') is distinct from 'array'
    or jsonb_array_length(content->'evidence') not between 1 and 64 then return false; end if;
  for evidence in select * from jsonb_array_elements(content->'evidence') loop
    select exists(select 1 from ingestion.candidate_batch b
      join ingestion.candidate_asset a on a.tenant_id=b.tenant_id and a.project_id=b.project_id and a.processing_batch_id=b.processing_batch_id
      join ingestion.session s on s.tenant_id=b.tenant_id and s.project_id=b.project_id and s.ingestion_id=b.ingestion_id
      join ingestion.project_review_policy policy on policy.tenant_id=s.tenant_id and policy.project_id=s.project_id
      where b.tenant_id=requested_tenant and b.project_id=requested_project and b.status<>'PENDING'
        and b.ingestion_id=(evidence#>>'{reference,ingestionId}')::uuid and b.processing_batch_id=(evidence#>>'{reference,processingBatchId}')::uuid
        and b.review_hash=decode(evidence#>>'{reference,reviewHash}','hex')
        and a.asset_id=(evidence->>'assetId')::uuid and a.source_hash=decode(evidence->>'sourceHash','hex')
        and s.submitted_by_actor_id is not null and s.submitted_actor_type in ('human','agent','service')
        and policy.enabled and s.review_policy_snapshot=jsonb_build_object('mode',policy.mode,'revision',policy.revision)
        and (not evidence ? 'recordId' or exists(select 1 from ingestion.candidate_record record
          where record.tenant_id=b.tenant_id and record.project_id=b.project_id and record.processing_batch_id=b.processing_batch_id
            and record.asset_id=a.asset_id and record.record_id=(evidence->>'recordId')::uuid
            and (evidence->'excerpt'='null'::jsonb or exists(select 1 from jsonb_path_query(record.record_values,'$.** ? (@.type() == "string")') field where strpos(field#>>'{}',evidence->>'excerpt')>0))))) into found_source;
    if not found_source then return false; end if;
  end loop;
  return true;
exception when others then return false;
end $$;

create table ingestion.candidate_relation_revision (
  revision_id uuid primary key, tenant_id uuid not null, project_id uuid not null,
  relation_id uuid not null, lineage_id uuid not null, revision integer not null check(revision>0), supersedes_id uuid,
  ingestion_id uuid not null, processing_batch_id uuid not null, review_hash bytea not null check(octet_length(review_hash)=32),
  mapping_version text not null check(length(mapping_version) between 1 and 128), rule_version text not null check(length(rule_version) between 1 and 128),
  content jsonb not null,
  submitted_by_actor_id uuid not null, submitted_actor_type text not null check(submitted_actor_type in ('human','agent','service')),
  submitted_delegator_actor_id uuid, purpose text not null check(length(purpose) between 1 and 96 and purpose ~ '^[a-z][a-z0-9-]*$'),
  security_level text not null check(security.is_valid_security_level(security_level)), policy_version bigint not null check(policy_version>0),
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,project_id,relation_id,revision), unique(tenant_id,project_id,revision_id),
  foreign key(tenant_id,project_id,processing_batch_id) references ingestion.candidate_batch(tenant_id,project_id,processing_batch_id),
  foreign key(tenant_id,project_id,supersedes_id) references ingestion.candidate_relation_revision(tenant_id,project_id,revision_id),
  check((revision=1)=(supersedes_id is null)),
  check((submitted_actor_type='human' and submitted_delegator_actor_id is null) or (submitted_actor_type in ('agent','service') and submitted_delegator_actor_id is not null)),
  check(ingestion.valid_candidate_relation_content(content,jsonb_build_object('kind','ingestion-candidate','ingestionId',ingestion_id,'processingBatchId',processing_batch_id,'reviewHash',encode(review_hash,'hex'))))
);
create table ingestion.candidate_relation_evidence (
  tenant_id uuid not null, project_id uuid not null, revision_id uuid not null, ordinal integer not null check(ordinal between 1 and 64),
  ingestion_id uuid not null, processing_batch_id uuid not null, review_hash bytea not null check(octet_length(review_hash)=32),
  asset_id uuid not null, record_id uuid, source_hash bytea not null check(octet_length(source_hash)=32),
  locator text not null check(length(btrim(locator)) between 1 and 1024), excerpt text check(length(excerpt)<=4096), polarity text not null check(polarity in ('SUPPORTS','CONTRADICTS')),
  primary key(tenant_id,project_id,revision_id,ordinal),
  foreign key(tenant_id,project_id,revision_id) references ingestion.candidate_relation_revision(tenant_id,project_id,revision_id),
  foreign key(tenant_id,project_id,processing_batch_id,asset_id) references ingestion.candidate_asset(tenant_id,project_id,processing_batch_id,asset_id),
  foreign key(processing_batch_id,record_id) references ingestion.candidate_record(processing_batch_id,record_id)
);
create table ingestion.candidate_relation_responsibility (
  tenant_id uuid not null, project_id uuid not null, revision_id uuid not null,
  responsibility_kind text not null check(responsibility_kind in ('RELATION','SOURCE')), source_batch_id uuid,
  actor_id uuid not null, actor_type text not null check(actor_type in ('human','agent','service')), delegated_by uuid,
  purpose text, review_governance jsonb,
  check((responsibility_kind='RELATION' and source_batch_id is null and purpose is not null and review_governance is null)
    or (responsibility_kind='SOURCE' and source_batch_id is not null and purpose is null and review_governance is not null)),
  check((actor_type='human' and delegated_by is null) or (actor_type in ('agent','service') and delegated_by is not null)),
  unique nulls not distinct(tenant_id,project_id,revision_id,responsibility_kind,source_batch_id),
  foreign key(tenant_id,project_id,revision_id) references ingestion.candidate_relation_revision(tenant_id,project_id,revision_id),
  foreign key(tenant_id,project_id,source_batch_id) references ingestion.candidate_batch(tenant_id,project_id,processing_batch_id)
);
create table ingestion.candidate_relation_decision (
  tenant_id uuid not null, project_id uuid not null, revision_id uuid not null, decision_version integer not null check(decision_version between 1 and 100),
  decision text not null check(decision in ('CONFIRMED','REJECTED','CORRECTION_REQUIRED','REVOKED','WITHDRAWN')),
  actor_id uuid not null, actor_type text not null check(actor_type in ('human','agent','service')), delegated_by uuid,
  purpose text not null check(length(purpose) between 1 and 96 and purpose ~ '^[a-z][a-z0-9-]*$'), rationale text not null check(length(btrim(rationale)) between 1 and 1024), created_at timestamptz not null default clock_timestamp(),
  primary key(tenant_id,project_id,revision_id,decision_version),
  foreign key(tenant_id,project_id,revision_id) references ingestion.candidate_relation_revision(tenant_id,project_id,revision_id),
  check((actor_type='human' and delegated_by is null) or (actor_type in ('agent','service') and delegated_by is not null))
);

create function ingestion.guard_candidate_relation_revision() returns trigger language plpgsql set search_path=pg_catalog as $$
declare b ingestion.candidate_batch%rowtype; prior ingestion.candidate_relation_revision%rowtype;
begin
  if tg_op<>'INSERT' then raise exception 'candidate relation content and responsibility are immutable' using errcode='42501'; end if;
  if not service.candidate_saved_authority_live() or current_setting('wiser.candidate_maintainer',true) is distinct from 'true'
    or not ingestion.candidate_relation_sources_readable(new.tenant_id,new.project_id,new.content)
    or row(new.submitted_by_actor_id,new.submitted_actor_type,new.submitted_delegator_actor_id,new.purpose) is distinct from
      row(nullif(current_setting('wiser.actor_id',true),'')::uuid,current_setting('wiser.actor_type',true),nullif(current_setting('wiser.delegated_by',true),'')::uuid,current_setting('wiser.purpose',true)) then
    raise exception 'candidate relation requires current source authority and exact trusted submission' using errcode='42501'; end if;
  select * into b from ingestion.candidate_batch where tenant_id=new.tenant_id and project_id=new.project_id and processing_batch_id=new.processing_batch_id;
  if not found or b.ingestion_id<>new.ingestion_id or b.review_hash<>new.review_hash
    or b.security_level<>new.security_level or b.policy_version<>new.policy_version then
    raise exception 'candidate relation does not match its exact scoped primary source' using errcode='42501'; end if;
  -- Serialize this immutable lineage without granting UPDATE or adding an UPDATE
  -- RLS policy merely to obtain a row lock. Fixed source rows remain read-only.
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text||':'||new.project_id::text||':'||new.relation_id::text,0));
  if new.revision>1 then
    select * into prior from ingestion.candidate_relation_revision where tenant_id=new.tenant_id and project_id=new.project_id and revision_id=new.supersedes_id;
    if not found or prior.relation_id<>new.relation_id or prior.lineage_id<>new.lineage_id or prior.revision<>new.revision-1
      or not service.candidate_saved_owner(prior.submitted_by_actor_id,prior.submitted_actor_type,prior.submitted_delegator_actor_id)
      or exists(select 1 from ingestion.candidate_relation_revision newer where newer.tenant_id=new.tenant_id and newer.project_id=new.project_id
        and newer.relation_id=new.relation_id and newer.revision>=new.revision) then
      raise exception 'candidate revision requires a readable exact latest predecessor and original responsibility' using errcode='42501'; end if;
  elsif exists(select 1 from ingestion.candidate_relation_revision old where old.tenant_id=new.tenant_id and old.project_id=new.project_id and old.relation_id=new.relation_id) then
    raise exception 'candidate relation lineage already exists' using errcode='40001'; end if;
  new.created_at:=clock_timestamp(); return new;
end $$;
create trigger candidate_relation_revision_guard before insert or update or delete on ingestion.candidate_relation_revision for each row execute function ingestion.guard_candidate_relation_revision();

create function ingestion.guard_candidate_relation_child() returns trigger language plpgsql set search_path=pg_catalog as $$
declare revision ingestion.candidate_relation_revision%rowtype; expected jsonb; session_row ingestion.session%rowtype;
begin
  if tg_op<>'INSERT' then raise exception 'candidate evidence and responsibilities are immutable' using errcode='42501'; end if;
  select * into revision from ingestion.candidate_relation_revision where tenant_id=new.tenant_id and project_id=new.project_id and revision_id=new.revision_id;
  if not found or not service.candidate_saved_authority_live() or not ingestion.candidate_relation_sources_readable(revision.tenant_id,revision.project_id,revision.content) then
    raise exception 'candidate child requires complete current source authority' using errcode='42501'; end if;
  if tg_table_name='candidate_relation_evidence' then
    expected:=revision.content->'evidence'->(new.ordinal-1);
    if row(new.ingestion_id,new.processing_batch_id,new.review_hash,new.asset_id,new.record_id,new.source_hash,new.locator,new.excerpt,new.polarity) is distinct from
      row((expected#>>'{reference,ingestionId}')::uuid,(expected#>>'{reference,processingBatchId}')::uuid,decode(expected#>>'{reference,reviewHash}','hex'),
        (expected->>'assetId')::uuid,(expected->>'recordId')::uuid,decode(expected->>'sourceHash','hex'),expected->>'locator',expected->>'excerpt',expected->>'polarity') then
      raise exception 'candidate evidence is not its fixed content member' using errcode='42501'; end if;
  elsif new.responsibility_kind='RELATION' then
    if row(new.actor_id,new.actor_type,new.delegated_by,new.purpose) is distinct from
      row(revision.submitted_by_actor_id,revision.submitted_actor_type,revision.submitted_delegator_actor_id,revision.purpose) then
      raise exception 'candidate relation responsibility is not immutable submission' using errcode='42501'; end if;
  else
    select s.* into session_row from ingestion.candidate_batch b join ingestion.session s on s.tenant_id=b.tenant_id and s.project_id=b.project_id and s.ingestion_id=b.ingestion_id
      where b.tenant_id=new.tenant_id and b.project_id=new.project_id and b.processing_batch_id=new.source_batch_id
        and exists(select 1 from jsonb_array_elements(revision.content->'evidence') e where (e#>>'{reference,processingBatchId}')::uuid=b.processing_batch_id);
    if not found or row(new.actor_id,new.actor_type,new.delegated_by,new.review_governance) is distinct from
      row(session_row.submitted_by_actor_id,session_row.submitted_actor_type,session_row.submitted_delegator_actor_id,session_row.review_policy_snapshot) then
      raise exception 'source responsibility does not match frozen source authority' using errcode='42501'; end if;
  end if;
  return new;
end $$;
create trigger candidate_relation_evidence_guard before insert or update or delete on ingestion.candidate_relation_evidence for each row execute function ingestion.guard_candidate_relation_child();
create trigger candidate_relation_responsibility_guard before insert or update or delete on ingestion.candidate_relation_responsibility for each row execute function ingestion.guard_candidate_relation_child();

create function ingestion.populate_candidate_relation_members() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  insert into ingestion.candidate_relation_evidence(tenant_id,project_id,revision_id,ordinal,ingestion_id,processing_batch_id,review_hash,asset_id,record_id,source_hash,locator,excerpt,polarity)
    select new.tenant_id,new.project_id,new.revision_id,e.ordinality::integer,(e.value#>>'{reference,ingestionId}')::uuid,(e.value#>>'{reference,processingBatchId}')::uuid,
      decode(e.value#>>'{reference,reviewHash}','hex'),(e.value->>'assetId')::uuid,(e.value->>'recordId')::uuid,decode(e.value->>'sourceHash','hex'),e.value->>'locator',e.value->>'excerpt',e.value->>'polarity'
    from jsonb_array_elements(new.content->'evidence') with ordinality e;
  insert into ingestion.candidate_relation_responsibility(tenant_id,project_id,revision_id,responsibility_kind,actor_id,actor_type,delegated_by,purpose)
    values(new.tenant_id,new.project_id,new.revision_id,'RELATION',new.submitted_by_actor_id,new.submitted_actor_type,new.submitted_delegator_actor_id,new.purpose);
  insert into ingestion.candidate_relation_responsibility(tenant_id,project_id,revision_id,responsibility_kind,source_batch_id,actor_id,actor_type,delegated_by,review_governance)
    select distinct new.tenant_id,new.project_id,new.revision_id,'SOURCE',b.processing_batch_id,s.submitted_by_actor_id,s.submitted_actor_type,s.submitted_delegator_actor_id,s.review_policy_snapshot
      from jsonb_array_elements(new.content->'evidence') e join ingestion.candidate_batch b on b.tenant_id=new.tenant_id and b.project_id=new.project_id and b.processing_batch_id=(e#>>'{reference,processingBatchId}')::uuid
      join ingestion.session s on s.tenant_id=b.tenant_id and s.project_id=b.project_id and s.ingestion_id=b.ingestion_id;
  return null;
end $$;
create trigger candidate_relation_members after insert on ingestion.candidate_relation_revision for each row execute function ingestion.populate_candidate_relation_members();

create function ingestion.guard_candidate_relation_decision() returns trigger language plpgsql set search_path=pg_catalog as $$
declare revision ingestion.candidate_relation_revision%rowtype; previous ingestion.candidate_relation_decision%rowtype; previous_version integer:=0; previous_state text:='PENDING_REVIEW';
begin
  if tg_op<>'INSERT' then raise exception 'candidate decisions are append-only' using errcode='42501'; end if;
  select * into revision from ingestion.candidate_relation_revision where tenant_id=new.tenant_id and project_id=new.project_id and revision_id=new.revision_id;
  if not found or not service.candidate_saved_authority_live() or not ingestion.candidate_relation_sources_readable(revision.tenant_id,revision.project_id,revision.content)
    or row(new.actor_id,new.actor_type,new.delegated_by,new.purpose) is distinct from row(nullif(current_setting('wiser.actor_id',true),'')::uuid,
      current_setting('wiser.actor_type',true),nullif(current_setting('wiser.delegated_by',true),'')::uuid,current_setting('wiser.purpose',true)) then
    raise exception 'candidate decision requires current complete source authority and trusted actor' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text||':'||new.project_id::text||':'||revision.relation_id::text,0));
  select * into previous from ingestion.candidate_relation_decision where tenant_id=new.tenant_id and project_id=new.project_id and revision_id=new.revision_id order by decision_version desc limit 1;
  if found then previous_version:=previous.decision_version; previous_state:=previous.decision; end if;
  if new.decision_version<>previous_version+1 then raise exception 'candidate decision version conflict' using errcode='40001'; end if;
  if not ((previous_state='PENDING_REVIEW' and new.decision in ('CONFIRMED','REJECTED','CORRECTION_REQUIRED','WITHDRAWN')) or (previous_state='CONFIRMED' and new.decision='REVOKED')) then
    raise exception 'candidate decision transition is not allowed' using errcode='42501'; end if;
  if new.decision='WITHDRAWN' then
    if current_setting('wiser.candidate_maintainer',true) is distinct from 'true'
      or not service.candidate_saved_owner(revision.submitted_by_actor_id,revision.submitted_actor_type,revision.submitted_delegator_actor_id) then
      raise exception 'only the current responsible proposer may withdraw a pending relation' using errcode='42501'; end if;
  elsif new.actor_type<>'human' or new.delegated_by is not null or current_setting('wiser.candidate_reviewer',true) is distinct from 'true'
    or not exists(select 1 from ingestion.candidate_relation_responsibility r where r.tenant_id=new.tenant_id and r.project_id=new.project_id and r.revision_id=new.revision_id and r.responsibility_kind='RELATION')
    or (select count(*) from ingestion.candidate_relation_responsibility r where r.tenant_id=new.tenant_id and r.project_id=new.project_id and r.revision_id=new.revision_id and r.responsibility_kind='SOURCE')
      <> (select count(distinct e#>>'{reference,processingBatchId}') from jsonb_array_elements(revision.content->'evidence') e)
    or exists(select 1 from ingestion.candidate_relation_responsibility r where r.tenant_id=new.tenant_id and r.project_id=new.project_id and r.revision_id=new.revision_id and (r.actor_id=new.actor_id or r.delegated_by=new.actor_id)) then
    raise exception 'candidate decision requires a non-delegated independent human excluding all source responsibilities' using errcode='42501'; end if;
  new.created_at:=clock_timestamp(); return new;
end $$;
create trigger candidate_relation_decision_guard before insert or update or delete on ingestion.candidate_relation_decision for each row execute function ingestion.guard_candidate_relation_decision();

alter table ingestion.candidate_relation_revision enable row level security;
alter table ingestion.candidate_relation_revision force row level security;
create policy candidate_relation_revision_read on ingestion.candidate_relation_revision for select using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version) and ingestion.candidate_relation_sources_readable(tenant_id,project_id,content));
create policy candidate_relation_revision_insert on ingestion.candidate_relation_revision for insert with check (
  security.authorized_row(tenant_id,project_id,security_level,policy_version) and service.candidate_saved_authority_live()
    and current_setting('wiser.candidate_maintainer',true)='true' and ingestion.candidate_relation_sources_readable(tenant_id,project_id,content));
do $$ declare table_name text; begin
  foreach table_name in array array['candidate_relation_evidence','candidate_relation_responsibility','candidate_relation_decision'] loop
    execute format('alter table ingestion.%I enable row level security',table_name);
    execute format('alter table ingestion.%I force row level security',table_name);
    execute format('create policy candidate_relation_child_read on ingestion.%I for select using (exists(select 1 from ingestion.candidate_relation_revision r where r.tenant_id=%I.tenant_id and r.project_id=%I.project_id and r.revision_id=%I.revision_id))',table_name,table_name,table_name,table_name);
    execute format('create policy candidate_relation_child_insert on ingestion.%I for insert with check (service.candidate_saved_authority_live() and exists(select 1 from ingestion.candidate_relation_revision r where r.tenant_id=%I.tenant_id and r.project_id=%I.project_id and r.revision_id=%I.revision_id))',table_name,table_name,table_name,table_name);
  end loop;
end $$;
revoke all on ingestion.candidate_relation_revision,ingestion.candidate_relation_evidence,ingestion.candidate_relation_responsibility,ingestion.candidate_relation_decision from public;
do $$ declare table_name text; begin
  foreach table_name in array array['candidate_relation_revision','candidate_relation_evidence','candidate_relation_responsibility','candidate_relation_decision'] loop
    if to_regrole('wiser_data_runtime') is not null then execute format('revoke all on ingestion.%I from wiser_data_runtime',table_name); end if;
    if to_regrole('wiser_data_worker') is not null then execute format('revoke all on ingestion.%I from wiser_data_worker',table_name); end if;
    if to_regrole('wiser_data_api') is not null then execute format('revoke all on ingestion.%I from wiser_data_api',table_name); execute format('grant select,insert on ingestion.%I to wiser_data_api',table_name); end if;
  end loop;
end $$;
