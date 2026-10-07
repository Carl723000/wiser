import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

async function denied(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
  code = '42501',
) {
  await client.query('savepoint relation_denied');
  await expect(client.query(sql, [...values])).rejects.toMatchObject({ code });
  await client.query('rollback to savepoint relation_denied');
}

/** Real schema fixture only: leased synthetic rows, no real source or approval. */
async function freezeRelationSource(
  client: PoolClient,
  tenant: string,
  project: string,
  actor: string,
) {
  const ingestion = randomUUID(),
    asset = randomUUID(),
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
    "select set_config('wiser.resource_scope','',true),set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type','human',true),set_config('wiser.delegated_by','',true)",
    [actor],
  );
  await client.query(
    `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload)
 values($1,$2,$3,'data.ingestion.submit',$4,'RUNNING','L0_PUBLIC','{}')`,
    [ingestion, tenant, project, actor],
  );
  await client.query(
    `insert into ingestion.session(ingestion_id,tenant_id,project_id,operation_id,owner_project_id,state,intended_uses,requested_security_level,security_level,submitted_by_actor_id,submitted_actor_type)
 values($1,$2,$3,$1,$3,'SPATIOTEMPORAL_ALIGNED',array['synthetic-candidate-relation-test'],'L0_PUBLIC','L0_PUBLIC',$4,'human')`,
    [ingestion, tenant, project, actor],
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
 values($1,$2,$3,$4,$4,'data.ingestion.process','RUNNING',$1::uuid::text,$5::jsonb,'candidate-relation-sql',clock_timestamp()+interval '5 minutes',1,clock_timestamp()+interval '1 hour','L0_PUBLIC')`,
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
    "select set_config('wiser.candidate_job_id',$1,true),set_config('wiser.candidate_job_owner','candidate-relation-sql',true),set_config('wiser.candidate_job_attempt','1',true)",
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
    `insert into ingestion.candidate_record(processing_batch_id,record_id,asset_id,tenant_id,project_id,record_index,source_id,record_values,security_level,policy_version)
 values($1,$2,$3,$4,$5,1,'table:1/row:1','{"c1":"synthetic"}','L0_PUBLIC',1)`,
    [batch, record, asset, tenant, project],
  );
  await client.query(
    `update ingestion.candidate_asset set status='READY',record_count=1,feature_count=0,columns='[{"key":"c1","label":"c1"}]' where processing_batch_id=$1`,
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
  };
}

/** Actual migrated disposable PG only. Skips are not SQL/RLS acceptance. */
describe('private candidate relation carrier PostgreSQL authority', () => {
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'restores API append-only and no Worker/shared access after repeated provisioning',
    async () => {
      const pool = new Pool({
          connectionString: process.env['DATA_TEST_DATABASE_URL'],
          max: 1,
        }),
        client = await pool.connect();
      try {
        await client.query('begin');
        const sql = readFileSync(
          new URL(
            '../../../../infrastructure/data-foundation/postgres/provision-runtime.sql',
            import.meta.url,
          ),
          'utf8',
        );
        const start = sql.indexOf(
            "if to_regclass('ingestion.candidate_relation_revision') is not null then",
          ),
          end = sql.indexOf('end if;', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        for (let pass = 0; pass < 2; pass++) {
          await client.query(
            'grant select,insert,update on ingestion.candidate_relation_revision,ingestion.candidate_relation_evidence,ingestion.candidate_relation_responsibility,ingestion.candidate_relation_decision to wiser_data_runtime',
          );
          await client.query(
            `do $$ begin ${sql.slice(start, end + 7)} end $$;`,
          );
          for (const table of [
            'candidate_relation_revision',
            'candidate_relation_evidence',
            'candidate_relation_responsibility',
            'candidate_relation_decision',
          ])
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
            }
        }
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'retains immutable content/source responsibility and separate independent decisions with current-authority RLS',
    async () => {
      const pool = new Pool({
          connectionString: process.env['DATA_TEST_DATABASE_URL'],
          max: 1,
        }),
        client = await pool.connect();
      const tenant = randomUUID(),
        project = randomUUID(),
        sourceActor = randomUUID(),
        proposer = randomUUID(),
        reviewer = randomUUID();
      const relation = randomUUID(),
        lineage = randomUUID(),
        revision = randomUUID();
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
        const source = await freezeRelationSource(
          client,
          tenant,
          project,
          sourceActor,
        );
        const sourceHash = (
          await client.query<{ hash: string }>(
            "select encode(source_hash,'hex') hash from ingestion.candidate_asset where processing_batch_id=$1 and asset_id=$2",
            [source.reference.processingBatchId, source.asset],
          )
        ).rows[0]!['hash'];
        const content = {
          subject: {
            key: 'upstream',
            label: 'Synthetic upstream',
            kind: 'EXTERNAL_ENTITY',
            externalId: null,
          },
          predicate: 'FLOWS_TO',
          object: {
            key: 'downstream',
            label: 'Synthetic downstream',
            kind: 'EXTERNAL_ENTITY',
            externalId: null,
          },
          qualifiers: {
            measure: null,
            reportedValue: '',
            reportedLimit: null,
            unit: null,
            observedAt: null,
            missing: false,
            spatialScope: null,
            limitations: [],
            reportedConclusion: null,
            context: {
              recordNature: 'SOURCE_RELATION',
              timeRole: 'PUBLICATION_TIME',
              validFrom: null,
              validTo: null,
              locationRole: 'REFERENCE_LOCATION',
              applicability: 'Watercourse background only',
            },
          },
          generation: { method: 'SOURCE_FIELDS', model: null },
          evidence: [
            {
              reference: source.reference,
              assetId: source.asset,
              recordId: source.record,
              sourceHash,
              locator: 'table:1/row:1',
              excerpt: 'synthetic',
              polarity: 'SUPPORTS',
            },
          ],
        };
        const insert = `insert into ingestion.candidate_relation_revision(revision_id,tenant_id,project_id,relation_id,lineage_id,revision,supersedes_id,ingestion_id,processing_batch_id,review_hash,mapping_version,rule_version,content,submitted_by_actor_id,submitted_actor_type,purpose,security_level,policy_version)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'),'synthetic-map/1','candidate-relations/1',$11::jsonb,$12,'human','candidate-review','L0_PUBLIC',1)`;
        const values = [
          revision,
          tenant,
          project,
          relation,
          lineage,
          1,
          null,
          source.reference.ingestionId,
          source.reference.processingBatchId,
          source.reference.reviewHash,
          JSON.stringify(content),
          proposer,
        ];
        const setActor = async (
          actor: string,
          maintainer: boolean,
          independent: boolean,
          type = 'human',
          delegate = '',
        ) => {
          await client.query('reset role');
          await client.query(
            `select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type',$2,true),set_config('wiser.delegated_by',$3,true),set_config('wiser.candidate_maintainer',$4,true),set_config('wiser.candidate_reviewer',$5,true),set_config('wiser.purpose','candidate-review',true),set_config('wiser.candidate_purpose','candidate-review',true),set_config('wiser.candidate_view_deadline','infinity',true),set_config('wiser.resource_scope','',true)`,
            [actor, type, delegate, String(maintainer), String(independent)],
          );
          await client.query('set local role wiser_data_api');
        };
        await setActor(proposer, true, true);
        await client.query(insert, values);
        expect(
          (
            await client.query<{ count: number }>(
              'select count(*)::integer count from ingestion.candidate_relation_evidence where revision_id=$1',
              [revision],
            )
          ).rows[0]!['count'],
        ).toBe(1);
        expect(
          (
            await client.query(
              'select responsibility_kind,actor_id from ingestion.candidate_relation_responsibility where revision_id=$1 order by responsibility_kind',
              [revision],
            )
          ).rows,
        ).toEqual([
          { responsibility_kind: 'RELATION', actor_id: proposer },
          { responsibility_kind: 'SOURCE', actor_id: sourceActor },
        ]);
        const decision = `insert into ingestion.candidate_relation_decision(tenant_id,project_id,revision_id,decision_version,decision,actor_id,actor_type,purpose,rationale) values($1,$2,$3,$4,$5,$6,'human','candidate-review','Synthetic independent review')`;
        const decisionValues = [
          tenant,
          project,
          revision,
          1,
          'CONFIRMED',
          proposer,
        ];
        await denied(client, decision, decisionValues); // Relation submitter can read the source but cannot decide.
        await setActor(sourceActor, true, true);
        await denied(client, decision, [
          ...decisionValues.slice(0, 5),
          sourceActor,
        ]); // Frozen source submitter is also excluded.
        await setActor(reviewer, false, true);
        await client.query(decision, [...decisionValues.slice(0, 5), reviewer]);
        await denied(
          client,
          decision,
          [tenant, project, revision, 1, 'REVOKED', reviewer],
          '40001',
        );
        await denied(client, decision, [
          tenant,
          project,
          revision,
          2,
          'REJECTED',
          reviewer,
        ]);
        await client.query(decision, [
          tenant,
          project,
          revision,
          2,
          'REVOKED',
          reviewer,
        ]);
        expect(
          (
            await client.query(
              'select decision_version,decision from ingestion.candidate_relation_decision where revision_id=$1 order by decision_version',
              [revision],
            )
          ).rows,
        ).toEqual([
          { decision_version: 1, decision: 'CONFIRMED' },
          { decision_version: 2, decision: 'REVOKED' },
        ]);
        await client.query(
          "select set_config('wiser.candidate_reviewer','false',true)",
        );
        expect(
          (
            await client.query<{ count: number }>(
              'select count(*)::integer count from ingestion.candidate_relation_revision where revision_id=$1',
              [revision],
            )
          ).rows[0]!['count'],
        ).toBe(0);
        for (const table of [
          'candidate_relation_evidence',
          'candidate_relation_responsibility',
          'candidate_relation_decision',
        ])
          expect(
            (
              await client.query<{ count: number }>(
                `select count(*)::integer count from ingestion.${table} where revision_id=$1`,
                [revision],
              )
            ).rows[0]!['count'],
          ).toBe(0);
        await setActor(proposer, true, true);
        const withdrawn = randomUUID(),
          otherRelation = randomUUID();
        await client.query(insert, [
          withdrawn,
          tenant,
          project,
          otherRelation,
          randomUUID(),
          1,
          null,
          ...values.slice(7),
        ]);
        await client.query(decision, [
          tenant,
          project,
          withdrawn,
          1,
          'WITHDRAWN',
          proposer,
        ]);
        const nextRevision = randomUUID();
        await client.query(insert, [
          nextRevision,
          tenant,
          project,
          relation,
          lineage,
          2,
          revision,
          ...values.slice(7),
        ]);
        expect(
          (
            await client.query<{ count: number }>(
              'select count(*)::integer count from ingestion.candidate_relation_decision where revision_id=$1',
              [nextRevision],
            )
          ).rows[0]!['count'],
        ).toBe(0);
        await denied(client, insert, [
          randomUUID(),
          tenant,
          project,
          relation,
          lineage,
          3,
          revision,
          ...values.slice(7),
        ]);
        const falseEvidence = structuredClone(content);
        falseEvidence.evidence[0]!.sourceHash = '0'.repeat(64);
        await denied(client, insert, [
          randomUUID(),
          tenant,
          project,
          randomUUID(),
          randomUUID(),
          1,
          null,
          ...values.slice(7, 10),
          JSON.stringify(falseEvidence),
          proposer,
        ]);
        await client.query('reset role');
        await client.query(
          'grant update,delete on ingestion.candidate_relation_revision,ingestion.candidate_relation_evidence,ingestion.candidate_relation_responsibility,ingestion.candidate_relation_decision to wiser_data_api',
        );
        await client.query('set local role wiser_data_api');
        // No UPDATE/DELETE RLS policies: even accidental grants cannot alter history.
        for (const table of [
          'candidate_relation_revision',
          'candidate_relation_evidence',
          'candidate_relation_responsibility',
          'candidate_relation_decision',
        ]) {
          expect(
            (
              await client.query(
                `delete from ingestion.${table} where revision_id=$1 returning revision_id`,
                [revision],
              )
            ).rows,
          ).toHaveLength(0);
        }
        await client.query(
          "select set_config('wiser.candidate_view_deadline','2000-01-01T00:00:00Z',true)",
        );
        expect(
          (
            await client.query<{ count: number }>(
              'select count(*)::integer count from ingestion.candidate_relation_revision where revision_id=$1',
              [revision],
            )
          ).rows[0]!['count'],
        ).toBe(0);
        await setActor(reviewer, false, true, 'agent', proposer);
        await denied(client, decision, [
          tenant,
          project,
          nextRevision,
          1,
          'CONFIRMED',
          reviewer,
        ]);
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
});
