-- Compatibility denial only: retain 0047 roots, histories, RLS and transitions.
-- Compare UUID identities independently of spelling without changing source proof.
create function ingestion.candidate_followup_evidence_identity(evidence jsonb) returns jsonb
language plpgsql immutable strict security invoker set search_path=pg_catalog as $$
declare normalized jsonb:=evidence;
begin
  normalized:=jsonb_set(normalized,'{reference,ingestionId}',to_jsonb(lower(evidence#>>'{reference,ingestionId}')));
  normalized:=jsonb_set(normalized,'{reference,processingBatchId}',to_jsonb(lower(evidence#>>'{reference,processingBatchId}')));
  normalized:=jsonb_set(normalized,'{assetId}',to_jsonb(lower(evidence->>'assetId')));
  if evidence ? 'recordId' then normalized:=jsonb_set(normalized,'{recordId}',to_jsonb(lower(evidence->>'recordId'))); end if;
  return normalized;
end $$;

create function ingestion.guard_candidate_followup_evidence_identity() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare root ingestion.candidate_followup%rowtype;
begin
  if new.action<>'SUPPLEMENT' then return new; end if;
  -- This name sorts after candidate_followup_event_guard. That existing guard
  -- has already checked current authority, every source and held the same lock.
  select * into root from ingestion.candidate_followup where tenant_id=new.tenant_id
    and project_id=new.project_id and followup_id=new.followup_id;
  if not found then raise exception 'candidate followup sources are unavailable' using errcode='42501'; end if;
  if (select count(distinct ingestion.candidate_followup_evidence_identity(value)) from jsonb_array_elements(new.evidence))<>jsonb_array_length(new.evidence)
    or exists(select 1 from jsonb_array_elements(new.evidence) added
      join jsonb_array_elements(jsonb_build_array(root.source)||root.evidence) existing
        on ingestion.candidate_followup_evidence_identity(added)=ingestion.candidate_followup_evidence_identity(existing)) then
    raise exception 'candidate followup supplemental evidence must be new and nonduplicate' using errcode='42501';
  end if;
  return new;
end $$;
create trigger candidate_followup_event_identity_guard before insert on ingestion.candidate_followup_event
  for each row execute function ingestion.guard_candidate_followup_evidence_identity();
revoke all on function ingestion.candidate_followup_evidence_identity(jsonb),
  ingestion.guard_candidate_followup_evidence_identity() from public;
