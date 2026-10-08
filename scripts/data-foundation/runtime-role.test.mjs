import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { ROOT_DIRECTORY } from './operations.mjs';

const sqlPath = new URL(
  '../../infrastructure/data-foundation/postgres/provision-runtime.sql',
  import.meta.url,
);

test('provisions isolated non-bypass API, Worker, and GIS identities', async () => {
  const sql = await readFile(sqlPath, 'utf8');
  for (const role of [
    'wiser_data_runtime',
    'wiser_data_api',
    'wiser_data_worker',
    'wiser_data_gis',
  ]) {
    assert.match(sql, new RegExp(`\\b${role}\\b`));
  }
  assert.match(sql, /wiser_data_runtime\s+NOLOGIN/i);
  assert.match(sql, /wiser_data_api\s+LOGIN/i);
  assert.match(sql, /wiser_data_worker\s+LOGIN/i);
  assert.match(sql, /wiser_data_gis\s+LOGIN/i);
  assert.match(sql, /NOSUPERUSER/i);
  assert.match(sql, /NOBYPASSRLS/i);
  assert.match(sql, /grant wiser_data_runtime to wiser_data_api/i);
  assert.match(sql, /grant wiser_data_runtime to wiser_data_worker/i);
  assert.doesNotMatch(sql, /grant wiser_data_runtime to wiser_data_gis/i);
  assert.match(
    sql,
    /grant execute on function service\.wiser_spatial_extent_mvt[\s\S]*?to wiser_data_gis/i,
  );
  assert.doesNotMatch(sql, /grant\s+all\s+privileges/i);
  assert.doesNotMatch(sql, /password\s+'[^:]/i);
});

test('keeps provisioning one-shot and gates authority runtimes on it', async () => {
  const compose = await readFile(
    new URL('../../compose.yaml', import.meta.url),
    'utf8',
  );
  assert.match(compose, /data-runtime-provision:/);
  assert.match(compose, /provision-runtime\.sql:ro/);
  assert.match(compose, /DATA_API_DATABASE_PASSWORD/);
  assert.match(compose, /DATA_WORKER_DATABASE_PASSWORD/);
  assert.match(compose, /DATA_GIS_DATABASE_PASSWORD/);
  assert.match(
    compose,
    /data-worker:[\s\S]*?DATA_DATABASE_URL:\s*postgresql:\/\/wiser_data_worker:/,
  );
  assert.match(
    compose,
    /martin:[\s\S]*?DATABASE_URL:\s*postgresql:\/\/wiser_data_gis:/,
  );
  assert.match(
    compose,
    /data-worker:[\s\S]*?data-runtime-provision:[\s\S]*?condition:\s*service_completed_successfully/,
  );
  assert.equal(typeof ROOT_DIRECTORY, 'string');
});

test('serializes authority and pgSTAC migrations on a fresh database', async () => {
  const compose = await readFile(
    new URL('../../compose.yaml', import.meta.url),
    'utf8',
  );
  const start = compose.indexOf('\n  pgstac-migrate:');
  const end = compose.indexOf('\n  seaweedfs:', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const pgstacMigration = compose.slice(start, end);

  assert.match(
    pgstacMigration,
    /depends_on:[\s\S]*?data-migrate:[\s\S]*?condition:\s*service_completed_successfully/,
  );
  assert.doesNotMatch(
    pgstacMigration,
    /depends_on:[\s\S]*?data-postgres:[\s\S]*?condition:\s*service_healthy/,
  );
});

test('starts certificate consumers after initialization without enabling Data in the base stack', async () => {
  const compose = async (args) => {
    const { stdout } = await promisify(execFile)(
      'docker',
      ['compose', ...args, 'config', '--format', 'json'],
      { cwd: ROOT_DIRECTORY, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout).services;
  };
  const services = await compose(['--profile', 'data-foundation']);
  const awaitsCertificate = (service) =>
    Object.entries(services[service].depends_on ?? {}).some(
      ([dependency, gate]) =>
        dependency === 'opensearch-icu-init'
          ? gate.condition === 'service_completed_successfully'
          : gate.condition === 'service_healthy' &&
            awaitsCertificate(dependency),
    );

  for (const consumer of ['api', 'data-worker']) {
    assert.ok(
      awaitsCertificate(consumer),
      `${consumer} must load its CA after certificate initialization completes`,
    );
  }

  const base = await compose([]);
  assert.ok(base.api);
  assert.equal(base['opensearch-icu-init'], undefined);
  assert.equal(base.opensearch, undefined);
});

test('restores reconciliation review-only grants after the common table grants', async () => {
  const sql = (await readFile(sqlPath, 'utf8')).toLowerCase();
  const common = sql.indexOf('grant select, insert, update on all tables');
  const revoke = sql.indexOf(
    'revoke update on service.observation_reconciliation from wiser_data_runtime',
  );
  assert.ok(
    revoke > common,
    'provisioning must remove inherited whole-row update permission',
  );
  const review =
    /grant update\(status,\s*row_version,\s*reviewed_at,\s*review_note\) on service\.observation_reconciliation to wiser_data_runtime/.exec(
      sql,
    );
  assert.ok(
    review && review.index > revoke,
    'only the four review fields may be updated',
  );
});

test('restores only the business-membership validator after roles are provisioned', async () => {
  const sql = (await readFile(sqlPath, 'utf8')).toLowerCase();
  assert.match(
    sql,
    /if to_regprocedure\('service\.valid_exploration_business_pins\(jsonb\)'\) is not null then\s+grant execute on function service\.valid_exploration_business_pins\(jsonb\) to wiser_data_runtime;/,
  );
  assert.doesNotMatch(sql, /grant execute on all functions in schema service/);
});

// Bootstrap grants must not undo the approved Worker-only conversion carrier.
// This checks provisioning order; real role privileges are independently tested
// by the conditional isolated PostgreSQL fixture.
test('narrows conversion result roles after inherited common grants', async () => {
  const sql = (await readFile(sqlPath, 'utf8')).toLowerCase();
  const common = sql.indexOf('grant select, insert, update on all tables');
  const start = sql.indexOf(
    "if to_regclass('ingestion.candidate_conversion_check') is not null then",
  );
  assert.ok(
    start > common,
    'conversion grants must narrow common inherited writes',
  );
  const end = sql.indexOf('end if;', start);
  assert.ok(end > start);
  const block = sql.slice(start, end);
  assert.match(
    block,
    /revoke all on ingestion\.candidate_conversion_check\s+from wiser_data_runtime,\s*wiser_data_api,\s*wiser_data_worker;/,
  );
  assert.match(
    block,
    /grant select on ingestion\.candidate_conversion_check to wiser_data_api;/,
  );
  assert.match(
    block,
    /grant select,\s*insert on ingestion\.candidate_conversion_check to wiser_data_worker;/,
  );
  assert.doesNotMatch(block, /grant[^;]+to wiser_data_runtime/);
  assert.doesNotMatch(block, /grant[^;]+\b(update|delete|truncate)\b/);
});

test('narrows private candidate relation carriers after the common grants', async () => {
  const sql = (await readFile(sqlPath, 'utf8')).toLowerCase();
  const start = sql.indexOf(
    "if to_regclass('ingestion.candidate_relation_revision') is not null then",
  );
  assert.ok(
    start > sql.indexOf('grant select, insert, update on all tables in schema'),
  );
  const end = sql.indexOf('end if;', start);
  const block = sql.slice(start, end);
  for (const table of [
    'candidate_relation_revision',
    'candidate_relation_evidence',
    'candidate_relation_responsibility',
    'candidate_relation_decision',
  ])
    assert.ok(block.includes(`ingestion.${table}`));
  assert.match(
    block,
    /revoke all on[\s\S]+from wiser_data_runtime,wiser_data_api,wiser_data_worker/,
  );
  assert.match(block, /grant select,insert on[\s\S]+to wiser_data_api/);
  assert.doesNotMatch(
    block,
    /grant[\s\S]+to wiser_data_runtime|grant update|grant delete/,
  );
});

test('restores candidate rebind append-only API grants after common grants', async () => {
  const sql = (await readFile(sqlPath, 'utf8')).toLowerCase();
  const start = sql.indexOf(
      "if to_regclass('ingestion.candidate_relation_rebind') is not null then",
    ),
    end = sql.indexOf('end if;', start);
  assert.ok(start > sql.indexOf('grant select, insert, update on all tables'));
  const block = sql.slice(start, end);
  assert.match(
    block,
    /revoke all on ingestion\.candidate_relation_rebind from wiser_data_runtime,wiser_data_api,wiser_data_worker/,
  );
  assert.match(
    block,
    /grant select,insert on ingestion\.candidate_relation_rebind to wiser_data_api/,
  );
  assert.doesNotMatch(
    block,
    /grant update|grant delete|grant[\s\S]+to wiser_data_runtime|grant[\s\S]+to wiser_data_worker/,
  );
});

test('runs candidate followup native guards in the existing serial PostgreSQL lane', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const start = workflow.indexOf(
    '- name: Verify resource isolation and immutable exploration membership',
  );
  const end = workflow.indexOf('- name:', start + 8);
  assert.ok(start >= 0 && end > start);
  const lane = workflow.slice(start, end);
  assert.match(lane, /WISER_DATA_PG_INTEGRATION: '1'/);
  assert.match(lane, /vitest run --no-file-parallelism/);
  assert.match(
    lane,
    /packages\/data-infra\/test\/migrations\/ingestion-candidate-followups\.spec\.ts/,
  );
  for (const oldFile of [
    'ingestion-candidate.spec.ts',
    'ingestion-candidate-relations.spec.ts',
    'ingestion-candidate-topics.spec.ts',
  ])
    assert.ok(lane.includes(oldFile));
});
