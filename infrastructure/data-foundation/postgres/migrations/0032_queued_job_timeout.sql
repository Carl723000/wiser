-- Queue wait and human review are not execution time. An expired, unclaimed
-- legacy ingestion Job stays available for an audited resume of its original
-- Operation; each actual claim receives a bounded six-hour execution window.
-- No existing authority row is rewritten by this migration.

create or replace function ingestion.guard_job_status_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.job_id is distinct from old.job_id
    or new.tenant_id is distinct from old.tenant_id
    or new.project_id is distinct from old.project_id
    or new.ingestion_id is distinct from old.ingestion_id
    or new.operation_id is distinct from old.operation_id
    or new.job_type is distinct from old.job_type
    or new.idempotency_key is distinct from old.idempotency_key
    or new.priority is distinct from old.priority
    or new.depends_on_job_id is distinct from old.depends_on_job_id
    or new.max_attempts is distinct from old.max_attempts
    or new.backoff_base_seconds is distinct from old.backoff_base_seconds
    or new.backoff_max_seconds is distinct from old.backoff_max_seconds
    or new.security_level is distinct from old.security_level
    or new.policy_version is distinct from old.policy_version
    or new.created_at is distinct from old.created_at
  then
    raise exception 'ingestion job authority identity is immutable'
      using errcode = '42501';
  end if;
  if new.payload is distinct from old.payload
    and not (
      old.status in ('WAITING_INPUT', 'WAITING_REVIEW')
      and new.status = 'PENDING'
    )
  then
    raise exception 'ingestion job payload may change only when waking input'
      using errcode = '55000';
  end if;
  if new.timeout_at is distinct from old.timeout_at
    and not (
      (old.status in ('WAITING_INPUT', 'WAITING_REVIEW')
       and new.status = 'PENDING')
      or (old.job_type = 'data.ingestion.process'
          and old.status in ('PENDING', 'RETRY_SCHEDULED')
          and new.status = 'RUNNING'
          and new.timeout_at > clock_timestamp())
      or (old.job_type = 'data.ingestion.process'
          and old.status = 'PENDING' and new.status = 'PENDING'
          and old.attempt_count = 0
          and old.timeout_at <= clock_timestamp()
          and new.timeout_at is null)
    )
  then
    raise exception 'ingestion job timeout may change only on wake, claim, or expired queue recovery'
      using errcode = '55000';
  end if;
  if (
    new.status = 'RUNNING'
    and old.status in ('PENDING', 'RETRY_SCHEDULED')
    and new.attempt_count is distinct from old.attempt_count + 1
  ) or (
    not (
      new.status = 'RUNNING'
      and old.status in ('PENDING', 'RETRY_SCHEDULED')
    )
    and new.attempt_count is distinct from old.attempt_count
  ) then
    raise exception 'ingestion job attempt count does not match its transition'
      using errcode = '55000';
  end if;
  if new.status is not distinct from old.status and old.status = 'RUNNING' then
    if new.lease_owner is null
      or new.lease_owner is distinct from old.lease_owner
      or new.next_attempt_at is distinct from old.next_attempt_at
      or new.error_category is distinct from old.error_category
      or new.last_error_detail is distinct from old.last_error_detail
      or new.completed_at is not null
      or not (
        (
          new.cancel_requested_at is not distinct from old.cancel_requested_at
          and (
            new.heartbeat_at is distinct from old.heartbeat_at
            or new.lease_expires_at is distinct from old.lease_expires_at
          )
          and new.heartbeat_at is not null
          and new.lease_expires_at is not null
          and (
            old.heartbeat_at is null
            or new.heartbeat_at >= old.heartbeat_at
          )
        )
        or (
          new.lease_expires_at is not distinct from old.lease_expires_at
          and new.heartbeat_at is not distinct from old.heartbeat_at
          and new.cancel_requested_at is not null
          and (
            (
              old.cancel_requested_at is null
              and new.cancel_requested_at is distinct from old.cancel_requested_at
            )
            or (
              old.cancel_requested_at is not null
              and new.cancel_requested_at is not distinct from old.cancel_requested_at
            )
          )
        )
      )
    then
      raise exception 'invalid running job heartbeat or cancellation mutation'
        using errcode = '55000';
    end if;
  elsif old.job_type = 'data.ingestion.process'
    and old.status = 'PENDING' and new.status = 'PENDING'
    and old.attempt_count = 0
    and old.timeout_at <= clock_timestamp()
    and new.timeout_at is null
    and (to_jsonb(new) - '{timeout_at,row_version,updated_at}'::text[])
      = (to_jsonb(old) - '{timeout_at,row_version,updated_at}'::text[])
  then
    null;
  elsif (old.status, new.status) in (
    ('PENDING', 'RUNNING'),
    ('PENDING', 'CANCELLED'),
    ('PENDING', 'DEAD_LETTER'),
    ('RUNNING', 'WAITING_INPUT'),
    ('RUNNING', 'WAITING_REVIEW'),
    ('RUNNING', 'RETRY_SCHEDULED'),
    ('RUNNING', 'SUCCEEDED'),
    ('RUNNING', 'FAILED'),
    ('RUNNING', 'CANCELLED'),
    ('RUNNING', 'DEAD_LETTER'),
    ('WAITING_INPUT', 'PENDING'),
    ('WAITING_INPUT', 'CANCELLED'),
    ('WAITING_INPUT', 'DEAD_LETTER'),
    ('WAITING_REVIEW', 'PENDING'),
    ('WAITING_REVIEW', 'CANCELLED'),
    ('WAITING_REVIEW', 'DEAD_LETTER'),
    ('RETRY_SCHEDULED', 'RUNNING'),
    ('RETRY_SCHEDULED', 'CANCELLED'),
    ('RETRY_SCHEDULED', 'DEAD_LETTER')
  ) then
    null;
  else
    raise exception 'invalid job status transition % -> %', old.status, new.status
      using errcode = '55000';
  end if;

  if new.row_version is distinct from old.row_version + 1 then
    raise exception 'ingestion job row version must advance exactly once'
      using errcode = '40001';
  end if;
  return new;
end;
$$;

create or replace function ingestion.claim_jobs_at(
  requested_tenant_id uuid,
  requested_project_id uuid,
  worker_id text,
  lease_duration interval,
  batch_size integer,
  observed_at timestamptz
)
returns setof ingestion.job
language plpgsql
set search_path = pg_catalog
as $$
declare
  claimed_job ingestion.job%rowtype;
  claimed_record record;
begin
  if requested_tenant_id is distinct from security.current_tenant_id()
     or requested_project_id is distinct from security.current_project_id() then
    raise exception 'job claim scope does not match the authorized database context'
      using errcode = '42501';
  end if;
  if worker_id is null or btrim(worker_id) = '' then
    raise exception 'worker_id is required' using errcode = '22023';
  end if;
  if observed_at is null
     or lease_duration is null
     or lease_duration <= interval '0 seconds'
     or lease_duration > interval '15 minutes'
     or batch_size is null
     or batch_size < 1
     or batch_size > 100 then
    raise exception 'invalid claim time, lease duration, or batch size'
      using errcode = '22023';
  end if;

  -- Claim rows first, then acquire their Operation locks in a deterministic
  -- order while retaining the real pre-claim status for durable events.
  for claimed_record in
    with candidates as (
      select candidate.job_id, candidate.status as previous_job_status
      from ingestion.job as candidate
      where candidate.tenant_id = requested_tenant_id
        and candidate.project_id = requested_project_id
        and candidate.cancel_requested_at is null
        and candidate.attempt_count < candidate.max_attempts
        and candidate.next_attempt_at <= clock_timestamp()
        and (
          candidate.timeout_at is null
          or candidate.timeout_at > clock_timestamp()
          or (candidate.job_type = 'data.ingestion.process'
              and candidate.status = 'RETRY_SCHEDULED')
        )
        and candidate.status in ('PENDING', 'RETRY_SCHEDULED')
        and exists (
          select 1
          from service.operation as operation
          where operation.tenant_id = candidate.tenant_id
            and operation.project_id = candidate.project_id
            and operation.operation_id = candidate.operation_id
            and operation.status not in ('SUCCEEDED', 'FAILED', 'CANCELLED')
        )
        and (
          candidate.depends_on_job_id is null
          or exists (
            select 1
            from ingestion.job as dependency
            where dependency.job_id = candidate.depends_on_job_id
              and dependency.tenant_id = candidate.tenant_id
              and dependency.project_id = candidate.project_id
              and dependency.status = 'SUCCEEDED'
          )
        )
      order by candidate.priority desc, candidate.next_attempt_at, candidate.created_at
      for update skip locked
      limit batch_size
    ), claimed_rows as (
      update ingestion.job as claimed
      set status = 'RUNNING',
          lease_owner = worker_id,
          lease_expires_at = least(
            clock_timestamp() + lease_duration,
            case when claimed.job_type = 'data.ingestion.process'
              then clock_timestamp() + interval '6 hours'
              else coalesce(claimed.timeout_at, 'infinity'::timestamptz)
            end
          ),
          timeout_at = case when claimed.job_type = 'data.ingestion.process'
            then clock_timestamp() + interval '6 hours'
            else claimed.timeout_at
          end,
          heartbeat_at = clock_timestamp(),
          attempt_count = claimed.attempt_count + 1,
          error_category = null,
          last_error_detail = null,
          row_version = claimed.row_version + 1,
          updated_at = observed_at
      from candidates
      where claimed.job_id = candidates.job_id
      returning claimed.job_id,
        claimed.operation_id,
        candidates.previous_job_status
    )
    select claimed_rows.*
    from claimed_rows
    order by claimed_rows.operation_id, claimed_rows.job_id
  loop
    select candidate.*
    into strict claimed_job
    from ingestion.job as candidate
    where candidate.tenant_id = requested_tenant_id
      and candidate.project_id = requested_project_id
      and candidate.job_id = claimed_record.job_id;

    insert into ingestion.job_attempt (
      tenant_id,
      project_id,
      job_id,
      attempt_number,
      worker_id,
      started_at,
      security_level,
      policy_version,
      row_version,
      created_at,
      updated_at
    )
    values (
      claimed_job.tenant_id,
      claimed_job.project_id,
      claimed_job.job_id,
      claimed_job.attempt_count,
      worker_id,
      observed_at,
      claimed_job.security_level,
      claimed_job.policy_version,
      1,
      observed_at,
      observed_at
    );

    perform ingestion.record_job_transition(
      claimed_job,
      claimed_record.previous_job_status,
      observed_at,
      jsonb_build_object('workerId', worker_id)
    );
    return next claimed_job;
  end loop;
  return;
end;
$$;

create or replace function ingestion.recover_jobs(
  requested_tenant_id uuid,
  requested_project_id uuid,
  observed_at timestamptz,
  batch_size integer default 100
)
returns setof ingestion.job
language plpgsql
set search_path = pg_catalog
as $$
declare
  current_job ingestion.job%rowtype;
  recovered_job ingestion.job%rowtype;
  target_status text;
  retry_seconds integer;
begin
  if batch_size is null
     or batch_size < 1
     or batch_size > 1000
     or observed_at is null then
    raise exception 'invalid recovery time or batch size' using errcode = '22023';
  end if;

  for current_job in
    select candidate.*
    from ingestion.job as candidate
    where candidate.tenant_id = requested_tenant_id
      and candidate.project_id = requested_project_id
      and candidate.status not in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER')
      and (
        candidate.cancel_requested_at is not null
        or (
          (candidate.job_type <> 'data.ingestion.process'
           or candidate.status = 'RUNNING')
          and candidate.timeout_at <= observed_at
        )
        or (
          candidate.status = 'RUNNING'
          and candidate.lease_expires_at <= observed_at
        )
      )
    order by candidate.operation_id, candidate.job_id
    for update skip locked
    limit batch_size
  loop
    target_status := case
      when current_job.cancel_requested_at is not null then 'CANCELLED'
      when current_job.timeout_at <= observed_at then 'DEAD_LETTER'
      when current_job.attempt_count >= current_job.max_attempts then 'DEAD_LETTER'
      else 'RETRY_SCHEDULED'
    end;
    retry_seconds := case
      when target_status = 'RETRY_SCHEDULED' then ingestion.retry_delay_seconds(
        current_job.attempt_count,
        current_job.backoff_base_seconds,
        current_job.backoff_max_seconds
      )
      else 0
    end;

    update ingestion.job as candidate
    set status = target_status,
        lease_owner = null,
        lease_expires_at = null,
        heartbeat_at = null,
        next_attempt_at = case
          when target_status = 'RETRY_SCHEDULED' then observed_at + retry_seconds * interval '1 second'
          else candidate.next_attempt_at
        end,
        error_category = case
          when target_status = 'DEAD_LETTER' then 'JOB_TIMEOUT'
          else candidate.error_category
        end,
        last_error_detail = case
          when target_status = 'DEAD_LETTER' then jsonb_build_object('message', 'Job exceeded its timeout or maximum attempts.')
          else candidate.last_error_detail
        end,
        completed_at = case
          when target_status in ('DEAD_LETTER', 'CANCELLED') then observed_at
          else null
        end,
        row_version = candidate.row_version + 1,
        updated_at = observed_at
    where candidate.job_id = current_job.job_id
    returning candidate.* into recovered_job;

    if current_job.status = 'RUNNING' then
      update ingestion.job_attempt
      set outcome = target_status,
          error_category = case
            when target_status = 'DEAD_LETTER' then 'JOB_TIMEOUT'
            else 'LEASE_EXPIRED'
          end,
          finished_at = observed_at,
          row_version = row_version + 1,
          updated_at = observed_at
      where tenant_id = current_job.tenant_id
        and project_id = current_job.project_id
        and job_id = current_job.job_id
        and attempt_number = current_job.attempt_count;
    end if;

    perform ingestion.record_job_transition(
      recovered_job,
      current_job.status,
      observed_at,
      jsonb_build_object('recovered', true)
    );
    return next recovered_job;
  end loop;
  return;
end;
$$;

revoke all on function ingestion.guard_job_status_transition() from public;
revoke all on function ingestion.claim_jobs_at(uuid, uuid, text, interval, integer, timestamptz) from public;
revoke all on function ingestion.recover_jobs(uuid, uuid, timestamptz, integer) from public;
