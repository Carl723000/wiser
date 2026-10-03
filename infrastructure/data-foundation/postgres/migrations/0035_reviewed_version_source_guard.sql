-- Governed projects cannot bypass ingestion review by choosing an unrelated item ID.
create or replace function ingestion.guard_version_review_policy()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare
  candidate ingestion.session%rowtype;
  policy ingestion.project_review_policy%rowtype;
  configured boolean;
begin
  select * into policy from ingestion.project_review_policy
    where tenant_id = new.tenant_id and project_id = new.project_id for share;
  configured := found;
  if configured then
    if new.tenant_id is distinct from security.current_tenant_id()
      or new.project_id is distinct from security.current_project_id() then
      raise exception 'review policy scope conflict' using errcode = '42501';
    end if;
    if not policy.enabled then
      raise exception 'review policy unavailable' using errcode = '55000';
    end if;
  end if;
  select * into candidate from ingestion.session where tenant_id = new.tenant_id
    and project_id = new.project_id and ingestion_id = new.data_item_id for share;
  if not found then
    if configured then
      raise exception 'reviewed ingestion source required' using errcode = '42501';
    end if;
    return new;
  end if;
  if ingestion.assert_current_review_policy(candidate) then
    if candidate.approved_by_actor_id is null or candidate.state not in ('APPROVED', 'COMMITTED', 'PROJECTING', 'PUBLISHED')
      or new.asset_manifest -> 'reviewGovernance' is distinct from candidate.review_policy_snapshot then
      raise exception 'unreviewed version cannot commit or publish' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
