import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    expect(sql).toMatch(/timeout_at\s*=\s*clock_timestamp\(\)\s*\+\s*interval '6 hours'/i);
    expect(sql).toMatch(/candidate\.status = 'RUNNING'\s+and candidate\.timeout_at <= observed_at/i);
    expect(sql).toContain('create or replace function ingestion.guard_job_status_transition');
  });
});
