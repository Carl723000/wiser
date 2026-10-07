begin;

select plan(8);

select ok(
  exists (
    select 1
    from auth.users
    where id = '10000000-0000-4000-8000-000000000005'::uuid
      and email = 'operator@agent-excon.test'
      and role = 'authenticated'
      and aud = 'authenticated'
      and email_confirmed_at is not null
      and encrypted_password is not null
      and confirmation_token = ''
      and recovery_token = ''
      and email_change_token_new = ''
      and reauthentication_token = ''
  ),
  'the local operator is a confirmed password-auth user'
);

select ok(
  exists (
    select 1
    from auth.identities
    where user_id = '10000000-0000-4000-8000-000000000005'::uuid
      and provider = 'email'
      and identity_data ->> 'email' = 'operator@agent-excon.test'
  ),
  'the local operator has an email identity'
);

select is(
  (
    select raw_app_meta_data ->> 'provider'
    from auth.users
    where id = '10000000-0000-4000-8000-000000000005'::uuid
  ),
  'email',
  'the local operator keeps the email provider claim'
);

select ok(
  exists (
    select 1 from auth.users
    where id = '10000000-0000-4000-8000-000000000006'::uuid
      and email = 'reviewer@agent-excon.test'
      and role = 'authenticated' and aud = 'authenticated'
      and email_confirmed_at is not null
      and encrypted_password = extensions.crypt(
        'WiserLocalReviewer-2026!', encrypted_password
      )
  ),
  'the separate local reviewer is a confirmed password-auth user'
);
select ok(
  exists (
    select 1 from auth.identities
    where user_id = '10000000-0000-4000-8000-000000000006'::uuid
      and provider = 'email'
      and identity_data ->> 'email' = 'reviewer@agent-excon.test'
  ),
  'the separate local reviewer has an email identity'
);
select ok(
  exists (
    select 1
    from platform.actors as actor
    join platform.tenant_memberships as tenant on tenant.actor_id = actor.id
    join platform.project_memberships as project
      on project.actor_id = actor.id and project.tenant_id = tenant.tenant_id
    where actor.id = '10000000-0000-4000-8000-000000000006'::uuid
      and actor.actor_type = 'human' and actor.status = 'active'
      and tenant.tenant_id = 'b1000000-0000-4000-8000-000000000001'::uuid
      and project.project_id = 'b2000000-0000-4000-8000-000000000001'::uuid
      and tenant.status = 'active' and project.status = 'active'
  ),
  'the reviewer is a distinct active human in the fixed smoke project'
);
select is(
  (
    select array_agg(role.role_key order by role.role_key)
    from platform.role_bindings as binding
    join platform.roles as role on role.id = binding.role_id
    where binding.actor_id = '10000000-0000-4000-8000-000000000006'::uuid
      and binding.tenant_id = 'b1000000-0000-4000-8000-000000000001'::uuid
      and binding.project_id = 'b2000000-0000-4000-8000-000000000001'::uuid
      and binding.status = 'active'
  ),
  array['data-steward']::text[],
  'the reviewer receives only existing Data stewardship, without platform or EXCON roles'
);

select is(
  (
    select count(*) from platform.role_bindings
    where actor_id = '10000000-0000-4000-8000-000000000006'::uuid
      and status = 'active'
      and (
        tenant_id is distinct from 'b1000000-0000-4000-8000-000000000001'::uuid
        or project_id is distinct from 'b2000000-0000-4000-8000-000000000001'::uuid
      )
  ),
  0::bigint,
  'the local reviewer has no role authority outside the fixed fixture project'
);

select * from finish();
rollback;
