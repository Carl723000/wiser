-- Existing timed delegations keep their deadline. Newly consented Agent
-- connections may persist while OAuth Session, consent and live access remain.
alter table platform.delegations alter column expires_at drop not null;
alter table platform.delegations drop constraint delegations_expiry_check;
alter table platform.delegations add constraint delegations_expiry_check check (
  (expires_at is not null and expires_at > created_at)
  or (expires_at is null and purpose = 'agent-data')
);

create or replace function platform_private.agent_access_token_hook(event jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  claims jsonb := event -> 'claims';
  connection record;
begin
  if not (claims ? 'client_id') then
    return event;
  end if;
  select c.resource, c.delegation_id into connection
  from platform_private.agent_connections c
  join platform.delegations d on d.id = c.delegation_id
  where c.owner_actor_id::text = event ->> 'user_id'
    and c.owner_actor_id::text = claims ->> 'sub'
    and c.oauth_client_id::text = claims ->> 'client_id'
    and d.status = 'active' and d.revoked_at is null
    and (d.expires_at is null or d.expires_at > statement_timestamp());
  if not found then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'Agent access is not authorized.'
    ));
  end if;
  claims := jsonb_set(claims, '{aud}', to_jsonb(connection.resource));
  claims := jsonb_set(claims, '{wiser_delegation_id}', to_jsonb(connection.delegation_id::text));
  return jsonb_set(event, '{claims}', claims);
end;
$$;
