-- Server-owned Data governance configuration. Identity and grants remain in Supabase.
create table ingestion.project_review_policy (
  tenant_id uuid not null,
  project_id uuid not null,
  mode text not null check (mode = 'REQUIRE_INDEPENDENT_REVIEW'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  enabled boolean not null default true,
  security_level text not null default 'L0_PUBLIC' check (security_level = 'L0_PUBLIC'),
  policy_version bigint not null default 1 check (policy_version > 0),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, project_id)
);
alter table ingestion.project_review_policy enable row level security;
alter table ingestion.project_review_policy force row level security;
create policy project_review_policy_read on ingestion.project_review_policy
  for select using (security.authorized_row(tenant_id, project_id, security_level, policy_version));
-- No runtime INSERT/UPDATE/DELETE policy: configuration is not an ingestion input.

alter table ingestion.session
  add column submitted_by_actor_id uuid,
  add column submitted_actor_type text,
  add column submitted_delegator_actor_id uuid,
  add column review_policy_snapshot jsonb;
alter table ingestion.session add constraint ingestion_submission_responsibility_shape check (
  (submitted_by_actor_id is null and submitted_actor_type is null and submitted_delegator_actor_id is null)
  or (submitted_by_actor_id is not null and submitted_actor_type is not null and (
    (submitted_actor_type = 'human' and submitted_delegator_actor_id is null)
    or (submitted_actor_type in ('agent', 'service') and submitted_delegator_actor_id is not null)
  ))
);
alter table ingestion.session add constraint ingestion_review_policy_snapshot_shape check (
  review_policy_snapshot is null or (
    jsonb_typeof(review_policy_snapshot) = 'object'
    and octet_length(review_policy_snapshot::text) <= 256
    and review_policy_snapshot ->> 'mode' = 'REQUIRE_INDEPENDENT_REVIEW'
    and jsonb_typeof(review_policy_snapshot -> 'revision') = 'number'
  )
);

create function ingestion.guard_project_review_policy()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'review policy history cannot be deleted' using errcode = '42501';
  end if;
  if new.tenant_id is distinct from old.tenant_id or new.project_id is distinct from old.project_id
    or new.mode is distinct from old.mode or new.security_level is distinct from old.security_level
    or new.policy_version is distinct from old.policy_version or new.created_at is distinct from old.created_at then
    raise exception 'review policy identity is immutable' using errcode = '42501';
  end if;
  if new.revision <> old.revision + 1 or new.row_version <> old.row_version + 1 then
    raise exception 'review policy revision must advance exactly once' using errcode = '40001';
  end if;
  return new;
end;
$$;
create trigger project_review_policy_guard before update or delete on ingestion.project_review_policy
  for each row execute function ingestion.guard_project_review_policy();

create function ingestion.assert_current_review_policy(candidate ingestion.session)
returns boolean language plpgsql set search_path = pg_catalog as $$
declare
  policy ingestion.project_review_policy%rowtype;
  snapshot jsonb;
begin
  select * into policy from ingestion.project_review_policy
    where tenant_id = candidate.tenant_id and project_id = candidate.project_id for share;
  if not found then
    if candidate.review_policy_snapshot is not null then
      raise exception 'review policy unavailable' using errcode = '55000';
    end if;
    return false;
  end if;
  snapshot := jsonb_build_object('mode', policy.mode, 'revision', policy.revision);
  if not policy.enabled or candidate.review_policy_snapshot is distinct from snapshot then
    raise exception 'review policy revision conflict' using errcode = '55000';
  end if;
  return true;
end;
$$;

create function ingestion.assert_independent_reviewer(candidate ingestion.session, reviewer uuid)
returns void language plpgsql set search_path = pg_catalog as $$
begin
  if to_regrole('wiser_data_api') is null
    or not pg_has_role(current_user, 'wiser_data_api', 'MEMBER')
    or current_setting('wiser.actor_type', true) is distinct from 'human'
    or current_setting('wiser.actor_id', true) is distinct from reviewer::text
    or candidate.submitted_by_actor_id is null or candidate.submitted_actor_type is null
    or (candidate.submitted_actor_type <> 'human' and candidate.submitted_delegator_actor_id is null)
    or reviewer is null or reviewer = candidate.submitted_by_actor_id
    or reviewer = candidate.submitted_delegator_actor_id then
    raise exception 'independent human review required' using errcode = '42501';
  end if;
end;
$$;

create function ingestion.guard_session_review_policy()
returns trigger language plpgsql set search_path = pg_catalog as $$
declare
  policy ingestion.project_review_policy%rowtype;
  expected_snapshot jsonb;
  operation_actor uuid;
  governed boolean;
begin
  if tg_op = 'INSERT' then
    select * into policy from ingestion.project_review_policy
      where tenant_id = new.tenant_id and project_id = new.project_id for share;
    if found then
      if not policy.enabled then raise exception 'review policy disabled' using errcode = '55000'; end if;
      expected_snapshot := jsonb_build_object('mode', policy.mode, 'revision', policy.revision);
      if new.submitted_by_actor_id is null or new.submitted_actor_type is null then
        raise exception 'submission responsibility required' using errcode = '42501';
      end if;
    end if;
    if new.review_policy_snapshot is not null and new.review_policy_snapshot is distinct from expected_snapshot then
      raise exception 'review policy must come from the server' using errcode = '42501';
    end if;
    new.review_policy_snapshot := expected_snapshot;
    if new.submitted_by_actor_id is not null then
      select actor_id into operation_actor from service.operation where tenant_id = new.tenant_id
        and project_id = new.project_id and operation_id = new.operation_id;
      if operation_actor is distinct from new.submitted_by_actor_id
        or current_setting('wiser.actor_id', true) is distinct from new.submitted_by_actor_id::text
        or current_setting('wiser.actor_type', true) is distinct from new.submitted_actor_type
        or coalesce(current_setting('wiser.delegated_by', true), '') is distinct from coalesce(new.submitted_delegator_actor_id::text, '') then
        raise exception 'submission responsibility must match trusted context' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;
  if new.submitted_by_actor_id is distinct from old.submitted_by_actor_id
    or new.submitted_actor_type is distinct from old.submitted_actor_type
    or new.submitted_delegator_actor_id is distinct from old.submitted_delegator_actor_id
    or new.review_policy_snapshot is distinct from old.review_policy_snapshot then
    raise exception 'submission responsibility and review policy are immutable' using errcode = '42501';
  end if;
  if new.state in ('FAILED', 'CANCELLED', 'REJECTED') then return new; end if;
  governed := ingestion.assert_current_review_policy(new);
  if governed and new.state = 'APPROVED' then
    if old.state <> 'REVIEW_REQUIRED' then
      raise exception 'automatic approval is disabled' using errcode = '42501';
    end if;
    perform ingestion.assert_independent_reviewer(new, new.approved_by_actor_id);
  end if;
  if governed and new.state in ('COMMITTED', 'PROJECTING', 'PUBLISHED') then
    if new.approved_by_actor_id is null or new.approved_by_actor_id = new.submitted_by_actor_id
      or new.approved_by_actor_id = new.submitted_delegator_actor_id then
      raise exception 'unreviewed ingestion cannot commit or publish' using errcode = '42501';
    end if;
    if not exists (select 1 from ingestion.transform_plan where tenant_id = new.tenant_id
      and project_id = new.project_id and ingestion_id = new.ingestion_id and status = 'APPROVED'
      and approved_by_actor_id = new.approved_by_actor_id
      and plan #> '{assetManifest,reviewGovernance}' = new.review_policy_snapshot) then
      raise exception 'reviewed checkpoint policy binding required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger ingestion_session_review_policy_guard before insert or update on ingestion.session
  for each row execute function ingestion.guard_session_review_policy();

create function ingestion.guard_checkpoint_review_policy()
returns trigger language plpgsql set search_path = pg_catalog as $$
declare
  candidate ingestion.session%rowtype;
  governed boolean;
begin
  if new.status not in ('REVIEW_REQUIRED', 'APPROVED') then return new; end if;
  select * into candidate from ingestion.session where tenant_id = new.tenant_id
    and project_id = new.project_id and ingestion_id = new.ingestion_id for share;
  if not found then raise exception 'ingestion checkpoint unavailable' using errcode = '42501'; end if;
  governed := ingestion.assert_current_review_policy(candidate);
  if not governed then return new; end if;
  if new.plan #> '{assetManifest,reviewGovernance}' is distinct from candidate.review_policy_snapshot then
    raise exception 'checkpoint review policy binding required' using errcode = '42501';
  end if;
  if new.status = 'APPROVED' then
    if tg_op <> 'UPDATE' then raise exception 'automatic checkpoint approval is disabled' using errcode = '42501'; end if;
    perform ingestion.assert_independent_reviewer(candidate, new.approved_by_actor_id);
  end if;
  return new;
end;
$$;
create trigger transform_plan_review_policy_guard before insert or update on ingestion.transform_plan
  for each row execute function ingestion.guard_checkpoint_review_policy();

create function ingestion.guard_version_review_policy()
returns trigger language plpgsql set search_path = pg_catalog as $$
declare
  candidate ingestion.session%rowtype;
begin
  select * into candidate from ingestion.session where tenant_id = new.tenant_id
    and project_id = new.project_id and ingestion_id = new.data_item_id for share;
  if not found then return new; end if;
  if ingestion.assert_current_review_policy(candidate) then
    if candidate.approved_by_actor_id is null or candidate.state not in ('APPROVED', 'COMMITTED', 'PROJECTING', 'PUBLISHED')
      or new.asset_manifest -> 'reviewGovernance' is distinct from candidate.review_policy_snapshot then
      raise exception 'unreviewed version cannot commit or publish' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger data_item_version_review_policy_guard before insert or update on catalog.data_item_version
  for each row execute function ingestion.guard_version_review_policy();

revoke all on function ingestion.guard_project_review_policy() from public;
revoke all on function ingestion.assert_current_review_policy(ingestion.session) from public;
revoke all on function ingestion.assert_independent_reviewer(ingestion.session, uuid) from public;
revoke all on function ingestion.guard_session_review_policy() from public;
revoke all on function ingestion.guard_checkpoint_review_policy() from public;
revoke all on function ingestion.guard_version_review_policy() from public;
