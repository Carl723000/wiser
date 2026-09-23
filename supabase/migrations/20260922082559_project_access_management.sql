-- Project management configuration is private and opt-in. It is not a second identity store.
create table platform_private.project_access_settings (
  project_id uuid primary key references platform.projects(id) on delete restrict,
  requests_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
create table platform_private.project_access_roles (
  project_id uuid not null references platform.projects(id) on delete restrict,
  role_id uuid not null references platform.roles(id) on delete restrict,
  max_days integer not null check (max_days between 1 and 366),
  primary key (project_id, role_id)
);
create table platform_private.project_access_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references platform.projects(id) on delete restrict,
  created_by_actor_id uuid not null references platform.actors(id) on delete restrict,
  email text not null check (length(email) between 3 and 254),
  role_id uuid not null references platform.roles(id) on delete restrict,
  expires_at timestamptz not null,
  reason text not null check (length(reason) between 5 and 1000),
  status text not null default 'pending' check (status in ('pending','delivered','failed','granted')),
  actor_id uuid references platform.actors(id) on delete restrict,
  version bigint not null default 1 check (version > 0),
  last_error_code text check (last_error_code in ('DELIVERY_UNAVAILABLE','GRANT_UNAVAILABLE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (status not in ('delivered','granted') or actor_id is not null)
);
create index project_access_invitation_project_idx
  on platform_private.project_access_invitations(project_id,created_at,id);
create index project_access_invitation_actor_idx
  on platform_private.project_access_invitations(actor_id) where actor_id is not null;
create index project_access_invitation_creator_idx
  on platform_private.project_access_invitations(created_by_actor_id);
create index project_access_invitation_role_idx
  on platform_private.project_access_invitations(role_id);
create index project_access_role_idx on platform_private.project_access_roles(role_id);

create table platform_private.project_access_mutations (
  actor_id uuid not null references platform.actors(id) on delete restrict,
  idempotency_key uuid not null,
  project_id uuid not null references platform.projects(id) on delete restrict,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id,idempotency_key)
);
create index project_access_mutation_project_idx
  on platform_private.project_access_mutations(project_id);

create table platform_private.project_access_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references platform.projects(id) on delete restrict,
  actor_id uuid not null references platform.actors(id) on delete restrict,
  subject_id uuid not null,
  action text not null check (action in ('grant','revoke','invite','delivery','delivery-failed')),
  reason text not null check (length(reason) between 5 and 1000),
  before_state jsonb not null,
  after_state jsonb not null,
  created_at timestamptz not null default now()
);
create index project_access_event_project_idx
  on platform_private.project_access_events(project_id,created_at,id);
create index project_access_event_actor_idx
  on platform_private.project_access_events(actor_id);

create function platform_private.reject_project_access_history_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '22023', message = 'Project access history is append-only.';
end;
$$;
revoke all on function platform_private.reject_project_access_history_change()
 from public,anon,authenticated,service_role;
create trigger project_access_events_immutable before update or delete
 on platform_private.project_access_events for each row
 execute function platform_private.reject_project_access_history_change();
create trigger project_access_mutations_immutable before update or delete
 on platform_private.project_access_mutations for each row
 execute function platform_private.reject_project_access_history_change();

alter table platform_private.project_access_settings enable row level security;
alter table platform_private.project_access_settings force row level security;
alter table platform_private.project_access_roles enable row level security;
alter table platform_private.project_access_roles force row level security;
alter table platform_private.project_access_invitations enable row level security;
alter table platform_private.project_access_invitations force row level security;
alter table platform_private.project_access_mutations enable row level security;
alter table platform_private.project_access_mutations force row level security;
alter table platform_private.project_access_events enable row level security;
alter table platform_private.project_access_events force row level security;
revoke all on platform_private.project_access_settings,platform_private.project_access_roles,
 platform_private.project_access_invitations,platform_private.project_access_mutations,
 platform_private.project_access_events from public,anon,authenticated,service_role;
