import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

async function denied(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
  code: string,
) {
  await client.query('savepoint saved_denied');
  await expect(client.query(sql, [...values])).rejects.toMatchObject({ code });
  await client.query('rollback to savepoint saved_denied');
}
/** Real schema fixture only: leased synthetic rows, no real source or approval. */
async function freezeCandidate(
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
 values($1,$2,$3,$1,$3,'SPATIOTEMPORAL_ALIGNED',array['synthetic-saved-view-test'],'L0_PUBLIC','L0_PUBLIC',$4,'human')`,
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
 values($1,$2,$3,$4,$4,'data.ingestion.process','RUNNING',$1::uuid::text,$5::jsonb,'candidate-saved-sql',clock_timestamp()+interval '5 minutes',1,clock_timestamp()+interval '1 hour','L0_PUBLIC')`,
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
    "select set_config('wiser.candidate_job_id',$1,true),set_config('wiser.candidate_job_owner','candidate-saved-sql',true),set_config('wiser.candidate_job_attempt','1',true)",
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

describe('durable fixed candidate views in actual PostgreSQL', () => {
  it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
    'forces complete current-authority RLS, immutable configuration, delegation, deadlines, sharing and revocation',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect(),
        tenant = randomUUID(),
        project = randomUUID(),
        actor = randomUUID(),
        other = randomUUID(),
        agent = randomUUID();
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
        const own = await freezeCandidate(client, tenant, project, actor),
          foreign = await freezeCandidate(client, tenant, project, other);
        const setActor = async (
          subject: string,
          type = 'human',
          delegate = '',
          reviewer = false,
        ) =>
          client.query(
            `select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type',$2,true),set_config('wiser.delegated_by',$3,true),
      set_config('wiser.candidate_maintainer',$4,true),set_config('wiser.candidate_reviewer',$5,true),
      set_config('wiser.purpose','candidate-review',true),set_config('wiser.candidate_purpose','candidate-review',true),
      set_config('wiser.candidate_view_deadline','infinity',true),set_config('wiser.resource_scope',$6,true)`,
            [
              subject,
              type,
              delegate,
              String(!reviewer),
              String(reviewer),
              JSON.stringify({
                mode: 'managed',
                validUntil: null,
                permissions: {},
              }),
            ],
          );
        const view = randomUUID(),
          projectView = randomUUID();
        const spec = {
          page: {
            kind: 'records',
            reference: own.reference,
            assetId: own.asset,
            afterRecordId: own.record,
            first: 2,
          },
          period: {
            from: '2023-04',
            to: '2023-11',
            unit: 'month',
            includeUndated: false,
          },
        };
        const insert = `insert into service.ingestion_candidate_saved_view(view_id,tenant_id,project_id,actor_id,actor_type,delegated_by,purpose,security_level,policy_version,title,visibility,candidate_refs,view_spec,created_at)
     values($1,$2,$3,$4,$5,$6,'candidate-review','L0_PUBLIC',1,'Synthetic fixed source',$7,$8::jsonb,$9::jsonb,clock_timestamp())`;
        const args = (
          id: string,
          refs: unknown[] = [own.reference],
          visibility = 'private',
          subject = actor,
          type = 'human',
          delegate: string | null = null,
        ) => [
          id,
          tenant,
          project,
          subject,
          type,
          delegate,
          visibility,
          JSON.stringify(refs),
          JSON.stringify(spec),
        ];
        const visible = async () =>
          new Set(
            (
              await client.query<{ view_id: string }>(
                'select view_id from service.ingestion_candidate_saved_view',
              )
            ).rows.map((r) => r.view_id),
          );
        await client.query('set local role wiser_data_api');
        await setActor(actor);
        await client.query(insert, args(view));
        await client.query(
          insert,
          args(projectView, [own.reference], 'project'),
        );
        expect(await visible()).toEqual(new Set([view, projectView]));
        // No subset drop: the other author's candidate cannot join a maintainer's saved manifest.
        await denied(
          client,
          insert,
          args(randomUUID(), [own.reference, foreign.reference]),
          '42501',
        );
        await denied(
          client,
          insert,
          args(randomUUID(), [
            own.reference,
            { ...own.reference, reviewHash: 'f'.repeat(64) },
          ]),
          '42501',
        );
        await denied(
          client,
          insert,
          args(randomUUID(), [own.reference, own.reference]),
          '42501',
        );
        // Invalid duplicate references fail API RLS before CHECK evaluation.
        // The migration owner separately proves the persisted non-duplicate invariant.
        await client.query('reset role');
        await denied(
          client,
          insert,
          args(randomUUID(), [own.reference, own.reference]),
          '23514',
        );
        await client.query('set local role wiser_data_api');
        await denied(
          client,
          'update service.ingestion_candidate_saved_view set title=$2 where view_id=$1',
          [view, 'changed'],
          '42501',
        );
        await denied(
          client,
          'delete from service.ingestion_candidate_saved_view where view_id=$1',
          [view],
          '42501',
        );
        await setActor(other);
        expect(await visible()).toEqual(new Set());
        await setActor(other, 'human', '', true);
        expect(await visible()).toEqual(new Set([projectView]));
        expect(
          (
            await client.query(
              'update service.ingestion_candidate_saved_view set revoked_at=clock_timestamp() where view_id=$1',
              [projectView],
            )
          ).rowCount,
        ).toBe(0);
        await setActor(actor, 'human', '', true);
        expect(await visible()).toEqual(new Set()); // self-review excluded
        await setActor(actor);
        await client.query(
          "select set_config('wiser.candidate_view_deadline','2000-01-01T00:00:00Z',true)",
        );
        expect(await visible()).toEqual(new Set());
        await setActor(actor);
        await client.query(
          "select set_config('wiser.resource_scope',$1,true)",
          [
            JSON.stringify({
              mode: 'managed',
              permissions: {},
              validUntil: '2000-01-01T00:00:00Z',
            }),
          ],
        );
        expect(await visible()).toEqual(new Set());
        await setActor(actor);
        await client.query(
          "select set_config('wiser.purpose','another-purpose',true)",
        );
        expect(await visible()).toEqual(new Set());
        await setActor(actor);
        await client.query('set local role wiser_data_worker');
        expect(await visible()).toEqual(new Set());
        await denied(client, insert, args(randomUUID()), '42501');
        await client.query('reset role');
        // Check the exact runtime re-provisioning block, not a string assertion or credential-bearing script invocation.
        await client.query(
          'grant update on service.ingestion_candidate_saved_view to wiser_data_runtime',
        );
        const provision = readFileSync(
          new URL(
            '../../../../infrastructure/data-foundation/postgres/provision-runtime.sql',
            import.meta.url,
          ),
          'utf8',
        );
        const start = provision.indexOf('-- Query manifests are immutable'),
          end = provision.indexOf(
            'revoke all on service.analysis_amap_geometry',
            start,
          );
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        await client.query(provision.slice(start, end));
        expect(
          (
            await client.query(
              "select has_column_privilege('wiser_data_api','service.ingestion_candidate_saved_view','revoked_at','UPDATE') allowed,has_column_privilege('wiser_data_api','service.ingestion_candidate_saved_view','title','UPDATE') changed",
            )
          ).rows[0],
        ).toEqual({ allowed: true, changed: false });
        // Table owner is also guarded against changing fixed references or restoring a withdrawn view.
        await denied(
          client,
          'update service.ingestion_candidate_saved_view set candidate_refs=$2::jsonb where view_id=$1',
          [view, JSON.stringify([foreign.reference])],
          '23514',
        );
        await client.query('set local role wiser_data_api');
        await setActor(actor);
        await client.query(
          'update service.ingestion_candidate_saved_view set revoked_at=clock_timestamp() where view_id=$1',
          [view],
        );
        await client.query(
          'update service.ingestion_candidate_saved_view set revoked_at=revoked_at where view_id=$1',
          [view],
        );
        expect(
          (
            await client.query(
              'select view_id from service.ingestion_candidate_saved_view where revoked_at is null',
            )
          ).rows,
        ).toEqual([{ view_id: projectView }]);
        await denied(
          client,
          'update service.ingestion_candidate_saved_view set revoked_at=null where view_id=$1',
          [view],
          '23514',
        );
        await client.query('reset role');
        // Creator delegation is an immutable distinct fact; a project-visible row does not authorize candidates.
        await client.query(
          insert,
          args(randomUUID(), [own.reference], 'private', agent, 'agent', actor),
        );
        const agentView = (
          await client.query<{ view_id: string }>(
            'select view_id from service.ingestion_candidate_saved_view where actor_id=$1',
            [agent],
          )
        ).rows[0]!.view_id;
        await client.query('set local role wiser_data_api');
        await setActor(actor);
        expect(await visible()).toContain(agentView);
        await setActor(agent, 'agent', other);
        expect(await visible()).not.toContain(agentView);
        await client.query('reset role');
        await client.query(
          "insert into ingestion.transform_plan(transform_plan_id,tenant_id,project_id,ingestion_id,plan_version,plan,plan_hash,status,security_level) values($1,$2,$3,$4,2,$5::jsonb,decode($6,'hex'),'REVIEW_REQUIRED','L0_PUBLIC')",
          [
            randomUUID(),
            tenant,
            project,
            own.reference.ingestionId,
            JSON.stringify(own.frozen),
            own.reference.reviewHash,
          ],
        );
        await client.query('set local role wiser_data_api');
        await setActor(actor);
        expect(await visible()).toEqual(new Set());
        await client.query('reset role');
        expect(
          (
            await client.query(
              'select candidate_refs from service.ingestion_candidate_saved_view where view_id=$1',
              [projectView],
            )
          ).rows[0],
        ).toEqual({ candidate_refs: [own.reference] });
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
});
