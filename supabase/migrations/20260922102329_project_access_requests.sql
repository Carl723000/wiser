create table platform_private.project_access_requests (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references platform.projects(id) on delete restrict,
 applicant_id uuid not null references platform.actors(id) on delete restrict,
 role_id uuid not null references platform.roles(id) on delete restrict,
 expires_at timestamptz not null,
 reason text not null check(length(reason) between 5 and 1000),
 status text not null default 'pending' check(status in ('pending','withdrawn','rejected','approved','effective','execution_failed')),
 version bigint not null default 1 check(version>0),
 requested_member_version bigint not null check(requested_member_version>=0),
 applied_member_version bigint check(applied_member_version>0),
 decided_by uuid references platform.actors(id) on delete restrict,
 decision_reason text check(length(decision_reason) between 5 and 1000),
 decided_at timestamptz,
 last_error_code text check(last_error_code in ('VERSION_CONFLICT','INVALID_EXPIRY','ROLE_NOT_ASSIGNABLE','PROTECTED_MEMBER','MEMBER_UNAVAILABLE','EXECUTION_UNAVAILABLE')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(expires_at>created_at), check(decided_by is null or decided_by<>applicant_id),
 check(status not in ('approved','rejected','effective','execution_failed') or (decided_by is not null and decision_reason is not null and decided_at is not null)),
 check(status<>'effective' or applied_member_version is not null)
);
create index project_access_request_project_idx on platform_private.project_access_requests(project_id,created_at,id);
create index project_access_request_applicant_idx on platform_private.project_access_requests(applicant_id);
create index project_access_request_role_idx on platform_private.project_access_requests(role_id);
create index project_access_request_decider_idx on platform_private.project_access_requests(decided_by);
alter table platform_private.project_access_requests enable row level security;
alter table platform_private.project_access_requests force row level security;
revoke all on platform_private.project_access_requests from public,anon,authenticated,service_role;
alter table platform_private.project_access_events drop constraint project_access_events_action_check,
 add constraint project_access_events_action_check check(action in ('grant','revoke','invite','delivery','delivery-failed','request','withdraw','approve','reject','execute','execute-failed'));
