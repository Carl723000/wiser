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
  await client.query('savepoint conversion_denied');
  await expect(client.query(sql, [...values])).rejects.toMatchObject({ code });
  await client.query('rollback to savepoint conversion_denied');
}

// Real migrated PostgreSQL only. This file is skipped by unit runs and cannot be
// cited as SQL/RLS acceptance until the isolated integration harness executes it.
describe('private conversion trust PostgreSQL authority', () => {
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'restores API-read-only and Worker-insert-only privileges after repeated runtime provisioning',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const provision = readFileSync(
          new URL(
            '../../../../infrastructure/data-foundation/postgres/provision-runtime.sql',
            import.meta.url,
          ),
          'utf8',
        );
        const start = provision.indexOf(
          "if to_regclass('ingestion.candidate_conversion_check') is not null then",
        );
        const end = provision.indexOf('end if;', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const exactBlock = `do $$ begin ${provision.slice(start, end + 7)} end $$;`;
        for (let pass = 0; pass < 2; pass++) {
          // Reproduce the generic inherited table grants before running the
          // exact scoped exception, without invoking a credential-bearing CLI.
          await client.query(
            'grant select,insert,update on ingestion.candidate_conversion_check to wiser_data_runtime',
          );
          await client.query(exactBlock);
          for (const [role, reads, inserts] of [
            ['wiser_data_runtime', false, false],
            ['wiser_data_api', true, false],
            ['wiser_data_worker', true, true],
            ['wiser_data_metadata', false, false],
            ['wiser_data_gis', false, false],
          ] as const) {
            expect(
              (
                await client.query(
                  "select has_table_privilege($1,'ingestion.candidate_conversion_check','SELECT') reads,has_table_privilege($1,'ingestion.candidate_conversion_check','INSERT') inserts,has_table_privilege($1,'ingestion.candidate_conversion_check','UPDATE') updates,has_table_privilege($1,'ingestion.candidate_conversion_check','DELETE') deletes,has_table_privilege($1,'ingestion.candidate_conversion_check','TRUNCATE') truncates",
                  [role],
                )
              ).rows[0],
            ).toEqual({
              reads,
              inserts,
              updates: false,
              deletes: false,
              truncates: false,
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
    'requires one frozen batch, actual members, current lease and immutable responsibility, and commits with completion',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      const tenant = randomUUID(),
        project = randomUUID(),
        ingestion = randomUUID(),
        actor = randomUUID(),
        other = randomUUID(),
        plan = randomUUID(),
        job = randomUUID(),
        batch = randomUUID(),
        resultId = randomUUID();
      const members = ['O', 'P', 'manifest'].map((name, ordinal) => ({
        assetId: randomUUID(),
        blobId: randomUUID(),
        sourceHash: createHash('sha256')
          .update(`synthetic-conversion-${name}`)
          .digest('hex'),
        size: 28,
        mediaType:
          ordinal === 0
            ? 'application/msword'
            : ordinal === 1
              ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              : 'application/json',
        ordinal,
        quarantineObjectRef: `synthetic/conversion/${name}`,
      }));
      const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
      const frozenBase = {
        assetIds: members.map((member) => member.assetId),
        assetManifest: { reviewGovernance: policy, assets: members },
        quality: {},
        alignment: {},
      };
      const reviewHash = createHash('sha256')
        .update(JSON.stringify(frozenBase))
        .digest('hex');
      const summary = {
        tableCount: 1,
        physicalCellCount: 1,
        emptyCellCount: 0,
        paragraphCount: 1,
        monthTitleCount: 1,
        differenceCount: 0,
        differences: [],
      };
      const insert = `insert into ingestion.candidate_conversion_check(result_id,tenant_id,project_id,processing_batch_id,ingestion_id,review_hash,original_asset_id,original_hash,original_byte_size,prepared_asset_id,prepared_hash,prepared_byte_size,manifest_asset_id,manifest_hash,source_local_work_id,result_kind,result_state,rule_id,rule_version,tool_name,tool_version,tool_digest,reconverted_hash,comparison_digest,comparison_summary,worker_job_id,worker_job_attempt,worker_lease_owner,operation_id,submitted_by_actor_id,submitted_actor_type,review_governance,purpose,security_level,policy_version)
values($1,$2,$3,$4,$5,decode($6,'hex'),$7,decode($8,'hex'),28,$9,decode($10,'hex'),28,$11,decode($12,'hex'),'synthetic-local-work','HISTORICAL_EQUIVALENCE','VERIFIED_EQUIVALENT','candidate-word-equivalence','1.0.0','synthetic-tool','test-only',decode($13,'hex'),decode($13,'hex'),decode($13,'hex'),$14::jsonb,$15,1,'conversion-sql-test',$5,$16,'human',$17::jsonb,'candidate-conversion-verification','L0_PUBLIC',1)`;
      const values = [
        resultId,
        tenant,
        project,
        batch,
        ingestion,
        reviewHash,
        members[0]!.assetId,
        members[0]!.sourceHash,
        members[1]!.assetId,
        members[1]!.sourceHash,
        members[2]!.assetId,
        members[2]!.sourceHash,
        'e'.repeat(64),
        JSON.stringify(summary),
        job,
        actor,
        JSON.stringify(policy),
      ];
      try {
        await client.query('begin');
        await client.query(
          "select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L0_PUBLIC',true),set_config('wiser.policy_version','1',true),set_config('wiser.actor_id',$3,true),set_config('wiser.actor_type','human',true),set_config('wiser.delegated_by','',true)",
          [tenant, project, actor],
        );
        await client.query(
          'insert into ingestion.project_review_policy(tenant_id,project_id,mode,revision) values($1,$2,$3,1)',
          [tenant, project, policy.mode],
        );
        await client.query(
          "insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload) values($1,$2,$3,'data.ingestion.submit',$4,'RUNNING','L0_PUBLIC','{}')",
          [ingestion, tenant, project, actor],
        );
        await client.query(
          "insert into ingestion.session(ingestion_id,tenant_id,project_id,operation_id,owner_project_id,state,intended_uses,requested_security_level,security_level,submitted_by_actor_id,submitted_actor_type) values($1,$2,$3,$1,$3,'SPATIOTEMPORAL_ALIGNED',array['synthetic-conversion-test'],'L0_PUBLIC','L0_PUBLIC',$4,'human')",
          [ingestion, tenant, project, actor],
        );
        for (const member of members) {
          await client.query(
            "insert into catalog.content_blob(content_blob_id,tenant_id,project_id,content_hash,byte_size,security_level) values($1,$2,$3,decode($4,'hex'),28,'L0_PUBLIC')",
            [member.blobId, tenant, project, member.sourceHash],
          );
          await client.query(
            "insert into catalog.asset(asset_id,tenant_id,project_id,storage_key,media_type,byte_size,lifecycle_state,content_blob_id,content_hash,security_level) values($1,$2,$3,$4,$5,28,'FINGERPRINTED',$6,decode($7,'hex'),'L0_PUBLIC')",
            [
              member.assetId,
              tenant,
              project,
              member.quarantineObjectRef,
              member.mediaType,
              member.blobId,
              member.sourceHash,
            ],
          );
          await client.query(
            "insert into ingestion.input_asset(tenant_id,project_id,ingestion_id,asset_id,ordinal,fingerprint,scan_status,security_level) values($1,$2,$3,$4,$5,decode($6,'hex'),'CLEAN','L0_PUBLIC')",
            [
              tenant,
              project,
              ingestion,
              member.assetId,
              member.ordinal,
              member.sourceHash,
            ],
          );
        }
        await client.query(
          "insert into ingestion.transform_plan(transform_plan_id,tenant_id,project_id,ingestion_id,plan_version,plan,plan_hash,status,security_level) values($1,$2,$3,$4,1,$5::jsonb,decode($6,'hex'),'REVIEW_REQUIRED','L0_PUBLIC')",
          [
            plan,
            tenant,
            project,
            ingestion,
            JSON.stringify({ ...frozenBase, reviewHash }),
            reviewHash,
          ],
        );
        await client.query(
          "update ingestion.session set state='REVIEW_REQUIRED',row_version=row_version+1 where ingestion_id=$1",
          [ingestion],
        );
        await client.query(
          "insert into ingestion.job(job_id,tenant_id,project_id,ingestion_id,operation_id,job_type,status,idempotency_key,payload,lease_owner,lease_expires_at,attempt_count,timeout_at,security_level) values($1,$2,$3,$4,$4,'data.ingestion.process','RUNNING',$1::uuid::text,'{}','conversion-sql-test',clock_timestamp()+interval '5 minutes',1,clock_timestamp()+interval '1 hour','L0_PUBLIC')",
          [job, tenant, project, ingestion],
        );
        await client.query(
          "select set_config('wiser.candidate_job_id',$1,true),set_config('wiser.candidate_job_owner','conversion-sql-test',true),set_config('wiser.candidate_job_attempt','1',true)",
          [job],
        );
        await client.query('set local role wiser_data_worker');
        await client.query(
          "insert into ingestion.candidate_batch(processing_batch_id,tenant_id,project_id,ingestion_id,transform_plan_id,operation_id,review_hash,parser_version,security_level,policy_version) values($1,$2,$3,$4,$5,$4,decode($6,'hex'),'synthetic-conversion','L0_PUBLIC',1)",
          [batch, tenant, project, ingestion, plan, reviewHash],
        );
        for (const member of members)
          await client.query(
            "insert into ingestion.candidate_asset(processing_batch_id,asset_id,tenant_id,project_id,source_hash,security_level,policy_version) values($1,$2,$3,$4,decode($5,'hex'),'L0_PUBLIC',1)",
            [batch, member.assetId, tenant, project, member.sourceHash],
          );
        await client.query('set local role wiser_data_api');
        await denied(client, insert, values);
        await client.query('set local role wiser_data_worker');
        const wrongHash = [...values];
        wrongHash[7] = 'b'.repeat(64);
        await denied(client, insert, wrongHash);
        const wrongActor = [...values];
        wrongActor[15] = other;
        await denied(client, insert, wrongActor);
        const wrongPolicy = [...values];
        wrongPolicy[16] = JSON.stringify({ ...policy, revision: 2 });
        await denied(client, insert, wrongPolicy);
        await client.query(
          "select set_config('wiser.candidate_job_attempt','2',true)",
        );
        await denied(client, insert, values);
        await client.query(
          "select set_config('wiser.candidate_job_attempt','1',true)",
        );
        await client.query(insert, values);
        await denied(
          client,
          'update ingestion.candidate_conversion_check set rule_version=$2 where result_id=$1',
          [resultId, 'forged'],
        );
        await denied(
          client,
          'delete from ingestion.candidate_conversion_check where result_id=$1',
          [resultId],
        );
        await denied(
          client,
          'set constraints candidate_conversion_commit_guard immediate',
          [],
        );
        for (const [index, member] of members.entries())
          await client.query(
            'update ingestion.candidate_asset set status=$3,reason=$4,record_count=$5,feature_count=$5 where processing_batch_id=$1 and asset_id=$2',
            [
              batch,
              member.assetId,
              index === 1 ? 'READY' : 'UNSUPPORTED',
              index === 1
                ? null
                : index === 0
                  ? 'FORMAT_COMPANION'
                  : 'SOURCE_MANIFEST',
              index === 1 ? 0 : null,
            ],
          );
        await client.query(
          "update ingestion.candidate_batch set status='PARTIAL',completed_at=clock_timestamp() where processing_batch_id=$1",
          [batch],
        );
        await client.query('savepoint late_conversion_cancel');
        await client.query('reset role');
        await client.query(
          'update ingestion.job set cancel_requested_at=clock_timestamp(),row_version=row_version+1 where job_id=$1',
          [job],
        );
        await client.query('set local role wiser_data_worker');
        await denied(
          client,
          'set constraints candidate_conversion_commit_guard immediate',
          [],
        );
        await client.query('rollback to savepoint late_conversion_cancel');
        await client.query('savepoint late_conversion_timeout');
        await client.query('reset role');
        await client.query(
          "update ingestion.job set timeout_at=clock_timestamp()-interval '1 second',row_version=row_version+1 where job_id=$1",
          [job],
        );
        await client.query('set local role wiser_data_worker');
        await denied(
          client,
          'set constraints candidate_conversion_commit_guard immediate',
          [],
        );
        await client.query('rollback to savepoint late_conversion_timeout');
        await client.query(
          'set constraints candidate_conversion_commit_guard immediate',
        );
        await denied(client, insert, [randomUUID(), ...values.slice(1)]);
        await client.query('set local role wiser_data_api');
        await client.query(
          "select set_config('wiser.candidate_maintainer','true',true),set_config('wiser.candidate_reviewer','false',true),set_config('wiser.candidate_purpose','candidate-review',true)",
        );
        expect(
          (
            await client.query(
              'select result_state from ingestion.candidate_conversion_check where result_id=$1',
              [resultId],
            )
          ).rows,
        ).toEqual([{ result_state: 'VERIFIED_EQUIVALENT' }]);
        await client.query("select set_config('wiser.actor_id',$1,true)", [
          other,
        ]);
        expect(
          (
            await client.query(
              'select result_state from ingestion.candidate_conversion_check where result_id=$1',
              [resultId],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
});
