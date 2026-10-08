import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAfterAdvisoryWait } from './support/native-advisory-race.js';

const directory = resolve(
  import.meta.dirname,
  '../../../../infrastructure/data-foundation/postgres',
);

function migration(): string {
  const path = resolve(directory, 'migrations/0047_candidate_followups.sql');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function definition(sql: string, name: string): string {
  const start = sql.indexOf(`create function ingestion.${name}(`);
  const end = sql.indexOf('$$;', start);
  expect(start, `Missing private function ${name}`).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 3);
}

// Static migration guards are not live PostgreSQL, RLS or Auth acceptance.
describe('private candidate followup migration safety', () => {
  it('retains private forced-RLS roots and append-only event history', () => {
    const sql = migration();
    for (const table of ['candidate_followup', 'candidate_followup_event']) {
      expect(sql).toContain(`create table ingestion.${table} (`);
      expect(sql).toContain(
        `alter table ingestion.${table} enable row level security`,
      );
      expect(sql).toContain(
        `alter table ingestion.${table} force row level security`,
      );
    }
    expect(sql).not.toMatch(/security\s+definer/i);
    expect(sql).not.toMatch(/create\s+(?:or\s+replace\s+)?(?:role|user)\b/i);
    expect(sql).not.toMatch(
      /(?:insert\s+into|update)\s+(?:auth|knowledge|catalog)\./i,
    );
  });

  it('binds each current source to its exact candidate, original, locator and whole geometry', () => {
    const source = definition(
      migration(),
      'candidate_followup_sources_readable',
    );
    for (const field of [
      'b.tenant_id=requested_tenant',
      'b.project_id=requested_project',
      "evidence#>>'{reference,ingestionId}'",
      "evidence#>>'{reference,processingBatchId}'",
      "evidence#>>'{reference,reviewHash}'",
      "evidence->>'assetId'",
      "evidence->>'sourceHash'",
      "evidence->>'recordId'",
      "evidence->>'locator'",
      "evidence->'geometry'",
      "evidence->>'sourceCrs'",
    ])
      expect(source).toContain(field);
    expect(source).toContain('ingestion.candidate_batch');
    expect(source).toContain('ingestion.candidate_asset');
    expect(source).toContain('ingestion.candidate_record');
    expect(source).toContain('st_asgeojson');
    expect(source).not.toContain('ingestion.candidate_followup_event');
    expect(source).not.toContain('security definer');
  });

  it('locks append operations and rejects stale versions and invalid transitions', () => {
    const sql = migration();
    const event = definition(sql, 'guard_candidate_followup_event');
    expect(event).toContain("tg_op<>'INSERT'");
    expect(event).toContain('pg_advisory_xact_lock');
    expect(event).toContain('new.expected_version<>root.row_version');
    expect(event).toContain('new.row_version<>root.row_version+1');
    expect(event).toContain("errcode='40001'");
    for (const action of [
      'CREATE',
      'CLAIM',
      'HANDOFF',
      'SUPPLEMENT',
      'SUBMIT_REVIEW',
      'CLOSE',
      'RETURN',
      'REOPEN',
    ])
      expect(event).toContain(`'${action}'`);
    for (const state of ['OPEN', 'WORKING', 'REVIEW_PENDING', 'CLOSED']) {
      expect(event).toContain(`'${state}'`);
    }
    expect(sql).toContain('request_fingerprint bytea');
    expect(sql).toContain(
      'unique(tenant_id,project_id,followup_id,idempotency_key)',
    );
  });

  it('excludes every historical actor, delegator and handoff target from review', () => {
    const event = definition(migration(), 'guard_candidate_followup_event');
    expect(event).toContain("new.actor_type<>'human'");
    expect(event).toContain('new.delegated_by is not null');
    expect(event).toContain("current_setting('wiser.candidate_reviewer',true)");
    expect(event).toContain('jsonb_array_elements(root.responsibilities)');
    expect(event).toContain("responsibility->>'actorId'=new.actor_id::text");
    expect(event).toContain(
      "responsibility->>'delegatedBy'=new.actor_id::text",
    );
    expect(event).toContain('root.responsibilities||');
    expect(event).toContain('new.target');
    expect(event).toContain('candidate_followup_target_live');
  });

  it('rejects direct root edits and derives only current fields from the inserted event', () => {
    const root = definition(migration(), 'guard_candidate_followup_root');
    expect(root).toContain('pg_trigger_depth()<=1');
    expect(root).toContain(
      'new.source,new.rule_id,new.rule_version,new.reason',
    );
    expect(root).toContain(
      'old.source,old.rule_id,old.rule_version,old.reason',
    );
    expect(root).toContain('event.row_version=new.row_version');
    expect(root).toContain(
      'new.state,new.assignee,new.evidence,new.responsibilities',
    );
    expect(root).toContain(
      'appended.state_after,appended.assignee_after,appended.evidence_after,appended.responsibilities_after',
    );
    const projection = definition(
      migration(),
      'apply_candidate_followup_event',
    );
    expect(projection).toContain('update ingestion.candidate_followup');
    expect(projection).toContain('row_version=new.expected_version');
    expect(projection).not.toContain('knowledge.');
  });

  it('closes root and full event history when any cumulative source is unreadable', () => {
    const sql = migration();
    expect(sql).toContain('jsonb_build_array(source)||evidence');
    expect(sql).toContain('candidate_followup_read');
    expect(sql).toContain('candidate_followup_event_read');
    expect(sql).toContain(
      'exists(select 1 from ingestion.candidate_followup root',
    );
    expect(sql).toContain('candidate followup requires a CREATE event');
    expect(sql).toContain('deferrable initially deferred');
  });

  it('allows only whole-record correction pairs already present in candidate sources', () => {
    const correction = definition(
      migration(),
      'valid_candidate_followup_correction',
    );
    expect(correction).toContain("value->>'scope'='WHOLE_RECORD'");
    expect(correction).toContain("value->'old'");
    expect(correction).toContain("value->'new'");
    expect(correction).toContain("value->'mappingReason'");
    const event = definition(migration(), 'guard_candidate_followup_event');
    expect(event).toContain('new.correction');
    expect(event).toContain("root.type='CORRECTION'");
    expect(event).toContain("new.correction->'old'");
    expect(event).toContain("new.correction->'new'");
  });

  it('reapplies exact API permissions without inherited Worker or metadata writes', () => {
    const sql = readFileSync(
      resolve(directory, 'provision-runtime.sql'),
      'utf8',
    );
    const start = sql.indexOf(
      "if to_regclass('ingestion.candidate_followup') is not null then",
    );
    const end = sql.indexOf('end if;', start);
    expect(start).toBeGreaterThan(-1);
    const block = sql.slice(start, end);
    expect(block).toContain(
      'revoke all on ingestion.candidate_followup,ingestion.candidate_followup_event',
    );
    for (const role of [
      'wiser_data_runtime',
      'wiser_data_api',
      'wiser_data_worker',
      'wiser_data_metadata',
      'wiser_data_gis',
    ])
      expect(block).toContain(role);
    expect(block).toContain(
      'grant select,insert on ingestion.candidate_followup,ingestion.candidate_followup_event to wiser_data_api',
    );
    expect(block).toContain(
      'grant update(state,row_version,assignee,evidence,responsibilities) on ingestion.candidate_followup to wiser_data_api',
    );
    expect(block).not.toMatch(
      /grant\s+(?:all|update\s+on).*candidate_followup/,
    );
  });
});

/** Real schema fixture only: leased synthetic rows, no real source or approval. */
async function freezeFollowupSource(
  client: PoolClient,
  tenant: string,
  project: string,
  actor: string,
  coordinate: number,
  actorType = 'human',
  delegatedBy: string | null = null,
  requestedAsset?: string,
) {
  const ingestion = randomUUID(),
    asset = requestedAsset ?? randomUUID(),
    blob = randomUUID(),
    plan = randomUUID(),
    job = randomUUID(),
    batch = randomUUID(),
    record = randomUUID();
  const sourceHash = createHash('sha256')
    .update(`synthetic:${asset}`)
    .digest('hex');
  const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
  const base = {
    assetIds: [asset],
    assetManifest: {
      reviewGovernance: policy,
      assets: [{ assetId: asset, sourceHash }],
    },
    quality: {},
    alignment: {},
  };
  const reviewHash = createHash('sha256')
    .update(JSON.stringify(base))
    .digest('hex');
  const frozen = { ...base, reviewHash };
  await client.query('reset role');
  await client.query(
    "select set_config('wiser.resource_scope','',true),set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type',$2,true),set_config('wiser.delegated_by',$3,true)",
    [actor, actorType, delegatedBy ?? ''],
  );
  await client.query(
    `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload)
 values($1,$2,$3,'data.ingestion.submit',$4,'RUNNING','L0_PUBLIC','{}')`,
    [ingestion, tenant, project, actor],
  );
  await client.query(
    `insert into ingestion.session(ingestion_id,tenant_id,project_id,operation_id,owner_project_id,state,intended_uses,requested_security_level,security_level,submitted_by_actor_id,submitted_actor_type,submitted_delegator_actor_id)
 values($1,$2,$3,$1,$3,'SPATIOTEMPORAL_ALIGNED',array['synthetic-candidate-followup-test'],'L0_PUBLIC','L0_PUBLIC',$4,$5,$6)`,
    [ingestion, tenant, project, actor, actorType, delegatedBy],
  );
  await client.query(
    `insert into catalog.content_blob(content_blob_id,tenant_id,project_id,content_hash,byte_size,security_level)
 values($1,$2,$3,decode($4,'hex'),32,'L0_PUBLIC')`,
    [blob, tenant, project, sourceHash],
  );
  // The cumulative 0039 guard requires canonical fingerprinted, clean, hash-bound originals.
  await client.query(
    `insert into catalog.asset(asset_id,tenant_id,project_id,storage_key,media_type,byte_size,lifecycle_state,content_blob_id,content_hash,security_level)
 values($1,$2,$3,$4,'text/csv',32,'FINGERPRINTED',$5,decode($6,'hex'),'L0_PUBLIC')`,
    [asset, tenant, project, `quarantine/synthetic/${asset}`, blob, sourceHash],
  );
  await client.query(
    `insert into ingestion.input_asset(tenant_id,project_id,ingestion_id,asset_id,ordinal,fingerprint,scan_status,security_level)
 values($1,$2,$3,$4,0,decode($5,'hex'),'CLEAN','L0_PUBLIC')`,
    [tenant, project, ingestion, asset, sourceHash],
  );
  await client.query(
    `insert into ingestion.transform_plan(transform_plan_id,tenant_id,project_id,ingestion_id,plan_version,plan,plan_hash,status,security_level)
 values($1,$2,$3,$4,1,$5::jsonb,decode($6,'hex'),'REVIEW_REQUIRED','L0_PUBLIC')`,
    [plan, tenant, project, ingestion, JSON.stringify(frozen), reviewHash],
  );
  await client.query(
    "update ingestion.session set state='REVIEW_REQUIRED',row_version=row_version+1 where ingestion_id=$1",
    [ingestion],
  );
  await client.query(
    `insert into ingestion.job(job_id,tenant_id,project_id,ingestion_id,operation_id,job_type,status,idempotency_key,payload,lease_owner,lease_expires_at,attempt_count,timeout_at,security_level)
 values($1,$2,$3,$4,$4,'data.ingestion.process','RUNNING',$1::uuid::text,$5::jsonb,'candidate-followup-sql',clock_timestamp()+interval '5 minutes',1,clock_timestamp()+interval '1 hour','L0_PUBLIC')`,
    [
      job,
      tenant,
      project,
      ingestion,
      JSON.stringify({
        ingestionId: ingestion,
        expectedState: 'RECEIVED',
        expectedVersion: 1,
      }),
    ],
  );
  await client.query(
    "select set_config('wiser.candidate_job_id',$1,true),set_config('wiser.candidate_job_owner','candidate-followup-sql',true),set_config('wiser.candidate_job_attempt','1',true)",
    [job],
  );
  await client.query('set local role wiser_data_worker');
  await client.query(
    `insert into ingestion.candidate_batch(processing_batch_id,tenant_id,project_id,ingestion_id,transform_plan_id,operation_id,review_hash,parser_version,security_level,policy_version)
 values($1,$2,$3,$4,$5,$4,decode($6,'hex'),'synthetic.v1','L0_PUBLIC',1)`,
    [batch, tenant, project, ingestion, plan, reviewHash],
  );
  await client.query(
    `insert into ingestion.candidate_asset(processing_batch_id,asset_id,tenant_id,project_id,source_hash,security_level,policy_version)
 values($1,$2,$3,$4,decode($5,'hex'),'L0_PUBLIC',1)`,
    [batch, asset, tenant, project, sourceHash],
  );
  await client.query(
    `insert into ingestion.candidate_record(processing_batch_id,record_id,asset_id,tenant_id,project_id,record_index,source_id,record_values,geom,source_crs,security_level,policy_version)
 values($1,$2,$3,$4,$5,1,'table:1/row:1','{"c1":"synthetic"}',public.st_setsrid(public.st_makepoint($6,$6),4326),'EPSG:4326','L0_PUBLIC',1)`,
    [batch, record, asset, tenant, project, coordinate],
  );
  await client.query(
    `update ingestion.candidate_asset set status='READY',record_count=1,feature_count=1,columns='[{"key":"c1","label":"c1"}]' where processing_batch_id=$1`,
    [batch],
  );
  await client.query(
    "update ingestion.candidate_batch set status='READY',completed_at=clock_timestamp() where processing_batch_id=$1",
    [batch],
  );
  await client.query('reset role');
  return {
    reference: {
      kind: 'ingestion-candidate',
      ingestionId: ingestion,
      processingBatchId: batch,
      reviewHash,
    },
    asset,
    record,
    plan,
    frozen,
    evidence: {
      reference: {
        kind: 'ingestion-candidate',
        ingestionId: ingestion,
        processingBatchId: batch,
        reviewHash,
      },
      assetId: asset,
      recordId: record,
      sourceHash,
      locator: 'table:1/row:1',
      geometry: { type: 'Point', coordinates: [coordinate, coordinate] },
      sourceCrs: 'EPSG:4326',
    },
  };
}

async function deniedFollowup(
  client: PoolClient,
  execute: () => Promise<unknown>,
  code = '42501',
) {
  await client.query('savepoint followup_denied');
  await expect(execute()).rejects.toMatchObject({ code });
  await client.query('rollback to savepoint followup_denied');
}

/** Disposable migrated PostgreSQL only. Conditional skips prove no SQL/RLS. */
describe('private candidate followup native PostgreSQL authority', () => {
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'denies an asset UUID case-only repeat after an accepted GAP supplement without correction masking',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      const tenant = randomUUID(),
        project = randomUUID(),
        creator = randomUUID(),
        followup = randomUUID();
      const purpose = 'synthetic-gap-identity-test';
      const assetProof = (
        value: Awaited<ReturnType<typeof freezeFollowupSource>>,
      ) => ({
        reference: value.reference,
        assetId: value.asset,
        sourceHash: value.evidence.sourceHash,
        locator: `asset:${value.asset}`,
      });
      const append = (
        action: string,
        expectedVersion: number,
        evidence: unknown[] = [],
      ) =>
        client.query(
          `insert into ingestion.candidate_followup_event(event_id,tenant_id,project_id,followup_id,expected_version,row_version,action,actor_id,actor_type,purpose,evidence,note,idempotency_key,request_fingerprint,state_after,assignee_after,evidence_after,responsibilities_after)
         values($1,$2,$3,$4,$5,$5+1,$6,$7,'human',$8,$9::jsonb,'synthetic GAP action',$10,decode($11,'hex'),'OPEN',null,'[]','[]') returning row_version`,
          [
            randomUUID(),
            tenant,
            project,
            followup,
            expectedVersion,
            action,
            creator,
            purpose,
            JSON.stringify(evidence),
            randomUUID(),
            createHash('sha256')
              .update(JSON.stringify({ action, expectedVersion, evidence }))
              .digest('hex'),
          ],
        );
      try {
        await client.query('begin');
        await client.query(
          "select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L0_PUBLIC',true),set_config('wiser.policy_version','1',true)",
          [tenant, project],
        );
        await client.query(
          "insert into ingestion.project_review_policy(tenant_id,project_id,mode,revision) values($1,$2,'REQUIRE_INDEPENDENT_REVIEW',1)",
          [tenant, project],
        );
        const original = await freezeFollowupSource(
          client,
          tenant,
          project,
          creator,
          0,
        );
        const replacement = await freezeFollowupSource(
          client,
          tenant,
          project,
          creator,
          1,
          'human',
          null,
          randomUUID().replace(/^./, 'a'),
        );
        const oldProof = assetProof(original),
          newProof = assetProof(replacement);
        await client.query('set local role wiser_data_api');
        await client.query(
          "select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type','human',true),set_config('wiser.delegated_by','',true),set_config('wiser.purpose',$2,true),set_config('wiser.candidate_purpose',$2,true),set_config('wiser.candidate_maintainer','true',true),set_config('wiser.candidate_reviewer','true',true),set_config('wiser.candidate_view_deadline',(clock_timestamp()+interval '1 hour')::text,true),set_config('wiser.resource_scope','',true)",
          [creator, purpose],
        );
        await client.query(
          `insert into ingestion.candidate_followup(followup_id,tenant_id,project_id,type,source,rule_id,rule_version,reason,created_by_actor_id,created_actor_type,purpose,security_level,policy_version)
          values($1,$2,$3,'GAP',$4::jsonb,'synthetic-gap','1','synthetic gap identity only',$5,'human',$6,'L0_PUBLIC',1)`,
          [
            followup,
            tenant,
            project,
            JSON.stringify(oldProof),
            creator,
            purpose,
          ],
        );
        await append('CREATE', 0);
        await client.query('set constraints all immediate');
        await append('CLAIM', 1);
        await append('SUPPLEMENT', 2, [newProof]);
        expect(
          (
            await client.query(
              'select row_version,evidence from ingestion.candidate_followup where followup_id=$1',
              [followup],
            )
          ).rows[0],
        ).toEqual({ row_version: 3, evidence: [newProof] });
        const changed = {
          ...newProof,
          assetId: newProof.assetId.toUpperCase(),
        };
        expect(changed.assetId).not.toBe(newProof.assetId);
        expect({ ...changed, assetId: newProof.assetId }).toEqual(newProof);
        // Readability casts UUID identity; literal locator/hash remain unchanged.
        expect(
          (
            await client.query(
              'select ingestion.candidate_followup_sources_readable($1,$2,$3::jsonb) readable',
              [tenant, project, JSON.stringify([changed])],
            )
          ).rows[0],
        ).toEqual({ readable: true });
        await client.query('savepoint case_only_gap');
        let denial: unknown = null,
          accepted: unknown = null;
        try {
          await append('SUPPLEMENT', 3, [changed]);
          accepted = (
            await client.query(
              'select row_version,jsonb_array_length(evidence) evidence_count from ingestion.candidate_followup where followup_id=$1',
              [followup],
            )
          ).rows[0];
        } catch (error) {
          denial = (error as { code?: string }).code;
        }
        await client.query('rollback to savepoint case_only_gap');
        expect({ denial, accepted }).toEqual({
          denial: '42501',
          accepted: null,
        });
        expect(
          (
            await client.query(
              'select row_version,evidence from ingestion.candidate_followup where followup_id=$1',
              [followup],
            )
          ).rows[0],
        ).toEqual({ row_version: 3, evidence: [newProof] });
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );

  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'reprovisions API derived columns and leaves Worker, metadata and GIS without followup access',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const sql = readFileSync(
          resolve(directory, 'provision-runtime.sql'),
          'utf8',
        );
        const start = sql.indexOf(
          "if to_regclass('ingestion.candidate_followup') is not null then",
        );
        const end = sql.indexOf('end if;', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        for (let pass = 0; pass < 2; pass++) {
          await client.query(
            'grant select,insert,update on ingestion.candidate_followup,ingestion.candidate_followup_event to wiser_data_runtime',
          );
          await client.query(
            `do $$ begin ${sql.slice(start, end + 7)} end $$;`,
          );
          for (const table of [
            'candidate_followup',
            'candidate_followup_event',
          ]) {
            for (const role of [
              'wiser_data_runtime',
              'wiser_data_api',
              'wiser_data_worker',
              'wiser_data_metadata',
              'wiser_data_gis',
            ]) {
              expect(
                (
                  await client.query(
                    "select has_table_privilege($1,$2,'SELECT') reads,has_table_privilege($1,$2,'INSERT') inserts,has_table_privilege($1,$2,'UPDATE') updates,has_table_privilege($1,$2,'DELETE') deletes",
                    [role, `ingestion.${table}`],
                  )
                ).rows[0],
              ).toEqual({
                reads: role === 'wiser_data_api',
                inserts: role === 'wiser_data_api',
                updates: false,
                deletes: false,
              });
              const columns =
                table === 'candidate_followup'
                  ? [
                      'state',
                      'row_version',
                      'assignee',
                      'evidence',
                      'responsibilities',
                      'source',
                      'created_by_actor_id',
                    ]
                  : ['action', 'actor_id', 'evidence', 'state_after'];
              for (const column of columns) {
                expect(
                  (
                    await client.query(
                      "select has_column_privilege($1,$2,$3,'UPDATE') updates",
                      [role, `ingestion.${table}`, column],
                    )
                  ).rows[0],
                ).toEqual({
                  updates:
                    role === 'wiser_data_api' &&
                    table === 'candidate_followup' &&
                    !['source', 'created_by_actor_id'].includes(column),
                });
              }
            }
          }
        }
        expect(
          (
            await client.query(
              "select relname,relrowsecurity,relforcerowsecurity from pg_class where oid in ('ingestion.candidate_followup'::regclass,'ingestion.candidate_followup_event'::regclass) order by relname",
            )
          ).rows,
        ).toEqual([
          {
            relname: 'candidate_followup',
            relrowsecurity: true,
            relforcerowsecurity: true,
          },
          {
            relname: 'candidate_followup_event',
            relrowsecurity: true,
            relforcerowsecurity: true,
          },
        ]);
        expect(
          (
            await client.query(
              "select count(*)::integer count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ingestion' and p.proname like '%candidate_followup%' and p.prosecdef",
            )
          ).rows[0],
        ).toEqual({ count: 0 });
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );

  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'retains full responsibilities, exact whole-record evidence and independent technical review without publication',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      const tenant = randomUUID(),
        project = randomUUID(),
        creator = randomUUID(),
        handler = randomUUID(),
        reviewer = randomUUID();
      const followup = randomUUID();
      const purpose = 'synthetic-candidate-followup-test';
      let actorId: string = creator,
        actorType = 'human',
        delegatedBy: string | null = null;
      const actor = () => ({ actorId, actorType, delegatedBy, purpose });
      const setActor = async (
        id: string,
        type = 'human',
        delegate: string | null = null,
      ) => {
        actorId = id;
        actorType = type;
        delegatedBy = delegate;
        await client.query('set local role wiser_data_api');
        await client.query(
          "select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type',$2,true),set_config('wiser.delegated_by',$3,true),set_config('wiser.purpose',$4,true),set_config('wiser.candidate_purpose',$4,true),set_config('wiser.candidate_maintainer','true',true),set_config('wiser.candidate_reviewer','true',true),set_config('wiser.candidate_view_deadline',(clock_timestamp()+interval '1 hour')::text,true),set_config('wiser.resource_scope','',true)",
          [id, type, delegate ?? '', purpose],
        );
      };
      const append = async (
        action: string,
        expectedVersion: number,
        options: {
          target?: unknown;
          evidence?: unknown[];
          correction?: unknown;
          key?: string;
          fingerprint?: string;
        } = {},
      ) => {
        const id = randomUUID(),
          key = options.key ?? randomUUID();
        const fingerprint =
          options.fingerprint ??
          createHash('sha256')
            .update(
              JSON.stringify({
                action,
                expectedVersion,
                actor: actor(),
                ...options,
              }),
            )
            .digest('hex');
        return client.query(
          `insert into ingestion.candidate_followup_event(event_id,tenant_id,project_id,followup_id,expected_version,row_version,action,actor_id,actor_type,delegated_by,purpose,target,evidence,correction,note,idempotency_key,request_fingerprint,state_after,assignee_after,evidence_after,responsibilities_after)
           values($1,$2,$3,$4,$5,$5+1,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,'synthetic technical action',$14,decode($15,'hex'),'OPEN',null,'[]','[]') returning event_id,row_version,state_after,actor_id`,
          [
            id,
            tenant,
            project,
            followup,
            expectedVersion,
            action,
            actorId,
            actorType,
            delegatedBy,
            purpose,
            options.target === undefined
              ? null
              : JSON.stringify(options.target),
            JSON.stringify(options.evidence ?? []),
            options.correction === undefined
              ? null
              : JSON.stringify(options.correction),
            key,
            fingerprint,
          ],
        );
      };
      try {
        await client.query('begin');
        await client.query(
          "select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L0_PUBLIC',true),set_config('wiser.policy_version','1',true)",
          [tenant, project],
        );
        await client.query(
          "insert into ingestion.project_review_policy(tenant_id,project_id,mode,revision) values($1,$2,'REQUIRE_INDEPENDENT_REVIEW',1)",
          [tenant, project],
        );
        const original = await freezeFollowupSource(
          client,
          tenant,
          project,
          creator,
          0,
        );
        const replacement = await freezeFollowupSource(
          client,
          tenant,
          project,
          handler,
          1,
        );
        await setActor(creator);
        const insertRoot = (source: unknown) =>
          client.query(
            `insert into ingestion.candidate_followup(followup_id,tenant_id,project_id,type,source,rule_id,rule_version,reason,created_by_actor_id,created_actor_type,purpose,security_level,policy_version)
           values($1,$2,$3,'CORRECTION',$4::jsonb,'synthetic-whole-record','1','synthetic correction only',$5,'human',$6,'L0_PUBLIC',1)`,
            [
              followup,
              tenant,
              project,
              JSON.stringify(source),
              creator,
              purpose,
            ],
          );
        for (const wrong of [
          { ...original.evidence, sourceHash: '0'.repeat(64) },
          { ...original.evidence, locator: 'table:1/row:2' },
          { ...original.evidence, sourceCrs: 'EPSG:3857' },
          {
            ...original.evidence,
            geometry: { type: 'Point', coordinates: [2, 2] },
          },
          {
            ...original.evidence,
            reference: { ...original.reference, reviewHash: '0'.repeat(64) },
          },
        ])
          await deniedFollowup(client, () => insertRoot(wrong));
        await insertRoot(original.evidence);
        await deniedFollowup(client, () =>
          client.query('set constraints all immediate'),
        );
        await append('CREATE', 0);
        await client.query('set constraints all immediate');
        await deniedFollowup(client, () =>
          client.query(
            "update ingestion.candidate_followup set state='CLOSED',row_version=2 where followup_id=$1",
            [followup],
          ),
        );
        await deniedFollowup(client, () =>
          client.query(
            'delete from ingestion.candidate_followup where followup_id=$1',
            [followup],
          ),
        );
        await append('CLAIM', 1);
        const caseOnlyEvidence = {
          ...original.evidence,
          reference: {
            ...original.evidence.reference,
            ingestionId: original.evidence.reference.ingestionId.toUpperCase(),
            processingBatchId:
              original.evidence.reference.processingBatchId.toUpperCase(),
          },
          assetId: original.evidence.assetId.toUpperCase(),
          recordId: original.evidence.recordId.toUpperCase(),
        };
        expect(caseOnlyEvidence.locator).toBe(original.evidence.locator);
        await deniedFollowup(client, () =>
          append('SUPPLEMENT', 2, {
            evidence: [caseOnlyEvidence],
            correction: {
              scope: 'WHOLE_RECORD',
              old: original.evidence,
              new: caseOnlyEvidence,
              mappingReason: 'Only UUID spelling changed',
            },
          }),
        );
        const samePageTwice = {
          ...replacement.evidence,
          assetId: replacement.evidence.assetId.toUpperCase(),
          reference: {
            ...replacement.evidence.reference,
            ingestionId:
              replacement.evidence.reference.ingestionId.toUpperCase(),
            processingBatchId:
              replacement.evidence.reference.processingBatchId.toUpperCase(),
          },
        };
        await deniedFollowup(client, () =>
          append('SUPPLEMENT', 2, {
            evidence: [replacement.evidence, samePageTwice],
            correction: {
              scope: 'WHOLE_RECORD',
              old: original.evidence,
              new: replacement.evidence,
              mappingReason: 'Duplicate spelling in one event',
            },
          }),
        );
        expect(
          (
            await client.query(
              'select row_version,evidence from ingestion.candidate_followup where followup_id=$1',
              [followup],
            )
          ).rows[0],
        ).toMatchObject({ row_version: 2, evidence: [] });
        const target = {
          actorId: handler,
          actorType: 'human',
          delegatedBy: null,
          purpose,
        };
        const targetContext = {
          ...target,
          deadline: new Date(Date.now() + 60_000).toISOString(),
          maxSecurityLevel: 'L0_PUBLIC',
          policyVersion: 1,
          maintainer: true,
          reviewer: true,
          resourceScope: null,
        };
        await client.query(
          "select set_config('wiser.candidate_followup_target_context',$1,true)",
          [JSON.stringify({ ...targetContext, maintainer: false })],
        );
        await deniedFollowup(client, () => append('HANDOFF', 2, { target }));
        await client.query(
          "select set_config('wiser.candidate_followup_target_context',$1,true)",
          [JSON.stringify(targetContext)],
        );
        await append('HANDOFF', 2, { target });
        expect(
          (
            await client.query(
              "select current_setting('wiser.actor_id',true) actor,current_setting('wiser.actor_type',true) type,current_setting('wiser.resource_scope',true) scope,current_setting('wiser.candidate_fixed_refs',true) refs",
            )
          ).rows[0],
        ).toEqual({ actor: creator, type: 'human', scope: '', refs: '' });
        await setActor(handler);
        const correction = {
          scope: 'WHOLE_RECORD',
          old: original.evidence,
          new: replacement.evidence,
          mappingReason: 'synthetic received replacement',
        };
        await deniedFollowup(client, () =>
          append('SUPPLEMENT', 3, {
            evidence: [replacement.evidence],
            correction: { ...correction, old: replacement.evidence },
          }),
        );
        await append('SUPPLEMENT', 3, {
          evidence: [replacement.evidence],
          correction,
        });
        await deniedFollowup(client, () =>
          append('SUPPLEMENT', 4, {
            evidence: [replacement.evidence],
            correction,
          }),
        );
        await deniedFollowup(client, () => append('SUBMIT_REVIEW', 3), '40001');
        await append('SUBMIT_REVIEW', 4);
        for (const participant of [creator, handler]) {
          await setActor(participant);
          await deniedFollowup(client, () => append('CLOSE', 5));
        }
        for (const type of ['agent', 'service']) {
          await setActor(randomUUID(), type, reviewer);
          await deniedFollowup(client, () => append('CLOSE', 5));
        }
        await setActor(reviewer);
        await append('CLOSE', 5);
        await deniedFollowup(client, () =>
          client.query(
            "update ingestion.candidate_followup_event set note='changed' where followup_id=$1",
            [followup],
          ),
        );
        await deniedFollowup(client, () =>
          client.query(
            'delete from ingestion.candidate_followup_event where followup_id=$1',
            [followup],
          ),
        );
        await setActor(handler);
        await append('REOPEN', 6);
        const claimKey = randomUUID();
        const claimFingerprint = createHash('sha256')
          .update('synthetic exact claim fingerprint')
          .digest('hex');
        await append('CLAIM', 7, {
          key: claimKey,
          fingerprint: claimFingerprint,
        });
        await deniedFollowup(client, () =>
          append('CLAIM', 7, { key: claimKey, fingerprint: '0'.repeat(64) }),
        );
        await deniedFollowup(
          client,
          () =>
            append('CLAIM', 7, {
              key: claimKey,
              fingerprint: claimFingerprint,
            }),
          '40001',
        );
        await append('SUBMIT_REVIEW', 8);
        await setActor(reviewer);
        await append('RETURN', 9);
        const snapshot = (
          await client.query<{
            state: string;
            row_version: number;
            source: unknown;
            evidence: unknown[];
            responsibilities: unknown[];
          }>(
            'select state,row_version,source,evidence,responsibilities from ingestion.candidate_followup where followup_id=$1',
            [followup],
          )
        ).rows[0]!;
        expect(snapshot).toMatchObject({
          state: 'WORKING',
          row_version: 10,
          source: original.evidence,
          evidence: [replacement.evidence],
        });
        expect(snapshot.responsibilities).toEqual(
          expect.arrayContaining([
            { actorId: creator, actorType: 'human', delegatedBy: null },
            { actorId: handler, actorType: 'human', delegatedBy: null },
            {
              actorId: creator,
              actorType: 'human',
              delegatedBy: null,
              purpose,
            },
            {
              actorId: handler,
              actorType: 'human',
              delegatedBy: null,
              purpose,
            },
          ]),
        );
        expect(
          (
            await client.query<{ action: string }>(
              'select action from ingestion.candidate_followup_event where followup_id=$1 order by row_version',
              [followup],
            )
          ).rows.map((row) => row.action),
        ).toEqual([
          'CREATE',
          'CLAIM',
          'HANDOFF',
          'SUPPLEMENT',
          'SUBMIT_REVIEW',
          'CLOSE',
          'REOPEN',
          'CLAIM',
          'SUBMIT_REVIEW',
          'RETURN',
        ]);
        for (const guard of [
          "select set_config('wiser.project_id','00000000-0000-4000-8000-000000000001',true)",
          "select set_config('wiser.purpose','other-purpose',true)",
          "select set_config('wiser.candidate_view_deadline','2000-01-01T00:00:00Z',true)",
          "select set_config('wiser.candidate_maintainer','false',true),set_config('wiser.candidate_reviewer','false',true)",
        ]) {
          await client.query('savepoint source_guard');
          await client.query(guard);
          expect(
            (
              await client.query(
                'select followup_id from ingestion.candidate_followup where followup_id=$1',
                [followup],
              )
            ).rows,
          ).toEqual([]);
          expect(
            (
              await client.query(
                'select event_id from ingestion.candidate_followup_event where followup_id=$1',
                [followup],
              )
            ).rows,
          ).toEqual([]);
          await client.query('rollback to savepoint source_guard');
        }
        await client.query('savepoint cancelled_supplement');
        await client.query('reset role');
        await client.query(
          "update ingestion.session set state='CANCELLED',row_version=row_version+1 where ingestion_id=$1",
          [replacement.reference.ingestionId],
        );
        await setActor(reviewer);
        expect(
          (
            await client.query(
              'select processing_batch_id from ingestion.candidate_batch where processing_batch_id=$1',
              [original.reference.processingBatchId],
            )
          ).rows,
        ).toHaveLength(1);
        expect(
          (
            await client.query(
              'select followup_id from ingestion.candidate_followup where followup_id=$1',
              [followup],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(
              'select event_id from ingestion.candidate_followup_event where followup_id=$1',
              [followup],
            )
          ).rows,
        ).toEqual([]);
        await client.query('rollback to savepoint cancelled_supplement');
        await client.query('reset role');
        expect(
          (
            await client.query(
              'select state from ingestion.session where tenant_id=$1 and project_id=$2 order by ingestion_id',
              [tenant, project],
            )
          ).rows,
        ).toEqual([{ state: 'REVIEW_REQUIRED' }, { state: 'REVIEW_REQUIRED' }]);
        expect(
          (
            await client.query(
              'select count(*)::integer count from knowledge.assertion_binding where tenant_id=$1 and project_id=$2',
              [tenant, project],
            )
          ).rows[0],
        ).toEqual({ count: 0 });
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'rejects a source-only delegator even when that person never creates, claims or receives the followup',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      const tenant = randomUUID(),
        project = randomUUID(),
        creator = randomUUID(),
        sourceAgent = randomUUID(),
        sourceDelegate = randomUUID(),
        reviewer = randomUUID(),
        followup = randomUUID();
      const purpose = 'synthetic-candidate-followup-test';
      let currentActor: string = creator;
      const setActor = async (id: string, maintainer: boolean) => {
        currentActor = id;
        await client.query('set local role wiser_data_api');
        await client.query(
          "select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type','human',true),set_config('wiser.delegated_by','',true),set_config('wiser.purpose',$2,true),set_config('wiser.candidate_purpose',$2,true),set_config('wiser.candidate_maintainer',$3,true),set_config('wiser.candidate_reviewer','true',true),set_config('wiser.candidate_view_deadline',(clock_timestamp()+interval '1 hour')::text,true),set_config('wiser.resource_scope','',true)",
          [id, purpose, String(maintainer)],
        );
      };
      const append = (
        action: string,
        version: number,
        evidence: unknown[] = [],
      ) =>
        client.query(
          `insert into ingestion.candidate_followup_event(event_id,tenant_id,project_id,followup_id,expected_version,row_version,action,actor_id,actor_type,purpose,evidence,note,idempotency_key,request_fingerprint,state_after,evidence_after,responsibilities_after)
         values($1,$2,$3,$4,$5,$5+1,$6,$7,'human',$8,$9::jsonb,'synthetic source responsibility',$10,decode($11,'hex'),'OPEN','[]','[]')`,
          [
            randomUUID(),
            tenant,
            project,
            followup,
            version,
            action,
            currentActor,
            purpose,
            JSON.stringify(evidence),
            randomUUID(),
            createHash('sha256')
              .update(
                JSON.stringify({ action, version, currentActor, evidence }),
              )
              .digest('hex'),
          ],
        );
      try {
        await client.query('begin');
        await client.query(
          "select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L0_PUBLIC',true),set_config('wiser.policy_version','1',true)",
          [tenant, project],
        );
        await client.query(
          "insert into ingestion.project_review_policy(tenant_id,project_id,mode,revision) values($1,$2,'REQUIRE_INDEPENDENT_REVIEW',1)",
          [tenant, project],
        );
        const source = await freezeFollowupSource(
          client,
          tenant,
          project,
          sourceAgent,
          0,
          'agent',
          sourceDelegate,
        );
        const added = await freezeFollowupSource(
          client,
          tenant,
          project,
          creator,
          1,
        );
        await setActor(creator, true);
        await client.query(
          `insert into ingestion.candidate_followup(followup_id,tenant_id,project_id,type,source,rule_id,rule_version,reason,created_by_actor_id,created_actor_type,purpose,security_level,policy_version)
           values($1,$2,$3,'GAP',$4::jsonb,'synthetic-source-owner','1','synthetic missing material',$5,'human',$6,'L0_PUBLIC',1)`,
          [
            followup,
            tenant,
            project,
            JSON.stringify(source.evidence),
            creator,
            purpose,
          ],
        );
        await append('CREATE', 0);
        await append('CLAIM', 1);
        await append('SUPPLEMENT', 2, [added.evidence]);
        await append('SUBMIT_REVIEW', 3);
        await setActor(sourceDelegate, true);
        const responsibility = (
          await client.query<{
            responsibilities: {
              actorId: string;
              actorType: string;
              delegatedBy: string | null;
            }[];
          }>(
            'select responsibilities from ingestion.candidate_followup where followup_id=$1',
            [followup],
          )
        ).rows[0]!.responsibilities;
        expect(responsibility).toEqual(
          expect.arrayContaining([
            {
              actorId: sourceAgent,
              actorType: 'agent',
              delegatedBy: sourceDelegate,
            },
          ]),
        );
        expect(
          responsibility.some((item) => item.actorId === sourceDelegate),
        ).toBe(false);
        await deniedFollowup(client, () => append('CLOSE', 4));
        await setActor(reviewer, false);
        await append('CLOSE', 4);
        await client.query('set constraints all immediate');
        expect(
          (
            await client.query(
              'select state,row_version from ingestion.candidate_followup where followup_id=$1',
              [followup],
            )
          ).rows,
        ).toEqual([{ state: 'CLOSED', row_version: 5 }]);
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
});

/** Committed synthetic fixtures require a disposable database without consumers. */
describe('private candidate followup native PostgreSQL concurrency', () => {
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'serializes same-version claims and same-key retries across two connections without duplicate history',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 2,
        connectionTimeoutMillis: 5_000,
      });
      const clients: PoolClient[] = [];
      try {
        const winner = await pool.connect();
        clients.push(winner);
        const contender = await pool.connect();
        clients.push(contender);
        const tenant = randomUUID(),
          project = randomUUID(),
          creator = randomUUID(),
          otherMaintainer = randomUUID();
        const purpose = 'synthetic-candidate-followup-test';
        const followups = [randomUUID(), randomUUID()];
        const setScope = async (client: PoolClient, actor: string) => {
          await client.query('set local role wiser_data_api');
          await client.query(
            "select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L0_PUBLIC',true),set_config('wiser.policy_version','1',true),set_config('wiser.actor_id',$3,true),set_config('wiser.actor_type','human',true),set_config('wiser.delegated_by','',true),set_config('wiser.purpose',$4,true),set_config('wiser.candidate_purpose',$4,true),set_config('wiser.candidate_maintainer','true',true),set_config('wiser.candidate_reviewer','true',true),set_config('wiser.candidate_view_deadline',(clock_timestamp()+interval '1 hour')::text,true),set_config('wiser.resource_scope','',true)",
            [tenant, project, actor, purpose],
          );
        };
        const append = (
          client: PoolClient,
          followup: string,
          actor: string,
          action: 'CREATE' | 'CLAIM',
          version: number,
          key: string,
          fingerprint: string,
        ) =>
          client.query(
            `insert into ingestion.candidate_followup_event(event_id,tenant_id,project_id,followup_id,expected_version,row_version,action,actor_id,actor_type,purpose,evidence,note,idempotency_key,request_fingerprint,state_after,evidence_after,responsibilities_after)
             values($1,$2,$3,$4,$5,$5+1,$6,$7,'human',$8,'[]','Synthetic concurrent claim',$9,decode($10,'hex'),'OPEN','[]','[]')`,
            [
              randomUUID(),
              tenant,
              project,
              followup,
              version,
              action,
              actor,
              purpose,
              key,
              fingerprint,
            ],
          );
        await winner.query('begin');
        await winner.query("set local statement_timeout='5s'");
        await winner.query(
          "select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L0_PUBLIC',true),set_config('wiser.policy_version','1',true)",
          [tenant, project],
        );
        await winner.query(
          "insert into ingestion.project_review_policy(tenant_id,project_id,mode,revision) values($1,$2,'REQUIRE_INDEPENDENT_REVIEW',1)",
          [tenant, project],
        );
        const source = await freezeFollowupSource(
          winner,
          tenant,
          project,
          creator,
          0,
        );
        await setScope(winner, creator);
        for (const followup of followups) {
          await winner.query(
            `insert into ingestion.candidate_followup(followup_id,tenant_id,project_id,type,source,rule_id,rule_version,reason,created_by_actor_id,created_actor_type,purpose,security_level,policy_version)
             values($1,$2,$3,'GAP',$4::jsonb,'synthetic-concurrency','1','Synthetic missing material',$5,'human',$6,'L0_PUBLIC',1)`,
            [
              followup,
              tenant,
              project,
              JSON.stringify(source.evidence),
              creator,
              purpose,
            ],
          );
          await append(
            winner,
            followup,
            creator,
            'CREATE',
            0,
            randomUUID(),
            createHash('sha256').update(`create:${followup}`).digest('hex'),
          );
        }
        await winner.query('set constraints all immediate');
        // A rollback-only fixture would be invisible to the second backend.
        await winner.query('commit');

        for (const [index, followup] of followups.entries()) {
          const key = randomUUID();
          const fingerprint = createHash('sha256')
            .update(`claim:${followup}:${creator}`)
            .digest('hex');
          const sameKey = index === 1;
          for (const [client, actor] of [
            [winner, creator],
            [contender, sameKey ? creator : otherMaintainer],
          ] as const) {
            await client.query('begin isolation level read committed');
            await client.query("set local statement_timeout='5s'");
            await client.query(
              "set local idle_in_transaction_session_timeout='10s'",
            );
            await setScope(client, actor);
          }
          await commitAfterAdvisoryWait(
            winner,
            contender,
            () =>
              append(winner, followup, creator, 'CLAIM', 1, key, fingerprint),
            () =>
              append(
                contender,
                followup,
                sameKey ? creator : otherMaintainer,
                'CLAIM',
                1,
                sameKey ? key : randomUUID(),
                sameKey
                  ? fingerprint
                  : createHash('sha256')
                      .update(`other:${followup}`)
                      .digest('hex'),
              ),
          );
          await winner.query('begin');
          await winner.query("set local statement_timeout='5s'");
          await setScope(winner, creator);
          expect(
            (
              await winner.query(
                'select state,row_version,assignee from ingestion.candidate_followup where followup_id=$1',
                [followup],
              )
            ).rows,
          ).toEqual([
            {
              state: 'WORKING',
              row_version: 2,
              assignee: {
                actorId: creator,
                actorType: 'human',
                delegatedBy: null,
                purpose,
              },
            },
          ]);
          expect(
            (
              await winner.query(
                'select action,expected_version,row_version,actor_id,idempotency_key from ingestion.candidate_followup_event where followup_id=$1 order by row_version',
                [followup],
              )
            ).rows,
          ).toEqual([
            expect.objectContaining({
              action: 'CREATE',
              expected_version: 0,
              row_version: 1,
            }),
            {
              action: 'CLAIM',
              expected_version: 1,
              row_version: 2,
              actor_id: creator,
              idempotency_key: key,
            },
          ]);
          if (sameKey) {
            await deniedFollowup(winner, () =>
              append(
                winner,
                followup,
                creator,
                'CLAIM',
                1,
                key,
                '0'.repeat(64),
              ),
            );
          }
          await winner.query('rollback');
        }
      } finally {
        for (const client of clients) {
          await client.query('rollback').catch(() => undefined);
          client.release();
        }
        await pool.end();
      }
    },
    20_000,
  );
});
