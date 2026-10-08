-- Private technical followups. Original evidence and creation responsibility are
-- immutable; only append-only events derive the current snapshot. CLOSED never
-- approves a professional fact, publishes a source, or grants material access.
create function ingestion.valid_candidate_followup_actor(value jsonb) returns boolean
language sql immutable security invoker set search_path=pg_catalog as $$
  select coalesce(ingestion.candidate_relation_keys(value,array['actorId','actorType','delegatedBy'],array['purpose'])
    and (value->>'actorId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and ((value->>'actorType'='human' and value->'delegatedBy'='null'::jsonb)
      or (value->>'actorType' in ('agent','service')
        and (value->>'delegatedBy') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    and (not value ? 'purpose' or (length(value->>'purpose') between 1 and 96 and value->>'purpose' ~ '^[a-z][a-z0-9-]*$')),false);
$$;

create function ingestion.valid_candidate_followup_evidence(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
  if not ingestion.candidate_relation_keys(value,array['reference','assetId','sourceHash','locator'],array['recordId','geometry','sourceCrs'])
    or service.valid_candidate_view_reference(value->'reference') is distinct from true
    or (value->>'assetId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') is distinct from true
    or (value->>'sourceHash' ~ '^[a-f0-9]{64}$') is distinct from true
    or not ingestion.candidate_relation_text(value->'locator',1024)
    or octet_length(value::text)>1048576 then return false; end if;
  if value ? 'recordId' and (value->>'recordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') is distinct from true then return false; end if;
  if (value ? 'geometry')<>(value ? 'sourceCrs') then return false; end if;
  if value ? 'geometry' and (not value ? 'recordId'
    or jsonb_typeof(value->'geometry') is distinct from 'object'
    or not ingestion.candidate_relation_text(value->'sourceCrs',128)) then return false; end if;
  if not value ? 'recordId' and value->>'locator' is distinct from 'asset:'||lower(value->>'assetId') then return false; end if;
  return true;
exception when others then return false;
end $$;

create function ingestion.valid_candidate_followup_evidence_list(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
  return coalesce(jsonb_typeof(value)='array' and jsonb_array_length(value)<=64
    and octet_length(value::text)<=2097152
    and not exists(select 1 from jsonb_array_elements(value) evidence
      where ingestion.valid_candidate_followup_evidence(evidence) is distinct from true),false);
exception when others then return false;
end $$;

create function ingestion.valid_candidate_followup_correction(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
  return coalesce(ingestion.candidate_relation_keys(value,array['old','new','mappingReason','scope'])
    and value->>'scope'='WHOLE_RECORD'
    and ingestion.valid_candidate_followup_evidence(value->'old')
    and ingestion.valid_candidate_followup_evidence(value->'new')
    and value->'old' ?& array['recordId','geometry','sourceCrs'] and value->'new' ?& array['recordId','geometry','sourceCrs']
    and value->'old' is distinct from value->'new'
    and ingestion.candidate_relation_text(value->'mappingReason',4096),false);
exception when others then return false;
end $$;

-- Invoker-only and nonrecursive: read current candidate/source RLS, never the
-- followup/event tables. Fixed selections narrow historical reads, not grants.
create function ingestion.candidate_followup_sources_readable(requested_tenant uuid, requested_project uuid, sources jsonb) returns boolean
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
              and public.st_asgeojson(record.geom,15)::jsonb=evidence->'geometry'
              and record.source_crs=evidence->>'sourceCrs'))))) into found_source;
    if not found_source then
      perform set_config('wiser.candidate_fixed_refs',previous,true); return false;
    end if;
  end loop;
  perform set_config('wiser.candidate_fixed_refs',previous,true); return true;
exception when others then
  perform set_config('wiser.candidate_fixed_refs',previous,true); return false;
end $$;

-- A target snapshot is supplied only by the trusted Auth adapter, after current
-- membership/delegation/resource verification. It supplies no new permission.
-- Recheck actual candidate RLS in that exact context and restore every setting.
create function ingestion.candidate_followup_target_live(requested_tenant uuid, requested_project uuid, target jsonb, sources jsonb) returns boolean
language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare context jsonb; key text; old_settings jsonb:='{}'::jsonb; result boolean:=false;
  keys text[]:=array['actor_id','actor_type','delegated_by','purpose','candidate_purpose','candidate_view_deadline','candidate_maintainer','candidate_reviewer','max_security_level','policy_version','resource_scope'];
begin
  context:=nullif(current_setting('wiser.candidate_followup_target_context',true),'')::jsonb;
  if ingestion.valid_candidate_followup_actor(target) is distinct from true
    or ingestion.candidate_relation_keys(context,array['actorId','actorType','delegatedBy','purpose','deadline','maxSecurityLevel','policyVersion','maintainer','reviewer','resourceScope']) is distinct from true
    or target is distinct from jsonb_build_object('actorId',context->'actorId','actorType',context->'actorType','delegatedBy',context->'delegatedBy','purpose',context->'purpose')
    or context->'maintainer' is distinct from 'true'::jsonb or jsonb_typeof(context->'reviewer') is distinct from 'boolean'
    or context->>'purpose' is distinct from current_setting('wiser.purpose',true)
    or (context->>'deadline')::timestamptz<=clock_timestamp()
    or security.is_valid_security_level(context->>'maxSecurityLevel') is distinct from true
    or jsonb_typeof(context->'policyVersion') is distinct from 'number' or (context->>'policyVersion') !~ '^[1-9][0-9]*$'
    or jsonb_typeof(context->'resourceScope') not in ('null','object') then return false; end if;
  foreach key in array keys loop old_settings:=old_settings||jsonb_build_object(key,coalesce(current_setting('wiser.'||key,true),'')); end loop;
  perform set_config('wiser.actor_id',context->>'actorId',true),set_config('wiser.actor_type',context->>'actorType',true),
    set_config('wiser.delegated_by',coalesce(context->>'delegatedBy',''),true),set_config('wiser.purpose',context->>'purpose',true),
    set_config('wiser.candidate_purpose',context->>'purpose',true),set_config('wiser.candidate_view_deadline',context->>'deadline',true),
    set_config('wiser.candidate_maintainer','true',true),set_config('wiser.candidate_reviewer',context->>'reviewer',true),
    set_config('wiser.max_security_level',context->>'maxSecurityLevel',true),set_config('wiser.policy_version',context->>'policyVersion',true),
    set_config('wiser.resource_scope',case when context->'resourceScope'='null'::jsonb then '' else (context->'resourceScope')::text end,true);
  result:=ingestion.candidate_followup_sources_readable(requested_tenant,requested_project,sources);
  foreach key in array keys loop perform set_config('wiser.'||key,old_settings->>key,true); end loop;
  return coalesce(result,false);
exception when others then
  foreach key in array keys loop
    if old_settings ? key then perform set_config('wiser.'||key,old_settings->>key,true); end if;
  end loop;
  return false;
end $$;

create table ingestion.candidate_followup (
  followup_id uuid primary key, tenant_id uuid not null, project_id uuid not null,
  type text not null check(type in ('GAP','CORRECTION')),
  source jsonb not null check(ingestion.valid_candidate_followup_evidence(source)),
  ingestion_id uuid generated always as ((source#>>'{reference,ingestionId}')::uuid) stored,
  processing_batch_id uuid generated always as ((source#>>'{reference,processingBatchId}')::uuid) stored,
  asset_id uuid generated always as ((source->>'assetId')::uuid) stored,
  record_id uuid generated always as ((source->>'recordId')::uuid) stored,
  rule_id text not null check(length(btrim(rule_id)) between 1 and 128),
  rule_version text not null check(length(btrim(rule_version)) between 1 and 128),
  reason text not null check(length(btrim(reason)) between 1 and 4096),
  created_by_actor_id uuid not null, created_actor_type text not null check(created_actor_type in ('human','agent','service')),
  created_delegated_by uuid,
  purpose text not null check(length(purpose) between 1 and 96 and purpose ~ '^[a-z][a-z0-9-]*$'),
  security_level text not null check(security.is_valid_security_level(security_level)), policy_version bigint not null check(policy_version>0),
  state text not null default 'OPEN' check(state in ('OPEN','WORKING','REVIEW_PENDING','CLOSED')),
  row_version integer not null default 0 check(row_version between 0 and 200),
  assignee jsonb check(assignee is null or (ingestion.valid_candidate_followup_actor(assignee) and assignee->>'purpose'=purpose)),
  evidence jsonb not null default '[]'::jsonb check(ingestion.valid_candidate_followup_evidence_list(evidence)),
  responsibilities jsonb not null default '[]'::jsonb check(jsonb_typeof(responsibilities)='array' and jsonb_array_length(responsibilities)<=1000 and octet_length(responsibilities::text)<=2097152),
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,project_id,followup_id),
  foreign key(tenant_id,project_id,ingestion_id) references ingestion.session(tenant_id,project_id,ingestion_id),
  foreign key(tenant_id,project_id,processing_batch_id,asset_id) references ingestion.candidate_asset(tenant_id,project_id,processing_batch_id,asset_id),
  foreign key(processing_batch_id,record_id) references ingestion.candidate_record(processing_batch_id,record_id),
  check((created_actor_type='human' and created_delegated_by is null) or (created_actor_type in ('agent','service') and created_delegated_by is not null)),
  check(type<>'CORRECTION' or source ?& array['recordId','geometry','sourceCrs'])
);
create index candidate_followup_scope on ingestion.candidate_followup(tenant_id,project_id,purpose,created_at desc,followup_id desc);

create table ingestion.candidate_followup_event (
  event_id uuid primary key, tenant_id uuid not null, project_id uuid not null, followup_id uuid not null,
  expected_version integer not null check(expected_version between 0 and 199), row_version integer not null check(row_version between 1 and 200),
  action text not null check(action in ('CREATE','CLAIM','HANDOFF','SUPPLEMENT','SUBMIT_REVIEW','CLOSE','RETURN','REOPEN')),
  actor_id uuid not null, actor_type text not null check(actor_type in ('human','agent','service')), delegated_by uuid,
  purpose text not null check(length(purpose) between 1 and 96 and purpose ~ '^[a-z][a-z0-9-]*$'),
  target jsonb check(target is null or ingestion.valid_candidate_followup_actor(target)),
  evidence jsonb not null default '[]'::jsonb check(ingestion.valid_candidate_followup_evidence_list(evidence)),
  correction jsonb check(correction is null or ingestion.valid_candidate_followup_correction(correction)),
  note text not null check(length(btrim(note)) between 1 and 4096),
  idempotency_key text not null check(length(idempotency_key) between 1 and 160),
  request_fingerprint bytea not null check(octet_length(request_fingerprint)=32),
  state_after text not null check(state_after in ('OPEN','WORKING','REVIEW_PENDING','CLOSED')),
  assignee_after jsonb check(assignee_after is null or ingestion.valid_candidate_followup_actor(assignee_after)),
  evidence_after jsonb not null check(ingestion.valid_candidate_followup_evidence_list(evidence_after)),
  responsibilities_after jsonb not null check(jsonb_typeof(responsibilities_after)='array' and octet_length(responsibilities_after::text)<=2097152),
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,project_id,followup_id,row_version),
  unique(tenant_id,project_id,followup_id,idempotency_key),
  foreign key(tenant_id,project_id,followup_id) references ingestion.candidate_followup(tenant_id,project_id,followup_id),
  check(row_version=expected_version+1),
  check((actor_type='human' and delegated_by is null) or (actor_type in ('agent','service') and delegated_by is not null))
);

create function ingestion.guard_candidate_followup_root() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare appended ingestion.candidate_followup_event%rowtype; source_batch ingestion.candidate_batch%rowtype;
  previous_refs text:=coalesce(current_setting('wiser.candidate_fixed_refs',true),'');
begin
  if tg_op='INSERT' then
    if not service.candidate_saved_authority_live() or current_setting('wiser.candidate_maintainer',true) is distinct from 'true'
      or not ingestion.candidate_followup_sources_readable(new.tenant_id,new.project_id,jsonb_build_array(new.source))
      or row(new.created_by_actor_id,new.created_actor_type,new.created_delegated_by,new.purpose) is distinct from
        row(nullif(current_setting('wiser.actor_id',true),'')::uuid,current_setting('wiser.actor_type',true),nullif(current_setting('wiser.delegated_by',true),'')::uuid,current_setting('wiser.purpose',true))
      or new.state<>'OPEN' or new.row_version<>0 or new.assignee is not null or new.evidence<>'[]'::jsonb or new.responsibilities<>'[]'::jsonb then
      raise exception 'candidate followup requires exact trusted creation and source authority' using errcode='42501'; end if;
    perform set_config('wiser.candidate_fixed_refs',jsonb_build_array(new.source->'reference')::text,true);
    select * into source_batch from ingestion.candidate_batch where tenant_id=new.tenant_id and project_id=new.project_id
      and processing_batch_id=(new.source#>>'{reference,processingBatchId}')::uuid;
    perform set_config('wiser.candidate_fixed_refs',previous_refs,true);
    if source_batch.processing_batch_id is null or row(new.security_level,new.policy_version) is distinct from row(source_batch.security_level,source_batch.policy_version) then
      raise exception 'candidate followup source policy does not match' using errcode='42501'; end if;
    new.created_at:=clock_timestamp(); return new;
  end if;
  if tg_op<>'UPDATE' or pg_trigger_depth()<=1 then
    raise exception 'candidate followup roots may only be derived by an appended event' using errcode='42501'; end if;
  if row(new.followup_id,new.tenant_id,new.project_id,new.type,new.source,new.rule_id,new.rule_version,new.reason,
      new.created_by_actor_id,new.created_actor_type,new.created_delegated_by,new.purpose,new.security_level,new.policy_version,new.created_at) is distinct from
    row(old.followup_id,old.tenant_id,old.project_id,old.type,old.source,old.rule_id,old.rule_version,old.reason,
      old.created_by_actor_id,old.created_actor_type,old.created_delegated_by,old.purpose,old.security_level,old.policy_version,old.created_at)
    or new.row_version<>old.row_version+1 then
    raise exception 'candidate followup original evidence and creation responsibility are immutable' using errcode='42501'; end if;
  select * into appended from ingestion.candidate_followup_event event
    where event.tenant_id=new.tenant_id and event.project_id=new.project_id and event.followup_id=new.followup_id and event.row_version=new.row_version;
  if not found or appended.expected_version<>old.row_version
    or row(new.state,new.assignee,new.evidence,new.responsibilities) is distinct from
      row(appended.state_after,appended.assignee_after,appended.evidence_after,appended.responsibilities_after)
    or not ingestion.candidate_followup_sources_readable(new.tenant_id,new.project_id,jsonb_build_array(new.source)||new.evidence) then
    raise exception 'candidate followup current snapshot does not match its exact appended event' using errcode='42501'; end if;
  return new;
end $$;
create trigger candidate_followup_root_guard before insert or update or delete on ingestion.candidate_followup
  for each row execute function ingestion.guard_candidate_followup_root();

create function ingestion.guard_candidate_followup_event() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare root ingestion.candidate_followup%rowtype; prior ingestion.candidate_followup_event%rowtype;
  current_actor jsonb; source jsonb; source_owner record; refs jsonb;
  previous_refs text:=coalesce(current_setting('wiser.candidate_fixed_refs',true),'');
begin
  if tg_op<>'INSERT' then raise exception 'candidate followup events are append-only' using errcode='42501'; end if;
  if not service.candidate_saved_authority_live()
    or row(new.actor_id,new.actor_type,new.delegated_by,new.purpose) is distinct from
      row(nullif(current_setting('wiser.actor_id',true),'')::uuid,current_setting('wiser.actor_type',true),nullif(current_setting('wiser.delegated_by',true),'')::uuid,current_setting('wiser.purpose',true)) then
    raise exception 'candidate followup event requires exact trusted current authority' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text||':'||new.project_id::text||':'||new.followup_id::text,0));
  select * into root from ingestion.candidate_followup where tenant_id=new.tenant_id and project_id=new.project_id and followup_id=new.followup_id;
  if not found or root.purpose<>new.purpose then raise exception 'candidate followup sources are unavailable' using errcode='42501'; end if;
  if ingestion.valid_candidate_followup_evidence_list(new.evidence) is distinct from true
    or not ingestion.candidate_followup_sources_readable(root.tenant_id,root.project_id,jsonb_build_array(root.source)||root.evidence||new.evidence) then
    raise exception 'candidate followup event requires every current source' using errcode='42501'; end if;
  select * into prior from ingestion.candidate_followup_event where tenant_id=new.tenant_id and project_id=new.project_id
    and followup_id=new.followup_id and idempotency_key=new.idempotency_key;
  if found then
    if row(prior.actor_id,prior.actor_type,prior.delegated_by,prior.purpose,prior.request_fingerprint) is distinct from
      row(new.actor_id,new.actor_type,new.delegated_by,new.purpose,new.request_fingerprint) then
      raise exception 'candidate followup idempotency responsibility conflict' using errcode='42501'; end if;
    raise exception 'candidate followup event already exists' using errcode='40001';
  end if;
  if new.expected_version<>root.row_version or new.row_version<>root.row_version+1 then
    raise exception 'candidate followup version conflict' using errcode='40001'; end if;
  current_actor:=jsonb_build_object('actorId',new.actor_id,'actorType',new.actor_type,'delegatedBy',new.delegated_by,'purpose',new.purpose);
  new.state_after:=root.state; new.assignee_after:=root.assignee; new.evidence_after:=root.evidence;
  new.responsibilities_after:=root.responsibilities;
  if new.action in ('CLOSE','RETURN') then
    if root.state<>'REVIEW_PENDING' or new.actor_type<>'human' or new.delegated_by is not null
      or current_setting('wiser.candidate_reviewer',true) is distinct from 'true'
      or jsonb_array_length(root.responsibilities)=0
      or exists(select 1 from jsonb_array_elements(root.responsibilities) responsibility
        where responsibility->>'actorId'=new.actor_id::text or responsibility->>'delegatedBy'=new.actor_id::text) then
      raise exception 'candidate followup review requires a non-delegated independent human excluding all historical responsibilities' using errcode='42501'; end if;
    new.state_after:=case when new.action='CLOSE' then 'CLOSED' else 'WORKING' end;
  else
    if current_setting('wiser.candidate_maintainer',true) is distinct from 'true' then
      raise exception 'candidate followup action requires current maintenance authority' using errcode='42501'; end if;
    if new.action='CREATE' then
      if root.row_version<>0 or root.state<>'OPEN' or current_actor is distinct from
        jsonb_build_object('actorId',root.created_by_actor_id,'actorType',root.created_actor_type,'delegatedBy',root.created_delegated_by,'purpose',root.purpose) then
        raise exception 'candidate followup CREATE requires exact immutable creation responsibility' using errcode='42501'; end if;
    elsif new.action='CLAIM' then
      if root.state<>'OPEN' then raise exception 'candidate followup CLAIM requires OPEN' using errcode='42501'; end if;
      new.state_after:='WORKING'; new.assignee_after:=current_actor;
    elsif new.action='REOPEN' then
      if root.state<>'CLOSED' or not (service.candidate_saved_owner(root.created_by_actor_id,root.created_actor_type,root.created_delegated_by)
        or (root.assignee is not null and service.candidate_saved_owner((root.assignee->>'actorId')::uuid,root.assignee->>'actorType',(root.assignee->>'delegatedBy')::uuid))) then
        raise exception 'candidate followup REOPEN requires CLOSED and existing responsibility' using errcode='42501'; end if;
      new.state_after:='OPEN'; new.assignee_after:=null;
    else
      if root.state<>'WORKING' or root.assignee is null or root.assignee is distinct from current_actor then
        raise exception 'candidate followup action requires the current responsible assignee' using errcode='42501'; end if;
      if new.action='HANDOFF' then
        if not ingestion.candidate_followup_target_live(root.tenant_id,root.project_id,new.target,jsonb_build_array(root.source)||root.evidence)
          or new.target=root.assignee then raise exception 'candidate followup HANDOFF target must already have current source and maintenance authority' using errcode='42501'; end if;
        new.assignee_after:=new.target;
      elsif new.action='SUPPLEMENT' then
        if jsonb_array_length(new.evidence)=0 then raise exception 'candidate followup SUPPLEMENT requires received candidate evidence' using errcode='42501'; end if;
        if (select count(distinct evidence) from jsonb_array_elements(new.evidence) evidence)<>jsonb_array_length(new.evidence)
          or exists(select 1 from jsonb_array_elements(new.evidence) added
            join jsonb_array_elements(jsonb_build_array(root.source)||root.evidence) existing on added=existing) then
          raise exception 'candidate followup supplemental evidence must be new and nonduplicate' using errcode='42501'; end if;
        new.evidence_after:=root.evidence||new.evidence;
        if root.type='CORRECTION' then
          if new.correction is null or ingestion.valid_candidate_followup_correction(new.correction) is distinct from true
            or not exists(select 1 from jsonb_array_elements(jsonb_build_array(root.source)||root.evidence) evidence where evidence=new.correction->'old')
            or not exists(select 1 from jsonb_array_elements(new.evidence) evidence where evidence=new.correction->'new') then
            raise exception 'candidate followup correction requires exact old and new whole-record evidence' using errcode='42501'; end if;
        elsif new.correction is not null then
          raise exception 'candidate followup GAP cannot imply a correction' using errcode='42501';
        end if;
      elsif new.action='SUBMIT_REVIEW' then
        if jsonb_array_length(root.evidence)=0 then raise exception 'candidate followup SUBMIT_REVIEW requires supplemental evidence' using errcode='42501'; end if;
        if root.type='CORRECTION' and not exists(select 1 from ingestion.candidate_followup_event event where event.tenant_id=root.tenant_id
          and event.project_id=root.project_id and event.followup_id=root.followup_id and event.action='SUPPLEMENT' and event.correction is not null) then
          raise exception 'candidate correction review requires an explicit whole-record mapping' using errcode='42501'; end if;
        new.state_after:='REVIEW_PENDING';
      else raise exception 'candidate followup action is unsupported' using errcode='42501'; end if;
    end if;
    new.responsibilities_after:=root.responsibilities||jsonb_build_array(current_actor);
    if new.action='HANDOFF' then
      new.responsibilities_after:=new.responsibilities_after||jsonb_build_array(new.target);
    end if;
    -- Actual immutable source submission responsibility joins the same RLS-
    -- checked candidate rows. An owner with review/publish also cannot self-review.
    select jsonb_agg(reference) into refs from (select distinct evidence->'reference' reference
      from jsonb_array_elements(jsonb_build_array(root.source)||root.evidence||new.evidence) evidence) selected;
    perform set_config('wiser.candidate_fixed_refs',refs::text,true);
    for source in select value from jsonb_array_elements(case when new.action='CREATE' then jsonb_build_array(root.source) else new.evidence end) loop
      select s.submitted_by_actor_id actor_id,s.submitted_actor_type actor_type,s.submitted_delegator_actor_id delegated_by into source_owner
        from ingestion.candidate_batch b join ingestion.session s on s.tenant_id=b.tenant_id and s.project_id=b.project_id and s.ingestion_id=b.ingestion_id
        where b.tenant_id=root.tenant_id and b.project_id=root.project_id
          and b.ingestion_id=(source#>>'{reference,ingestionId}')::uuid and b.processing_batch_id=(source#>>'{reference,processingBatchId}')::uuid
          and b.review_hash=decode(source#>>'{reference,reviewHash}','hex');
      if not found or source_owner.actor_id is null or source_owner.actor_type not in ('human','agent','service')
        or (source_owner.actor_type in ('agent','service') and source_owner.delegated_by is null) then
        raise exception 'candidate followup source responsibility is unknown' using errcode='42501'; end if;
      new.responsibilities_after:=new.responsibilities_after||jsonb_build_array(jsonb_build_object(
        'actorId',source_owner.actor_id,'actorType',source_owner.actor_type,'delegatedBy',source_owner.delegated_by));
    end loop;
    perform set_config('wiser.candidate_fixed_refs',previous_refs,true);
  end if;
  if (new.action<>'HANDOFF' and new.target is not null)
    or (new.action<>'SUPPLEMENT' and (new.evidence<>'[]'::jsonb or new.correction is not null)) then
    raise exception 'candidate followup action payload does not match its discriminator' using errcode='42501'; end if;
  if ingestion.valid_candidate_followup_evidence_list(new.evidence_after) is distinct from true then
    raise exception 'candidate followup evidence bounds exceeded' using errcode='42501'; end if;
  new.created_at:=clock_timestamp(); return new;
end $$;
create trigger candidate_followup_event_guard before insert or update or delete on ingestion.candidate_followup_event
  for each row execute function ingestion.guard_candidate_followup_event();

create function ingestion.apply_candidate_followup_event() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  update ingestion.candidate_followup set state=new.state_after,row_version=new.row_version,
    assignee=new.assignee_after,evidence=new.evidence_after,responsibilities=new.responsibilities_after
    where tenant_id=new.tenant_id and project_id=new.project_id and followup_id=new.followup_id and row_version=new.expected_version;
  if not found then raise exception 'candidate followup projection version conflict' using errcode='40001'; end if;
  return null;
end $$;
create trigger candidate_followup_event_applied after insert on ingestion.candidate_followup_event
  for each row execute function ingestion.apply_candidate_followup_event();

create function ingestion.candidate_followup_creation_complete() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if not exists(select 1 from ingestion.candidate_followup root where root.tenant_id=new.tenant_id and root.project_id=new.project_id
    and root.followup_id=new.followup_id and root.row_version>=1
    and exists(select 1 from ingestion.candidate_followup_event event where event.tenant_id=root.tenant_id and event.project_id=root.project_id
      and event.followup_id=root.followup_id and event.row_version=1 and event.expected_version=0 and event.action='CREATE')) then
    raise exception 'candidate followup requires a CREATE event' using errcode='42501'; end if;
  return null;
end $$;
create constraint trigger candidate_followup_creation_complete after insert on ingestion.candidate_followup
  deferrable initially deferred for each row execute function ingestion.candidate_followup_creation_complete();

alter table ingestion.candidate_followup enable row level security;
alter table ingestion.candidate_followup force row level security;
create policy candidate_followup_read on ingestion.candidate_followup for select using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true)
  and ingestion.candidate_followup_sources_readable(tenant_id,project_id,jsonb_build_array(source)||evidence));
create policy candidate_followup_insert on ingestion.candidate_followup for insert with check (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true) and current_setting('wiser.candidate_maintainer',true)='true'
  and ingestion.candidate_followup_sources_readable(tenant_id,project_id,jsonb_build_array(source)));
create policy candidate_followup_derive on ingestion.candidate_followup for update using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true)
  and ingestion.candidate_followup_sources_readable(tenant_id,project_id,jsonb_build_array(source)||evidence)) with check (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true)
  and ingestion.candidate_followup_sources_readable(tenant_id,project_id,jsonb_build_array(source)||evidence));
alter table ingestion.candidate_followup_event enable row level security;
alter table ingestion.candidate_followup_event force row level security;
create policy candidate_followup_event_read on ingestion.candidate_followup_event for select using (
  exists(select 1 from ingestion.candidate_followup root where root.tenant_id=candidate_followup_event.tenant_id
    and root.project_id=candidate_followup_event.project_id and root.followup_id=candidate_followup_event.followup_id));
create policy candidate_followup_event_insert on ingestion.candidate_followup_event for insert with check (
  service.candidate_saved_authority_live() and purpose=current_setting('wiser.purpose',true)
  and exists(select 1 from ingestion.candidate_followup root where root.tenant_id=candidate_followup_event.tenant_id
    and root.project_id=candidate_followup_event.project_id and root.followup_id=candidate_followup_event.followup_id)
  and (evidence='[]'::jsonb or ingestion.candidate_followup_sources_readable(tenant_id,project_id,evidence)));

revoke all on ingestion.candidate_followup,ingestion.candidate_followup_event from public;
revoke all on function ingestion.valid_candidate_followup_actor(jsonb),ingestion.valid_candidate_followup_evidence(jsonb),
  ingestion.valid_candidate_followup_evidence_list(jsonb),ingestion.valid_candidate_followup_correction(jsonb),
  ingestion.candidate_followup_sources_readable(uuid,uuid,jsonb),ingestion.candidate_followup_target_live(uuid,uuid,jsonb,jsonb),
  ingestion.guard_candidate_followup_root(),ingestion.guard_candidate_followup_event(),
  ingestion.apply_candidate_followup_event(),ingestion.candidate_followup_creation_complete() from public;
-- The checked-sum runner reapplies precise role provisioning after migrations.
