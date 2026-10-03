-- Approval is an independently checked transition, never initial session metadata.
create function ingestion.guard_reviewed_session_creation()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if new.state in ('APPROVED', 'COMMITTED', 'PROJECTING', 'PUBLISHED')
    and exists (select 1 from ingestion.project_review_policy
      where tenant_id = new.tenant_id and project_id = new.project_id) then
    raise exception 'reviewed state cannot be inserted' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger ingestion_session_creation_review_guard before insert on ingestion.session
  for each row execute function ingestion.guard_reviewed_session_creation();
revoke all on function ingestion.guard_reviewed_session_creation() from public;
