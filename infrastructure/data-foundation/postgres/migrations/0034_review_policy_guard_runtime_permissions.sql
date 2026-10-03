-- Read-only runtime policy grants must not make guarded row locks hide the policy.
-- Trigger guards run as their migration owner; ordinary queries retain forced RLS.
alter function ingestion.guard_session_review_policy() security definer;
alter function ingestion.guard_checkpoint_review_policy() security definer;
alter function ingestion.guard_version_review_policy() security definer;

create or replace function ingestion.assert_current_review_policy(candidate ingestion.session)
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  policy ingestion.project_review_policy%rowtype;
  snapshot jsonb;
begin
  if candidate.tenant_id is distinct from security.current_tenant_id()
    or candidate.project_id is distinct from security.current_project_id() then
    raise exception 'review policy scope conflict' using errcode = '42501';
  end if;
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

create or replace function ingestion.assert_independent_reviewer(candidate ingestion.session, reviewer uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare
  caller_role text := coalesce(nullif(current_setting('role', true), 'none'), session_user);
begin
  if to_regrole('wiser_data_api') is null then
    raise exception 'independent human review required' using errcode = '42501';
  end if;
  if not pg_has_role(caller_role, 'wiser_data_api', 'MEMBER')
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
