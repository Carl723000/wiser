begin;

select plan(9);

select has_table('platform_private', 'agent_connections', 'Agent connections remain in the existing private control plane');
select has_table('platform_private', 'agent_exchange_credentials', 'Exchanged credentials retain their OAuth session binding');
select has_function('platform_private', 'agent_access_token_hook', array['jsonb'], 'OAuth token hook binds the approved WISER resource');

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'platform_private'
     and c.relname in ('agent_connections', 'agent_exchange_credentials')
     and c.relrowsecurity and c.relforcerowsecurity),
  2::bigint,
  'Both private connection tables enforce RLS'
);

select lives_ok($test$
  do $body$
  declare event jsonb := '{"user_id":"10000000-0000-4000-8000-000000000005","claims":{"sub":"10000000-0000-4000-8000-000000000005","aud":"authenticated","role":"authenticated"}}';
  begin
    if platform_private.agent_access_token_hook(event) <> event then
      raise exception 'Direct human login claims were changed';
    end if;
  end $body$;
$test$, 'The token hook preserves direct human login');

select lives_ok($test$
  do $body$
  declare result jsonb;
  begin
    result := platform_private.agent_access_token_hook('{"user_id":"10000000-0000-4000-8000-000000000005","claims":{"sub":"10000000-0000-4000-8000-000000000005","client_id":"a9000000-0000-4000-8000-000000000001","aud":"authenticated","user_metadata":{"approved":true}}}');
    if result #>> '{error,http_code}' is distinct from '403' then
      raise exception 'Unapproved OAuth client received a usable token';
    end if;
  end $body$;
$test$, 'An unknown OAuth client cannot use user metadata to obtain access');

select lives_ok($test$
  do $body$
  declare
    owner_id uuid := '10000000-0000-4000-8000-000000000005';
    tenant_id uuid := 'b1000000-0000-4000-8000-000000000001';
    project_id uuid := 'b2000000-0000-4000-8000-000000000001';
    agent_id uuid := gen_random_uuid();
    delegation_id uuid := gen_random_uuid();
    client_id uuid := gen_random_uuid();
    resource_url text := 'https://mcp.example.test/mcp';
    result jsonb;
  begin
    insert into platform.actors(id,actor_type) values(agent_id,'agent');
    insert into platform.delegations
      (id,delegated_by_actor_id,delegate_actor_id,tenant_id,project_id,
       scopes,purpose,max_security_level,expires_at)
    values (delegation_id,owner_id,agent_id,tenant_id,project_id,
      array['data.catalog.read'],'agent-data','L1_INTERNAL',null);
    insert into platform_private.agent_connections
      (owner_actor_id,oauth_client_id,delegation_id,resource)
    values(owner_id,client_id,delegation_id,resource_url);
    result := platform_private.agent_access_token_hook(jsonb_build_object(
      'user_id',owner_id::text,
      'claims',jsonb_build_object('sub',owner_id::text,'client_id',client_id::text)
    ));
    if result #>> '{claims,aud}' is distinct from resource_url
      or result #>> '{claims,wiser_delegation_id}' is distinct from delegation_id::text then
      raise exception 'Persistent Agent connection did not refresh';
    end if;
    update platform.delegations set status='revoked',revoked_at=statement_timestamp()
      where id=delegation_id;
    result := platform_private.agent_access_token_hook(jsonb_build_object(
      'user_id',owner_id::text,
      'claims',jsonb_build_object('sub',owner_id::text,'client_id',client_id::text)
    ));
    if result #>> '{error,http_code}' is distinct from '403' then
      raise exception 'Revoked Agent connection refreshed';
    end if;
  end $body$;
$test$, 'An untimed Agent connection refreshes while active and stops after revocation');

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid
       and p.polname = 'wiser_direct_session_only' and not p.polpermissive)),
  0::bigint,
  'OAuth clients cannot bypass WISER through exposed application tables'
);

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_private' and p.proname = 'agent_access_token_hook'
     and not p.prosecdef and not has_function_privilege('authenticated', p.oid, 'execute')
     and has_function_privilege('supabase_auth_admin', p.oid, 'execute')),
  1::bigint,
  'Only Supabase Auth invokes the token hook without definer privileges'
);

select * from finish();
rollback;
