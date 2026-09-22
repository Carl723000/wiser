begin;
select plan(9);
select has_table('platform_private', 'project_access_settings', 'project discovery is explicitly configured');
select has_table('platform_private', 'project_access_roles', 'assignable roles are explicitly configured');
select has_table('platform_private', 'project_access_invitations', 'invitation delivery has its own lifecycle');
select has_table('platform_private', 'project_access_mutations', 'idempotency lives in private storage');
select has_table('platform_private', 'project_access_events', 'project changes retain audit evidence');
select is((select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='platform_private' and c.relname like 'project_access_%' and c.relkind='r'
 and c.relrowsecurity and c.relforcerowsecurity), 5::bigint, 'all access tables force RLS');
select is((select count(*) from information_schema.role_table_grants where table_schema='platform_private'
 and table_name like 'project_access_%' and grantee in ('anon','authenticated','PUBLIC')),0::bigint,'browser roles cannot directly administer members');
select has_trigger('platform_private','project_access_events','project_access_events_immutable','audit is append-only');
select is((select count(*) from platform.role_scopes where scope in ('platform.membership.manage','platform.access.approve')), 2::bigint, 'local owner seed explicitly has separate management and approval scopes');
select * from finish();
rollback;
