-- Validate references before normalization and use the indexed resource identity.
create or replace function platform_private.guard_resource_policy_version() returns trigger language plpgsql set search_path='' as $$
declare previous platform_private.resource_policy_versions; role_count integer; identity_key text;
begin
 -- Serialize publication for this project; concurrent writers cannot fork an identity/version chain.
 perform 1 from platform_private.resource_access_settings where project_id=new.project_id for update;
 select count(distinct r) into role_count from unnest(new.management_roles) r where r ~ '^[a-zA-Z0-9._:-]{1,96}$';
 if role_count<>cardinality(new.management_roles) then
  raise exception using errcode='23514',message='Invalid source-policy management roles.';
 end if;
 if not platform_private.valid_resource_references(jsonb_build_array(new.resource)) then
  raise exception using errcode='23514',message='Invalid source-policy resource reference.';
 end if;
 -- UUID resource spelling is canonical, avoiding a second identity for the same version.
 if new.resource->>'kind'='version' then
  new.resource := jsonb_build_object('kind','version','dataItemId',((new.resource->>'dataItemId')::uuid)::text,'versionId',((new.resource->>'versionId')::uuid)::text);
 end if;
 identity_key := case when new.resource->>'kind'='version' then 'v:'||(new.resource->>'dataItemId')||':'||(new.resource->>'versionId') else 's:'||(new.resource->>'sourceId') end;
 select * into previous from platform_private.resource_policy_versions
 where project_id=new.project_id and (policy_id=new.policy_id or resource_key=identity_key)
 order by version desc limit 1;
 if found then
  if previous.policy_id<>new.policy_id or previous.resource<>new.resource or new.version<>previous.version+1 then
   raise exception using errcode='23514',message='Source-policy identity and version chain must be preserved.';
  end if;
 elsif new.version<>1 then
  raise exception using errcode='23514',message='Source-policy history must begin at version one.';
 end if;
 return new;
end $$;
