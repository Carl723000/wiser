import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

async function denied(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
  code: string,
) {
  await client.query('savepoint denied_attempt');
  await expect(client.query(sql, [...values])).rejects.toMatchObject({ code });
  await client.query('rollback to savepoint denied_attempt');
}

describe('trusted ingestion review governance', () => {
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'enforces frozen policy, immutable responsibility, independent human approval and runtime isolation in PostgreSQL',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      const tenant = randomUUID(),
        project = randomUUID(),
        ingestion = randomUUID(),
        submitter = randomUUID(),
        reviewer = randomUUID(),
        plan = randomUUID(),
        version = randomUUID(),
        unlinkedItem = randomUUID();
      const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 1 };
      const setSubject = async (
        actor: string,
        type = 'human',
        delegator = '',
      ) =>
        client.query(
          `select set_config('wiser.tenant_id',$1,true), set_config('wiser.project_id',$2,true),
          set_config('wiser.max_security_level','L0_PUBLIC',true), set_config('wiser.policy_version','1',true),
          set_config('wiser.actor_id',$3,true), set_config('wiser.actor_type',$4,true), set_config('wiser.delegated_by',$5,true)`,
          [tenant, project, actor, type, delegator],
        );
      try {
        await client.query('begin');
        await setSubject(submitter);
        await client.query(
          `insert into ingestion.project_review_policy(tenant_id,project_id,mode,revision) values($1,$2,$3,1)`,
          [tenant, project, policy.mode],
        );
        await client.query(
          `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload) values($1,$2,$3,'data.ingestion.create',$4,'PENDING','L0_PUBLIC','{}')`,
          [ingestion, tenant, project, submitter],
        );
        await client.query(
          `insert into ingestion.session(ingestion_id,tenant_id,project_id,operation_id,owner_project_id,state,intended_uses,requested_security_level,security_level,submitted_by_actor_id,submitted_actor_type) values($1,$2,$3,$1,$3,'SPATIOTEMPORAL_ALIGNED',array['synthetic-review-test'],'L0_PUBLIC','L0_PUBLIC',$4,'human')`,
          [ingestion, tenant, project, submitter],
        );
        expect(
          (
            await client.query<{ review_policy_snapshot: unknown }>(
              'select review_policy_snapshot from ingestion.session where ingestion_id=$1',
              [ingestion],
            )
          ).rows[0]?.review_policy_snapshot,
        ).toEqual(policy);
        await denied(
          client,
          `update ingestion.session set state='APPROVED',row_version=row_version+1 where ingestion_id=$1`,
          [ingestion],
          '42501',
        );
        await denied(
          client,
          `update ingestion.session set state='REVIEW_REQUIRED',submitted_by_actor_id=$2,row_version=row_version+1 where ingestion_id=$1`,
          [ingestion, reviewer],
          '42501',
        );
        const frozen = { assetManifest: { reviewGovernance: policy } };
        const checkpoint = `insert into ingestion.transform_plan(transform_plan_id,tenant_id,project_id,ingestion_id,plan_version,plan,plan_hash,status,security_level) values($1,$2,$3,$4,1,$5::jsonb,decode(repeat('a',64),'hex'),$6,'L0_PUBLIC')`;
        await denied(
          client,
          checkpoint,
          [
            plan,
            tenant,
            project,
            ingestion,
            JSON.stringify(frozen),
            'APPROVED',
          ],
          '42501',
        );
        await client.query(checkpoint, [
          plan,
          tenant,
          project,
          ingestion,
          JSON.stringify(frozen),
          'REVIEW_REQUIRED',
        ]);
        await client.query(
          `update ingestion.session set state='REVIEW_REQUIRED',row_version=row_version+1 where ingestion_id=$1`,
          [ingestion],
        );
        await client.query(
          `insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,generation_method,quality_grade,acceptance_status,publication_status,security_level,update_mode)
          values($1,$2,$3,$3,'Synthetic governance test',array['test'],array['test'],array['test'],'RAW',array['test'],'test','test','SYNTHETIC','A','PENDING','UNPUBLISHED','L0_PUBLIC','SNAPSHOT')`,
          [ingestion, tenant, project],
        );
        await client.query(
          `insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,generation_method,quality_grade,acceptance_status,publication_status,security_level,update_mode)
          values($1,$2,$3,$3,'Synthetic unlinked item',array['test'],array['test'],array['test'],'RAW',array['test'],'test','test','SYNTHETIC','A','PENDING','UNPUBLISHED','L0_PUBLIC','SNAPSHOT')`,
          [unlinkedItem, tenant, project],
        );
        const insertVersion = `insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at)
          values($1,$2,$3,$4,1,$5::jsonb,decode(repeat('a',64),'hex'),decode(repeat('b',64),'hex'),'RAW','SYNTHETIC','A','PENDING','UNPUBLISHED','L0_PUBLIC',clock_timestamp())`;
        const versionValues = [
          version,
          tenant,
          project,
          ingestion,
          JSON.stringify({ reviewGovernance: policy }),
        ];
        await denied(client, insertVersion, versionValues, '42501');
        const approvePlan = `update ingestion.transform_plan set status='APPROVED',approved_by_actor_id=$2,row_version=row_version+1 where transform_plan_id=$1`;
        await client.query('set local role wiser_data_api');
        await denied(client, approvePlan, [plan, submitter], '42501');
        await setSubject(reviewer, 'agent', submitter);
        await denied(client, approvePlan, [plan, reviewer], '42501');
        await setSubject(reviewer, 'service', submitter);
        await denied(client, approvePlan, [plan, reviewer], '42501');
        await setSubject(reviewer);
        await client.query('set local role wiser_data_worker');
        await denied(client, approvePlan, [plan, reviewer], '42501');
        await client.query('set local role wiser_data_api');
        await client.query(approvePlan, [plan, reviewer]);
        await client.query(
          `update ingestion.session set state='APPROVED',approved_by_actor_id=$2,approved_at=clock_timestamp(),row_version=row_version+1 where ingestion_id=$1`,
          [ingestion, reviewer],
        );
        await client.query('set local role wiser_data_worker');
        await denied(
          client,
          insertVersion,
          [version, tenant, project, unlinkedItem, versionValues[4]],
          '42501',
        );
        await denied(
          client,
          insertVersion,
          [...versionValues.slice(0, 4), JSON.stringify({})],
          '42501',
        );
        await client.query(insertVersion, versionValues);
        await client.query(
          `update ingestion.session set state='COMMITTED',row_version=row_version+1 where ingestion_id=$1`,
          [ingestion],
        );
        expect(
          (
            await client.query(
              'select state,approved_by_actor_id from ingestion.session where ingestion_id=$1',
              [ingestion],
            )
          ).rows[0],
        ).toMatchObject({ state: 'COMMITTED', approved_by_actor_id: reviewer });
        await denied(
          client,
          `update ingestion.project_review_policy set revision=revision+1,row_version=row_version+1 where tenant_id=$1 and project_id=$2`,
          [tenant, project],
          '42501',
        );
        await client.query(`select set_config('wiser.project_id',$1,true)`, [
          randomUUID(),
        ]);
        expect(
          (
            await client.query(
              'select * from ingestion.project_review_policy where tenant_id=$1 and project_id=$2',
              [tenant, project],
            )
          ).rows,
        ).toHaveLength(0);
        await client.query('reset role');
        await setSubject(reviewer);
        await client.query(
          `update ingestion.project_review_policy set revision=2,row_version=2 where tenant_id=$1 and project_id=$2`,
          [tenant, project],
        );
        await client.query('set local role wiser_data_worker');
        await denied(
          client,
          `update ingestion.session set state='PROJECTING',row_version=row_version+1 where ingestion_id=$1`,
          [ingestion],
          '55000',
        );
        await denied(
          client,
          `update catalog.data_item_version set publication_status='PUBLISHED',published_at=clock_timestamp(),updated_at=clock_timestamp() where version_id=$1`,
          [version],
          '55000',
        );
        await client.query('reset role');
        await client.query(
          `update ingestion.project_review_policy set enabled=false,revision=3,row_version=3 where tenant_id=$1 and project_id=$2`,
          [tenant, project],
        );
        await client.query('set local role wiser_data_worker');
        await denied(
          client,
          `update ingestion.session set state='PROJECTING',row_version=row_version+1 where ingestion_id=$1`,
          [ingestion],
          '55000',
        );
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
});
