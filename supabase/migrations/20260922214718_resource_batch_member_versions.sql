-- Null historical snapshots are rejected at execution; never infer old authority from current membership.
alter table platform_private.resource_batch_members add column tenant_membership_version bigint check(tenant_membership_version>0);
alter table platform_private.resource_batch_members add column actor_authz_version bigint check(actor_authz_version>0);
