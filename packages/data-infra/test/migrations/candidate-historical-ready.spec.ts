import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
  '../../../../infrastructure/data-foundation/postgres/migrations/0045_candidate_historical_ready_reads.sql',
  import.meta.url,
);
const migration = () =>
  existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

describe('bounded historical READY policy source seam', () => {
  it('adds a row-bound READY branch while preserving the current checkpoint guard', () => {
    const sql = migration();
    expect(sql).toContain(
      'candidate_historical_ready_readable(requested ingestion.candidate_batch)',
    );
    expect(sql).toContain("requested.status is distinct from 'READY'");
    expect(sql).toContain('requested.completed_at is null');
    expect(sql).toContain(
      'candidate_historical_ready_readable(candidate_batch)',
    );
    expect(sql).toContain(
      'candidate_readable(tenant_id,project_id,ingestion_id,transform_plan_id,review_hash,security_level,policy_version)',
    );
    expect(sql).not.toMatch(
      /(?:create|replace)\s+function\s+ingestion\.(?:candidate_readable|candidate_worker_lease|guard_candidate)/i,
    );
  });
  it('bounds historical authority without querying a recursively protected carrier', () => {
    const sql = migration();
    expect(sql).toContain('wiser.candidate_fixed_refs');
    expect(sql).toContain('service.valid_candidate_view_refs');
    expect(sql).toContain('newer.plan_version>frozen.plan_version');
    expect(sql).toContain('input.fingerprint');
    const historical = sql.split(
      'create or replace function ingestion.candidate_original_readable',
    )[0]!;
    expect(historical).not.toMatch(
      /(?:from|join)\s+(?:ingestion\.candidate_(?:batch|asset|record|conversion_check)|catalog\.(?:asset|content_blob))/i,
    );
    expect(sql).not.toMatch(
      /security\s+definer|bypassrls|disable\s+row\s+level|set\s+row_security/i,
    );
  });
  it('carries original reads through the same actual READY branch and exact original binding', () => {
    const sql = migration();
    expect(sql).toContain(
      'create or replace function ingestion.candidate_original_readable',
    );
    expect(sql).toContain('candidate_historical_ready_readable(batch)');
    expect(sql).toContain('wiser.candidate_original_asset');
    expect(sql).toContain('wiser.candidate_original_review_hash');
    expect(sql).not.toMatch(/(?:alter|drop)\s+policy\s+resource_read_scope/i);
  });
});
