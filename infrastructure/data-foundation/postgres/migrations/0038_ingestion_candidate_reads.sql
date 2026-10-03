-- Current verified maintenance/review authority is checked on every candidate read.
-- API sets these transaction-local facts after Auth; no grant, approval or published identity is created.
create or replace function ingestion.candidate_readable(
  requested_tenant uuid, requested_project uuid, requested_ingestion uuid,
  requested_plan uuid, requested_hash bytea, requested_security text, requested_policy bigint
) returns boolean language sql stable set search_path=pg_catalog as $$
  select security.authorized_row(requested_tenant,requested_project,requested_security,requested_policy)
    and exists (select 1 from ingestion.session session
      join ingestion.transform_plan plan on plan.tenant_id=session.tenant_id
        and plan.project_id=session.project_id and plan.ingestion_id=session.ingestion_id
      join ingestion.project_review_policy policy on policy.tenant_id=session.tenant_id and policy.project_id=session.project_id
      where session.tenant_id=requested_tenant and session.project_id=requested_project
        and session.ingestion_id=requested_ingestion and session.owner_project_id=requested_project
        and session.security_level=requested_security and session.policy_version=requested_policy
        and session.state in ('REVIEW_REQUIRED','APPROVED','COMMITTED','PROJECTING','PUBLISHED','REJECTED')
        and plan.transform_plan_id=requested_plan and plan.plan_hash=requested_hash
        and plan.status in ('REVIEW_REQUIRED','APPROVED','REJECTED')
        and plan.plan #> '{assetManifest,reviewGovernance}'=session.review_policy_snapshot
        and policy.enabled and session.review_policy_snapshot=jsonb_build_object('mode',policy.mode,'revision',policy.revision)
        and not exists (select 1 from ingestion.transform_plan newer
          where newer.tenant_id=plan.tenant_id and newer.project_id=plan.project_id
            and newer.ingestion_id=plan.ingestion_id and newer.plan_version>plan.plan_version)
        and (ingestion.candidate_worker_lease(requested_tenant,requested_project,requested_ingestion,
          session.operation_id,requested_security,requested_policy)
          or (pg_has_role(current_user,'wiser_data_api','MEMBER')
            and session.submitted_by_actor_id is not null
            and session.submitted_actor_type in ('human','agent','service')
            and nullif(current_setting('wiser.candidate_purpose',true),'') is not null
            and (
              (current_setting('wiser.candidate_maintainer',true)='true' and (
                (current_setting('wiser.actor_type',true)='human'
                  and nullif(current_setting('wiser.delegated_by',true),'') is null
                  and ((session.submitted_actor_type='human' and session.submitted_delegator_actor_id is null
                    and session.submitted_by_actor_id::text=current_setting('wiser.actor_id',true))
                    or session.submitted_delegator_actor_id::text=current_setting('wiser.actor_id',true)))
                or (current_setting('wiser.actor_type',true) in ('agent','service')
                  and session.submitted_actor_type=current_setting('wiser.actor_type',true)
                  and session.submitted_by_actor_id::text=current_setting('wiser.actor_id',true)
                  and session.submitted_delegator_actor_id is not null
                  and session.submitted_delegator_actor_id::text=current_setting('wiser.delegated_by',true))))
              or (current_setting('wiser.candidate_reviewer',true)='true'
                and current_setting('wiser.actor_type',true)='human'
                and nullif(current_setting('wiser.delegated_by',true),'') is null
                and session.submitted_by_actor_id::text<>current_setting('wiser.actor_id',true)
                and coalesce(session.submitted_delegator_actor_id::text,'')<>current_setting('wiser.actor_id',true))
            ))));
$$;
