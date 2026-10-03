import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { IngestionCandidateBatchSchema } from '@wiser/data-contracts';

async function denied(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
  code: string,
) {
  await client.query('savepoint candidate_denied');
  await expect(client.query(sql, [...values])).rejects.toMatchObject({ code });
  await client.query('rollback to savepoint candidate_denied');
}

describe('frozen ingestion candidate authority storage', () => {
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'enforces original binding, immutable records, pending review, leased writes and subject/scope reads in PostgreSQL',
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
        asset = randomUUID(),
        blob = randomUUID(),
        plan = randomUUID(),
        job = randomUUID(),
        batch = randomUUID(),
        record = randomUUID();
      const sourceHash = createHash('sha256')
        .update('synthetic candidate original')
        .digest('hex');
      const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
      const frozenBase = {
        assetIds: [asset],
        assetManifest: {
          reviewGovernance: policy,
          assets: [{ assetId: asset, sourceHash }],
        },
        quality: {},
        alignment: {},
      };
      const reviewHash = createHash('sha256')
        .update(JSON.stringify(frozenBase))
        .digest('hex');
      const frozen = { ...frozenBase, reviewHash };
      const setActor = (subject: string) =>
        client.query(
          "select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type','human',true),set_config('wiser.delegated_by','',true)",
          [subject],
        );
      const insertBatch = `insert into ingestion.candidate_batch(processing_batch_id,tenant_id,project_id,ingestion_id,transform_plan_id,operation_id,review_hash,parser_version,security_level,policy_version)
        values($1,$2,$3,$4,$5,$4,decode($6,'hex'),'1.0.0','L0_PUBLIC',1)`;
      const insertAsset = `insert into ingestion.candidate_asset(processing_batch_id,asset_id,tenant_id,project_id,source_hash,security_level,policy_version)
        values($1,$2,$3,$4,decode($5,'hex'),'L0_PUBLIC',1)`;
      const insertRecord = `insert into ingestion.candidate_record(processing_batch_id,record_id,asset_id,tenant_id,project_id,record_index,source_id,record_values,security_level,policy_version)
        values($1,$2,$3,$4,$5,$6,'table:1/row:5',$7::jsonb,'L0_PUBLIC',1)`;
      try {
        await client.query('begin');
        expect(
          (
            await client.query<{ name: string | null }>(
              "select to_regclass('ingestion.candidate_batch') name",
            )
          ).rows[0]?.name,
        ).not.toBeNull();
        await client.query(
          "select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L0_PUBLIC',true),set_config('wiser.policy_version','1',true)",
          [tenant, project],
        );
        await setActor(actor);
        await client.query(
          'insert into ingestion.project_review_policy(tenant_id,project_id,mode,revision) values($1,$2,$3,1)',
          [tenant, project, policy.mode],
        );
        await client.query(
          `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload)
          values($1,$2,$3,'data.ingestion.submit',$4,'RUNNING','L0_PUBLIC','{}')`,
          [ingestion, tenant, project, actor],
        );
        await client.query(
          `insert into ingestion.session(ingestion_id,tenant_id,project_id,operation_id,owner_project_id,state,intended_uses,requested_security_level,security_level,submitted_by_actor_id,submitted_actor_type)
          values($1,$2,$3,$1,$3,'SPATIOTEMPORAL_ALIGNED',array['synthetic-candidate-test'],'L0_PUBLIC','L0_PUBLIC',$4,'human')`,
          [ingestion, tenant, project, actor],
        );
        await client.query(
          `insert into catalog.content_blob(content_blob_id,tenant_id,project_id,content_hash,byte_size,security_level)
          values($1,$2,$3,decode($4,'hex'),28,'L0_PUBLIC')`,
          [blob, tenant, project, sourceHash],
        );
        await client.query(
          `insert into catalog.asset(asset_id,tenant_id,project_id,storage_key,media_type,byte_size,lifecycle_state,content_blob_id,content_hash,security_level)
          values($1,$2,$3,$4,'text/csv',28,'FINGERPRINTED',$5,decode($6,'hex'),'L0_PUBLIC')`,
          [
            asset,
            tenant,
            project,
            `synthetic/candidate/${asset}`,
            blob,
            sourceHash,
          ],
        );
        await client.query(
          `insert into ingestion.input_asset(tenant_id,project_id,ingestion_id,asset_id,ordinal,fingerprint,scan_status,security_level)
          values($1,$2,$3,$4,0,decode($5,'hex'),'CLEAN','L0_PUBLIC')`,
          [tenant, project, ingestion, asset, sourceHash],
        );
        await client.query(
          `insert into ingestion.transform_plan(transform_plan_id,tenant_id,project_id,ingestion_id,plan_version,plan,plan_hash,status,security_level)
          values($1,$2,$3,$4,1,$5::jsonb,decode($6,'hex'),'REVIEW_REQUIRED','L0_PUBLIC')`,
          [
            plan,
            tenant,
            project,
            ingestion,
            JSON.stringify(frozen),
            reviewHash,
          ],
        );
        await client.query(
          "update ingestion.session set state='REVIEW_REQUIRED',row_version=row_version+1 where ingestion_id=$1",
          [ingestion],
        );
        await client.query(
          `insert into ingestion.job(job_id,tenant_id,project_id,ingestion_id,operation_id,job_type,status,idempotency_key,payload,lease_owner,lease_expires_at,attempt_count,timeout_at,security_level)
          values($1::uuid,$2,$3,$4,$4,'data.ingestion.process','RUNNING',$1::uuid::text,$5::jsonb,'candidate-sql-test',clock_timestamp()+interval '5 minutes',1,clock_timestamp()+interval '1 hour','L0_PUBLIC')`,
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
          "select set_config('wiser.candidate_job_id',$1,true),set_config('wiser.candidate_job_owner','candidate-sql-test',true),set_config('wiser.candidate_job_attempt','1',true)",
          [job],
        );

        await client.query('set local role wiser_data_api');
        await denied(
          client,
          insertBatch,
          [batch, tenant, project, ingestion, plan, reviewHash],
          '42501',
        );
        await client.query('set local role wiser_data_worker');
        await denied(
          client,
          insertBatch,
          [batch, tenant, project, ingestion, plan, 'a'.repeat(64)],
          '42501',
        );
        await client.query(insertBatch, [
          batch,
          tenant,
          project,
          ingestion,
          plan,
          reviewHash,
        ]);
        await denied(
          client,
          insertAsset,
          [batch, asset, tenant, project, 'b'.repeat(64)],
          '42501',
        );
        await client.query(insertAsset, [
          batch,
          asset,
          tenant,
          project,
          sourceHash,
        ]);
        const raw = { c1: '潮白河', c2: 'Ⅲ', c3: null, c4: 0, c5: '' };
        await client.query(insertRecord, [
          batch,
          record,
          asset,
          tenant,
          project,
          1,
          JSON.stringify(raw),
        ]);
        await denied(
          client,
          insertRecord,
          [batch, randomUUID(), asset, tenant, project, 1, JSON.stringify(raw)],
          '23505',
        );
        await denied(
          client,
          "update ingestion.candidate_asset set status='READY',record_count=2,feature_count=0,columns=$3::jsonb where processing_batch_id=$1 and asset_id=$2",
          [
            batch,
            asset,
            JSON.stringify(
              Object.keys(raw).map((key) => ({ key, label: key })),
            ),
          ],
          '42501',
        );
        await client.query(
          "update ingestion.candidate_asset set status='READY',record_count=1,feature_count=0,columns=$3::jsonb where processing_batch_id=$1 and asset_id=$2",
          [
            batch,
            asset,
            JSON.stringify(
              Object.keys(raw).map((key) => ({ key, label: key })),
            ),
          ],
        );
        await denied(
          client,
          "update ingestion.candidate_batch set status='PARTIAL',completed_at=clock_timestamp() where processing_batch_id=$1",
          [batch],
          '42501',
        );
        await client.query(
          "update ingestion.candidate_batch set status='READY',completed_at=clock_timestamp() where processing_batch_id=$1",
          [batch],
        );
        const stored = (
          await client.query<{ batch: unknown }>(
            'select ingestion.candidate_batch_result($1) batch',
            [batch],
          )
        ).rows[0]?.batch;
        expect(IngestionCandidateBatchSchema.parse(stored)).toMatchObject({
          reference: {
            kind: 'ingestion-candidate',
            ingestionId: ingestion,
            reviewHash,
            processingBatchId: batch,
          },
          status: 'READY',
          assets: [
            { assetId: asset, recordCount: 1, featureCount: 0, sourceHash },
          ],
        });
        expect(
          (
            await client.query<{ state: string }>(
              'select state from ingestion.session where ingestion_id=$1',
              [ingestion],
            )
          ).rows[0]?.state,
        ).toBe('REVIEW_REQUIRED');
        expect(
          (
            await client.query(
              'select version_id from catalog.data_item_version where data_item_id=$1',
              [ingestion],
            )
          ).rows,
        ).toEqual([]);
        await denied(
          client,
          "update ingestion.candidate_record set record_values='{}' where processing_batch_id=$1",
          [batch],
          '42501',
        );
        await denied(
          client,
          "update ingestion.candidate_asset set status='INVALID',record_count=null,feature_count=null,reason='INVALID_CONTENT' where processing_batch_id=$1",
          [batch],
          '42501',
        );
        await denied(
          client,
          "update ingestion.candidate_batch set status='PARTIAL' where processing_batch_id=$1",
          [batch],
          '42501',
        );

        await client.query('set local role wiser_data_api');
        await client.query(
          "select set_config('wiser.candidate_maintainer','true',true),set_config('wiser.candidate_reviewer','false',true),set_config('wiser.candidate_purpose','candidate-review',true)",
        );
        expect(
          (
            await client.query<{ record_values: unknown; source_id: string }>(
              'select record_values,source_id from ingestion.candidate_record where processing_batch_id=$1',
              [batch],
            )
          ).rows,
        ).toEqual([{ record_values: raw, source_id: 'table:1/row:5' }]);
        await setActor(other);
        expect(
          (
            await client.query(
              'select record_id from ingestion.candidate_record where processing_batch_id=$1',
              [batch],
            )
          ).rows,
        ).toEqual([]);
        // Review readers are current independent humans, never the submitter itself.
        await client.query(
          "select set_config('wiser.candidate_maintainer','false',true),set_config('wiser.candidate_reviewer','true',true)",
        );
        expect(
          (
            await client.query(
              'select record_id from ingestion.candidate_record where processing_batch_id=$1',
              [batch],
            )
          ).rows,
        ).toHaveLength(1);
        await setActor(actor);
        expect(
          (
            await client.query(
              'select record_id from ingestion.candidate_record where processing_batch_id=$1',
              [batch],
            )
          ).rows,
        ).toEqual([]);
        await client.query(
          "select set_config('wiser.candidate_reviewer','false',true)",
        );
        // Immutable ownership alone is insufficient after current maintenance withdrawal.
        expect(
          (
            await client.query(
              'select record_id from ingestion.candidate_record where processing_batch_id=$1',
              [batch],
            )
          ).rows,
        ).toEqual([]);
        await client.query(
          "select set_config('wiser.candidate_maintainer','true',true)",
        );
        await client.query(
          "select set_config('wiser.actor_type','agent',true),set_config('wiser.delegated_by',$1,true)",
          [other],
        );
        expect(
          (
            await client.query(
              'select record_id from ingestion.candidate_record where processing_batch_id=$1',
              [batch],
            )
          ).rows,
        ).toEqual([]);
        await setActor(actor);
        await client.query("select set_config('wiser.project_id',$1,true)", [
          randomUUID(),
        ]);
        expect(
          (
            await client.query(
              'select processing_batch_id from ingestion.candidate_batch where processing_batch_id=$1',
              [batch],
            )
          ).rows,
        ).toEqual([]);
        await client.query("select set_config('wiser.project_id',$1,true)", [
          project,
        ]);
        await client.query('set local role wiser_data_metadata');
        await denied(
          client,
          'select record_values from ingestion.candidate_record',
          [],
          '42501',
        );
        await client.query('reset role');
        await client.query(
          'update ingestion.project_review_policy set enabled=false,revision=revision+1,row_version=row_version+1 where tenant_id=$1 and project_id=$2',
          [tenant, project],
        );
        await client.query('set local role wiser_data_api');
        expect(
          (
            await client.query(
              'select record_id from ingestion.candidate_record where processing_batch_id=$1',
              [batch],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
        await pool.end();
      }
    },
  );
});
