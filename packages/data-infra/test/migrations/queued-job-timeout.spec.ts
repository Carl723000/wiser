import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  import.meta.dirname,
  '../../../../infrastructure/data-foundation/postgres/migrations/0032_queued_job_timeout.sql',
);

describe('queued job timeout recovery', () => {
  it('starts the deadline on claim and never expires an unclaimed or review-waiting job', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('create or replace function ingestion.claim_jobs_at');
    expect(sql).toContain('create or replace function ingestion.recover_jobs');
    expect(sql).toMatch(
      /timeout_at\s*=\s*case when claimed\.job_type = 'data\.ingestion\.process'/i,
    );
    expect(sql).toMatch(
      /candidate\.status = 'RUNNING'\)\s+and candidate\.timeout_at <= observed_at/i,
    );
    expect(sql).toContain(
      'create or replace function ingestion.guard_job_status_transition',
    );
  });

  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'keeps the original queued job claimable and excludes review waiting from execution timeout',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      const tenantId = randomUUID();
      const projectId = randomUUID();
      const operationId = randomUUID();
      const ingestionId = randomUUID();
      const jobId = randomUUID();
      const role = `wiser_queue_test_${randomUUID().replaceAll('-', '')}`;
      const observedAt = new Date().toISOString();
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      try {
        await client.query('begin');
        await client.query(
          `create role ${role} nologin nosuperuser nobypassrls`,
        );
        await client.query(
          `grant usage on schema ingestion, service, event, security to ${role}`,
        );
        await client.query(
          `grant select, insert, update on all tables in schema ingestion, service, event to ${role}`,
        );
        await client.query(
          `grant usage, select on all sequences in schema ingestion, service, event to ${role}`,
        );
        await client.query(
          `grant execute on all functions in schema ingestion, security to ${role}`,
        );
        await client.query(
          `insert into service.operation
            (operation_id, tenant_id, project_id, capability_id, actor_id,
             status, security_level, request_payload, started_at)
           values ($1, $2, $3, 'data.ingestion.create', $1,
                   'RUNNING', 'L1_INTERNAL', '{}', $4)`,
          [operationId, tenantId, projectId, observedAt],
        );
        await client.query(
          `insert into ingestion.session
            (ingestion_id, tenant_id, project_id, operation_id,
             owner_project_id, state, intended_uses, expected_version,
             requested_security_level, security_level)
           values ($1, $2, $3, $4, $3, 'RECEIVED',
                   array['research'], 1, 'L1_INTERNAL', 'L1_INTERNAL')`,
          [ingestionId, tenantId, projectId, operationId],
        );
        await client.query(
          `insert into ingestion.job
            (job_id, tenant_id, project_id, ingestion_id, operation_id,
             job_type, status, idempotency_key, payload, next_attempt_at,
             timeout_at, security_level)
           values ($1, $2, $3, $4, $5, 'data.ingestion.process',
                   'PENDING', $1::uuid::text, '{}', $6, $7, 'L1_INTERNAL')`,
          [
            jobId,
            tenantId,
            projectId,
            ingestionId,
            operationId,
            expiredAt,
            expiredAt,
          ],
        );
        await client.query(`set local role ${role}`);
        await client.query(
          `select set_config('wiser.tenant_id', $1, true),
                  set_config('wiser.project_id', $2, true),
                  set_config('wiser.max_security_level', 'L1_INTERNAL', true),
                  set_config('wiser.policy_version', '1', true)`,
          [tenantId, projectId],
        );
        expect(
          (
            await client.query(
              `select * from ingestion.recover_jobs($1, $2, $3, 10)`,
              [tenantId, projectId, observedAt],
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await client.query(
              `select * from ingestion.claim_jobs_at(
                $1, $2, 'queue-test-worker', interval '2 minutes', 1, $3
              )`,
              [tenantId, projectId, observedAt],
            )
          ).rows,
        ).toHaveLength(0);
        const resumed = await client.query<{ row_version: string }>(
          `update ingestion.job
           set timeout_at = null, row_version = row_version + 1,
               updated_at = $2
           where job_id = $1 and status = 'PENDING'
             and attempt_count = 0 and timeout_at <= $2
           returning row_version`,
          [jobId, observedAt],
        );
        expect(Number(resumed.rows[0]?.row_version)).toBe(2);
        const claimed = await client.query<{
          job_id: string;
          status: string;
          timeout_at: Date;
        }>(
          `select * from ingestion.claim_jobs_at(
            $1, $2, 'queue-test-worker', interval '2 minutes', 1, $3
          )`,
          [tenantId, projectId, observedAt],
        );
        expect(claimed.rows).toHaveLength(1);
        expect(claimed.rows[0]).toMatchObject({
          job_id: jobId,
          status: 'RUNNING',
        });
        expect(
          claimed.rows[0]!.timeout_at.valueOf() - Date.now(),
        ).toBeGreaterThan(5 * 60 * 60 * 1000);
        await client.query(
          `update ingestion.job
           set status = 'WAITING_REVIEW', lease_owner = null,
               lease_expires_at = null, heartbeat_at = null,
               row_version = row_version + 1
           where job_id = $1`,
          [jobId],
        );
        await client.query(
          `select ingestion.record_job_transition(job,
            'RUNNING', $2, '{}'::jsonb)
           from ingestion.job as job where job.job_id = $1`,
          [jobId, observedAt],
        );
        expect(
          (
            await client.query(
              `select * from ingestion.recover_jobs($1, $2, $3, 10)`,
              [
                tenantId,
                projectId,
                new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString(),
              ],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
});
