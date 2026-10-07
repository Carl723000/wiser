-- Complete candidate topics reuse 0042 immutable rows. No source or identity grant.
create function service.candidate_topic_object(value jsonb, required text[], optional text[] default array[]::text[]) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  return value ?& required and not exists(select 1 from jsonb_object_keys(value) k where not(k=any(required||optional)));
exception when others then return false;
end $$;
create function service.candidate_topic_text(value jsonb, maximum integer) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare text_value text;
begin
  if jsonb_typeof(value) is distinct from 'string' then return false; end if;
  text_value:=value#>>'{}';
  -- Match contract UTF-16 length rather than letting supplementary characters
  -- evade a JavaScript character bound. The row's overall byte bound also applies.
  return length(btrim(text_value))>0 and coalesce((select sum(case when ascii(ch)>65535 then 2 else 1 end)
    from unnest(regexp_split_to_array(text_value,'')) ch),0) between 1 and maximum;
exception when others then return false;
end $$;
create function service.candidate_topic_identifiers(value jsonb, maximum integer) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if jsonb_typeof(value) is distinct from 'array' or jsonb_array_length(value) not between 1 and maximum then return false; end if;
  return not exists(select 1 from jsonb_array_elements(value) items(identifier) where not service.candidate_topic_text(items.identifier,128))
    and (select count(distinct items.identifier)=jsonb_array_length(value) from jsonb_array_elements(value) items(identifier));
exception when others then return false;
end $$;
create function service.candidate_topic_reference_key(ref jsonb) returns text
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if service.valid_candidate_view_reference(ref) is distinct from true then return null; end if;
  return lower(ref->>'ingestionId')||':'||lower(ref->>'processingBatchId')||':'||(ref->>'reviewHash');
end $$;
create function service.valid_candidate_topic_spec(spec jsonb, refs jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare period jsonb; topic jsonb; pin jsonb; member jsonb; asset jsonb; focus jsonb;
  window_mode text; key text; value text; y integer; m integer; d integer; last_day integer;
  ref_key text; pin_key text; asset_key text;
  rule_keys text[]:=array[]::text[]; rule_kinds text[]:=array[]::text[];
  record_keys text[]:=array[]::text[]; dependency_keys text[]:=array[]::text[]; relation_keys text[]:=array[]::text[];
  assets jsonb:='{}'; record_hashes jsonb:='{}'; records jsonb:='{}';
  uuid_pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if not service.candidate_topic_object(spec,array['schemaVersion','page','period','topic','rulePins','dependencyPins','relationPins'],array['focus','map'])
    or spec->'schemaVersion' is distinct from '2'::jsonb or octet_length(spec::text)>131072
    or service.valid_candidate_view_refs(refs) is distinct from true then return false; end if;
  -- Keep the original page/focus/map validator and exact v1 semantics intact.
  if service.valid_candidate_view_spec(spec-array['schemaVersion','period','topic','rulePins','dependencyPins','relationPins'],refs) is distinct from true then return false; end if;
  period:=spec->'period'; window_mode:=period->>'windowMode';
  if not service.candidate_topic_object(period,array['windowMode','from','to','displayUnit','timeRole','includeUndated'])
    or (window_mode in ('month','day')) is distinct from true
    or (period->>'timeRole' in ('PUBLICATION','OBSERVATION','EVENT','REPORT_PERIOD','UNKNOWN')) is distinct from true
    or jsonb_typeof(period->'includeUndated') is distinct from 'boolean'
    or (period->>'displayUnit' in ('month','year') or (window_mode='day' and period->>'displayUnit'='day')) is distinct from true then return false; end if;
  foreach key in array array['from','to'] loop
    if jsonb_typeof(period->key)='null' then continue; end if;
    value:=period->>key;
    if jsonb_typeof(period->key) is distinct from 'string' then return false; end if;
    if window_mode='month' then
      if value !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then return false; end if;
    else
      if value !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then return false; end if;
      y:=substring(value,1,4)::integer; m:=substring(value,6,2)::integer; d:=substring(value,9,2)::integer;
      last_day:=case when m=2 then case when y%4=0 and (y%100<>0 or y%400=0) then 29 else 28 end
        when m in (4,6,9,11) then 30 else 31 end;
      if d>last_day then return false; end if;
    end if;
  end loop;
  if period->>'from'>period->>'to' then return false; end if;
  topic:=spec->'topic';
  if not service.candidate_topic_object(topic,array['question','regionIds','needIds','recordPins'])
    or not service.candidate_topic_text(topic->'question',2000)
    or not service.candidate_topic_identifiers(topic->'regionIds',32)
    or not service.candidate_topic_identifiers(topic->'needIds',64)
    or jsonb_typeof(topic->'recordPins') is distinct from 'array'
    or jsonb_array_length(topic->'recordPins')>200 then return false; end if;
  for pin in select * from jsonb_array_elements(topic->'recordPins') loop
    if not service.candidate_topic_object(pin,array['reference','assetId','recordId'],array['sourceObjectKey'])
      or service.valid_candidate_view_reference(pin->'reference') is distinct from true
      or (pin->>'assetId' ~* uuid_pattern) is distinct from true or (pin->>'recordId' ~* uuid_pattern) is distinct from true
      or (pin ? 'sourceObjectKey' and not service.candidate_topic_text(pin->'sourceObjectKey',256)) then return false; end if;
    ref_key:=service.candidate_topic_reference_key(pin->'reference');
    if not exists(select 1 from jsonb_array_elements(refs) r where service.candidate_topic_reference_key(r)=ref_key) then return false; end if;
    pin_key:=ref_key||':'||lower(pin->>'assetId')||':'||lower(pin->>'recordId');
    if pin_key=any(record_keys) then return false; end if; record_keys:=array_append(record_keys,pin_key);
  end loop;
  if jsonb_typeof(spec->'rulePins') is distinct from 'array' or jsonb_array_length(spec->'rulePins') not between 4 and 32 then return false; end if;
  for pin in select * from jsonb_array_elements(spec->'rulePins') loop
    if not service.candidate_topic_object(pin,array['kind','ruleId','version'])
      or (pin->>'kind' in ('projection','readiness','requirement','impact')) is distinct from true
      or not service.candidate_topic_text(pin->'ruleId',128) or not service.candidate_topic_text(pin->'version',128) then return false; end if;
    pin_key:=(pin->>'kind')||':'||(pin->>'ruleId');
    if pin_key=any(rule_keys) then return false; end if;
    rule_keys:=array_append(rule_keys,pin_key); rule_kinds:=array_append(rule_kinds,pin->>'kind');
  end loop;
  if not (rule_kinds @> array['projection','readiness','requirement','impact']) then return false; end if;
  if jsonb_typeof(spec->'dependencyPins') is distinct from 'array' or jsonb_array_length(spec->'dependencyPins') not between 1 and 200 then return false; end if;
  -- Fix all selected assets first; array ordering has no authority meaning.
  for pin in select * from jsonb_array_elements(spec->'dependencyPins') loop
    if (pin->>'kind' in ('asset','record','geometry')) is distinct from true then return false; end if;
    if not service.candidate_topic_object(pin,array['kind','reference','assetId','sourceHash','parserVersion'] ||
       case pin->>'kind' when 'asset' then array[]::text[] when 'record' then array['recordId','recordHash'] else array['recordId','recordHash','geometryHash'] end)
      or service.valid_candidate_view_reference(pin->'reference') is distinct from true
      or (pin->>'assetId' ~* uuid_pattern) is distinct from true
      or (pin->>'sourceHash' ~ '^[a-f0-9]{64}$') is distinct from true
      or not service.candidate_topic_text(pin->'parserVersion',128) then return false; end if;
    ref_key:=service.candidate_topic_reference_key(pin->'reference');
    if not exists(select 1 from jsonb_array_elements(refs) r where service.candidate_topic_reference_key(r)=ref_key) then return false; end if;
    asset_key:=ref_key||':'||lower(pin->>'assetId');
    if pin->>'kind'='asset' then
      pin_key:='asset:'||asset_key;
      assets:=jsonb_set(assets,array[asset_key],pin,true);
    else
      if (pin->>'recordId' ~* uuid_pattern) is distinct from true or (pin->>'recordHash' ~ '^[a-f0-9]{64}$') is distinct from true
        or (pin->>'kind'='geometry' and (pin->>'geometryHash' ~ '^[a-f0-9]{64}$') is distinct from true) then return false; end if;
      pin_key:=(pin->>'kind')||':'||asset_key||':'||lower(pin->>'recordId');
    end if;
    if pin_key=any(dependency_keys) then return false; end if; dependency_keys:=array_append(dependency_keys,pin_key);
  end loop;
  for pin in select * from jsonb_array_elements(spec->'dependencyPins') loop
    asset_key:=service.candidate_topic_reference_key(pin->'reference')||':'||lower(pin->>'assetId'); asset:=assets->asset_key;
    if asset is null or asset->'sourceHash' is distinct from pin->'sourceHash' or asset->'parserVersion' is distinct from pin->'parserVersion' then return false; end if;
    if pin->>'kind'<>'asset' then
      pin_key:=asset_key||':'||lower(pin->>'recordId');
      if not(pin_key=any(record_keys)) or (record_hashes ? pin_key and record_hashes->>pin_key is distinct from pin->>'recordHash') then return false; end if;
      record_hashes:=jsonb_set(record_hashes,array[pin_key],pin->'recordHash',true); records:=jsonb_set(records,array[pin_key],'true',true);
    end if;
  end loop;
  foreach pin_key in array record_keys loop if not(records ? pin_key) then return false; end if; end loop;
  member:=spec->'page'; ref_key:=service.candidate_topic_reference_key(member->'reference');
  if member->>'kind'='assets' then
    if not exists(select 1 from jsonb_each(assets) a where service.candidate_topic_reference_key(a.value->'reference')=ref_key) then return false; end if;
  elsif not(assets ? (ref_key||':'||lower(member->>'assetId'))) then return false; end if;
  if spec ? 'focus' then
    focus:=spec->'focus'; asset_key:=service.candidate_topic_reference_key(focus->'reference')||':'||lower(focus->>'assetId');
    if not(assets ? asset_key) or (focus ? 'recordId' and not ((asset_key||':'||lower(focus->>'recordId'))=any(record_keys))) then return false; end if;
  end if;
  if jsonb_typeof(spec->'relationPins') is distinct from 'array' or jsonb_array_length(spec->'relationPins')>100 then return false; end if;
  for pin in select * from jsonb_array_elements(spec->'relationPins') loop
    if not service.candidate_topic_object(pin,array['relationId','revision','decisionVersion'])
      or (pin->>'relationId' ~* uuid_pattern) is distinct from true
      or jsonb_typeof(pin->'revision') is distinct from 'number' or (pin->>'revision') !~ '^[0-9]+$'
      or (pin->>'revision')::numeric not between 1 and 9007199254740991
      or jsonb_typeof(pin->'decisionVersion') is distinct from 'number' or (pin->>'decisionVersion') !~ '^[0-9]+$'
      or (pin->>'decisionVersion')::numeric not between 0 and 9007199254740991 then return false; end if;
    key:=lower(pin->>'relationId'); if key=any(relation_keys) then return false; end if; relation_keys:=array_append(relation_keys,key);
  end loop;
  return true;
exception when others then return false;
end $$;
create function service.valid_candidate_saved_spec_version(spec jsonb, refs jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if not(spec ? 'schemaVersion') then return service.valid_candidate_view_spec(spec,refs); end if;
  if spec->'schemaVersion'='2'::jsonb then return service.valid_candidate_topic_spec(spec,refs); end if;
  return false;
exception when others then return false;
end $$;
alter table service.ingestion_candidate_saved_view drop constraint ingestion_candidate_saved_view_check;
alter table service.ingestion_candidate_saved_view add constraint candidate_saved_spec_version_check
  check(service.valid_candidate_saved_spec_version(view_spec,candidate_refs));

-- Historical selection is installed from this exact immutable saved row only,
-- then all candidate sources still pass their current forced RLS (0045).
create function service.candidate_topic_saved_refs_readable(refs jsonb) returns boolean
language plpgsql volatile set search_path=pg_catalog as $$
declare previous text:=coalesce(current_setting('wiser.candidate_fixed_refs',true),''); result boolean;
begin
  if not service.candidate_saved_authority_live() or service.valid_candidate_view_refs(refs) is distinct from true then return false; end if;
  perform set_config('wiser.candidate_fixed_refs',refs::text,true);
  result:=service.candidate_saved_refs_readable(refs);
  perform set_config('wiser.candidate_fixed_refs',previous,true);
  return coalesce(result,false);
exception when others then
  perform set_config('wiser.candidate_fixed_refs',previous,true);
  return false;
end $$;
drop policy candidate_saved_read on service.ingestion_candidate_saved_view;
create policy candidate_saved_read on service.ingestion_candidate_saved_view for select using (
  security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true)
  and case when view_spec->'schemaVersion'='2'::jsonb then service.candidate_topic_saved_refs_readable(candidate_refs)
    else service.candidate_saved_refs_readable(candidate_refs) end
  and (service.candidate_saved_owner(actor_id,actor_type,delegated_by) or (visibility='project' and revoked_at is null))
);
-- Existing limited metadata role sees a receipt ID only, never the hidden title,
-- references, rule pins, text, coordinates or storage keys. No BYPASS/definer.
create function service.candidate_topic_receipt_authority_live() returns boolean
language plpgsql volatile set search_path=pg_catalog as $$
declare actor_type text:=current_setting('wiser.actor_type',true);
  delegate text:=nullif(current_setting('wiser.delegated_by',true),'');
  deadline text:=nullif(current_setting('wiser.candidate_view_deadline',true),'');
  resource_scope text:=nullif(current_setting('wiser.resource_scope',true),''); resource jsonb;
begin
  if current_user<>'wiser_data_metadata'
    or nullif(current_setting('wiser.actor_id',true),'') is null
    or nullif(current_setting('wiser.purpose',true),'') is null
    or current_setting('wiser.purpose',true) is distinct from current_setting('wiser.candidate_purpose',true)
    or deadline is null or deadline::timestamptz<=clock_timestamp()
    or actor_type is null or not ((actor_type='human' and delegate is null)
      or (actor_type in ('agent','service') and delegate is not null))
    or (current_setting('wiser.candidate_maintainer',true)='true'
      or (current_setting('wiser.candidate_reviewer',true)='true' and actor_type='human' and delegate is null)) is distinct from true then return false; end if;
  if resource_scope is not null then
    resource:=resource_scope::jsonb;
    if resource->>'mode' is distinct from 'managed' or jsonb_typeof(resource->'permissions') is distinct from 'object'
      or (jsonb_typeof(resource->'validUntil') is distinct from 'null'
        and ((resource->>'validUntil') is null or (resource->>'validUntil')::timestamptz<=clock_timestamp())) then return false; end if;
  end if;
  return true;
exception when others then return false;
end $$;
create policy candidate_topic_owner_receipt on service.ingestion_candidate_saved_view for select using (
  service.candidate_topic_receipt_authority_live()
  and security.authorized_row(tenant_id,project_id,security_level,policy_version)
  and purpose=current_setting('wiser.purpose',true) and revoked_at is null
  and view_id::text=current_setting('wiser.candidate_topic_receipt_id',true)
  and view_spec->'schemaVersion'='2'::jsonb
  and service.candidate_saved_owner(actor_id,actor_type,delegated_by)
);
revoke all on function service.candidate_topic_object(jsonb,text[],text[]),service.candidate_topic_text(jsonb,integer),
 service.candidate_topic_identifiers(jsonb,integer),service.candidate_topic_reference_key(jsonb),
 service.valid_candidate_topic_spec(jsonb,jsonb),service.valid_candidate_saved_spec_version(jsonb,jsonb),
 service.candidate_topic_saved_refs_readable(jsonb),service.candidate_topic_receipt_authority_live() from public;
-- The checksummed runner applies provisioning after all migrations.
