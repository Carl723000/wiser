import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const directory = resolve(
  import.meta.dirname,
  '../../../../infrastructure/data-foundation/postgres',
);
const path = resolve(
  directory,
  'migrations/0049_candidate_followup_evidence_identity.sql',
);
const sql = () => (existsSync(path) ? readFileSync(path, 'utf8') : '');
it('adds only UUID-spelling duplicate denial after existing event guards', () => {
  expect(sql()).toContain(
    'create function ingestion.candidate_followup_evidence_identity',
  );
  expect(sql()).toContain(
    'create trigger candidate_followup_event_identity_guard',
  );
  expect(sql()).toContain("new.action<>'SUPPLEMENT'");
  expect(sql()).toContain(
    'count(distinct ingestion.candidate_followup_evidence_identity',
  );
  expect(sql()).toContain(
    'ingestion.candidate_followup_evidence_identity(added)=ingestion.candidate_followup_evidence_identity(existing)',
  );
  expect(sql()).not.toMatch(
    /security\s+definer|create\s+(?:or\s+replace\s+)?(?:role|user)|alter\s+policy|update\s+ingestion\./i,
  );
});
it('retains literal source hash, locator, CRS and geometry', () => {
  const body = sql().slice(0, sql().indexOf('create function ingestion.guard'));
  for (const field of [
    'ingestionId',
    'processingBatchId',
    'assetId',
    'recordId',
  ])
    expect(body).toContain(field);
  expect(body).not.toMatch(/sourceHash|locator|sourceCrs|geometry/);
  expect(body).toContain('immutable');
});
it('grants no new role and provisions only exact API helper access', () => {
  const provision = readFileSync(
    resolve(directory, 'provision-runtime.sql'),
    'utf8',
  );
  expect(provision).toContain(
    "to_regprocedure('ingestion.candidate_followup_evidence_identity(jsonb)')",
  );
  expect(provision).toContain(
    'ingestion.guard_candidate_followup_evidence_identity() to wiser_data_api',
  );
  expect(sql()).toContain('from public');
});
