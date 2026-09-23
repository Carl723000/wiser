-- Preserve historical previews as unknown; require a fresh snapshot for approval/execution.
alter table platform_private.resource_batch_members
 add column grant_snapshot_hash text check(grant_snapshot_hash~'^[0-9a-f]{64}$'),
 add column grant_diff jsonb check(jsonb_typeof(grant_diff)='object' and octet_length(grant_diff::text)<=8192);
alter table platform_private.resource_batch_attempts drop constraint resource_batch_attempts_error_code_check;
alter table platform_private.resource_batch_attempts add constraint resource_batch_attempts_error_code_check
 check(error_code in ('MEMBERSHIP_CHANGED','RESOURCE_UNAVAILABLE','AUTHORITY_CHANGED','EXECUTION_FAILED','ACCESS_CHANGED'));
