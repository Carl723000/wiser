import { createHash, randomUUID } from 'node:crypto';
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
    sourceHash,
  };
}

const uuid = (n: number) =>
  `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: uuid(1),
  processingBatchId: uuid(2),
  reviewHash: 'a'.repeat(64),
};
function spec(ref = reference, assetId = uuid(3), sourceHash = 'b'.repeat(64)) {
  return {
    schemaVersion: 2,
    page: { kind: 'records', reference: ref, assetId, first: 2 },
    period: {
      windowMode: 'month',
      from: '2026-01',
      to: '2026-02',
      displayUnit: 'month',
      timeRole: 'REPORT_PERIOD',
      includeUndated: false,
    },
    topic: {
      question: 'Synthetic fixed topic',
      regionIds: ['fixture'],
      needIds: ['fixture'],
      recordPins: [],
    },
    rulePins: ['projection', 'readiness', 'requirement', 'impact'].map(
      (kind) => ({ kind, ruleId: kind, version: '1' }),
    ),
    dependencyPins: [
      {
        kind: 'asset',
        reference: ref,
        assetId,
        sourceHash,
        parserVersion: 'synthetic.v1',
      },
    ],
    relationPins: [],
  };
}
const enabled = process.env['WISER_DATA_PG_INTEGRATION'] === '1';
describe('complete topic compatibility in actual migrated PostgreSQL', () => {
  it.skipIf(!enabled)(
    'strictly dispatches versions and validates whole v2 pins without changing the original v1 function',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const validate = async (value: unknown, refs: unknown = [reference]) =>
          (
            await client.query<{ valid: boolean }>(
              'select service.valid_candidate_saved_spec_version($1::jsonb,$2::jsonb) valid',
              [JSON.stringify(value), JSON.stringify(refs)],
            )
          ).rows[0]!.valid;
        const full = spec();
        expect(await validate(full)).toBe(true);
        const v1 = {
          page: full.page,
          period: {
            from: '2026-01',
            to: '2026-02',
            unit: 'month',
            includeUndated: false,
          },
        };
        expect(await validate(v1)).toBe(true);
        expect(
          (
            await client.query<{ valid: boolean }>(
              'select service.valid_candidate_view_spec($1::jsonb,$2::jsonb) valid',
              [JSON.stringify(full), JSON.stringify([reference])],
            )
          ).rows[0]!.valid,
        ).toBe(false);
        for (const invalid of [
          { ...full, schemaVersion: 1 },
          { ...full, schemaVersion: 3 },
          { ...full, schemaVersion: '2' },
          { ...full, period: v1.period },
          { ...full, extra: 'not part of v2' },
          { ...full, rulePins: full.rulePins.slice(0, 3) },
          { ...full, rulePins: [...full.rulePins, full.rulePins[0]] },
          {
            ...full,
            dependencyPins: [...full.dependencyPins, full.dependencyPins[0]],
          },
          {
            ...full,
            dependencyPins: [
              { ...full.dependencyPins[0], sourceHash: 'wrong' },
            ],
          },
          {
            ...full,
            dependencyPins: [
              {
                ...full.dependencyPins[0],
                reference: { ...reference, reviewHash: 'c'.repeat(64) },
              },
            ],
          },
          {
            ...full,
            relationPins: [
              { relationId: uuid(5), revision: 0, decisionVersion: 0 },
            ],
          },
          {
            ...full,
            relationPins: [
              { relationId: uuid(5), revision: 1, decisionVersion: 0.5 },
            ],
          },
          {
            ...full,
            period: {
              ...full.period,
              windowMode: 'day',
              from: '2026-02-30',
              to: '2026-03-01',
              displayUnit: 'day',
            },
          },
          {
            ...full,
            topic: {
              ...full.topic,
              recordPins: [{ reference, assetId: uuid(3), recordId: uuid(4) }],
            },
          },
        ])
          expect(await validate(invalid)).toBe(false);
        expect(
          await validate({
            ...full,
            period: {
              ...full.period,
              windowMode: 'day',
              from: '2024-02-29',
              to: '2024-03-01',
              displayUnit: 'day',
            },
          }),
        ).toBe(true);
        const refs = Array.from({ length: 100 }, (_, i) => ({
          ...reference,
          ingestionId: uuid(i + 10),
          processingBatchId: uuid(i + 1000),
        }));
        expect(await validate(spec(refs[0]), refs)).toBe(true);
        expect(
          await validate(spec(refs[0]), [
            ...refs,
            { ...reference, ingestionId: uuid(9999) },
          ]),
        ).toBe(false);
        expect(await validate(full, [reference, reference])).toBe(false);
        const large = structuredClone(full);
        large.topic.question = 'x'.repeat(131073);
        expect(await validate(large)).toBe(false);
      } finally {
        await client.query('rollback');
        client.release();
        await pool.end();
      }
    },
  );
  it.skipIf(!enabled)(
    'preserves historical v2 source RLS and confines unavailable owner receipt to a single requested ID and one column',
    async () => {
      const pool = new Pool({
        connectionString: process.env['DATA_TEST_DATABASE_URL'],
        max: 1,
      });
      const client = await pool.connect();
      const tenant = randomUUID(),
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
        const source = await freezeCandidate(client, tenant, project, actor);
        // On this fresh connection reviewer is genuinely absent, not an empty
        // custom GUC previously populated by the normal API authority setter.
        await client.query(
          `select set_config('wiser.actor_id',$1,true),
          set_config('wiser.actor_type','human',true),set_config('wiser.delegated_by','',true),
          set_config('wiser.candidate_maintainer','false',true),
          set_config('wiser.purpose','candidate-review',true),set_config('wiser.candidate_purpose','candidate-review',true),
          set_config('wiser.candidate_view_deadline','infinity',true),set_config('wiser.resource_scope','',true)`,
          [actor],
        );
        expect(
          (
            await client.query(
              "select current_setting('wiser.candidate_reviewer',true) flag",
            )
          ).rows[0],
        ).toEqual({ flag: null });
        await client.query('set local role wiser_data_metadata');
        expect(
          (
            await client.query(
              'select service.candidate_topic_receipt_authority_live() live',
            )
          ).rows[0],
        ).toEqual({ live: false });
        await client.query('reset role');
        const setActor = async (
          subject: string = actor,
          type = 'human',
          delegate = '',
        ) =>
          client.query(
            `select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type',$2,true),set_config('wiser.delegated_by',$3,true),
        set_config('wiser.candidate_maintainer','true',true),set_config('wiser.candidate_reviewer','false',true),set_config('wiser.purpose','candidate-review',true),set_config('wiser.candidate_purpose','candidate-review',true),
        set_config('wiser.candidate_view_deadline','infinity',true),set_config('wiser.candidate_fixed_refs','',true),set_config('wiser.resource_scope','',true),set_config('wiser.candidate_topic_receipt_id','',true)`,
            [subject, type, delegate],
          );
        await setActor();
        await client.query('set local role wiser_data_api');
        const id = randomUUID(),
          legacyId = randomUUID(),
          secondId = randomUUID(),
          delegatedId = randomUUID();
        const full = spec(source.reference, source.asset, source.sourceHash);
        const insert = `insert into service.ingestion_candidate_saved_view(view_id,tenant_id,project_id,actor_id,actor_type,delegated_by,purpose,security_level,policy_version,title,visibility,candidate_refs,view_spec,created_at)
        values($1,$2,$3,$4,$5,$6,'candidate-review','L0_PUBLIC',1,'Synthetic title','private',$7::jsonb,$8::jsonb,clock_timestamp())`;
        const args = (
          view: string,
          value: unknown,
          subject = actor,
          type = 'human',
          delegate: string | null = null,
        ) => [
          view,
          tenant,
          project,
          subject,
          type,
          delegate,
          JSON.stringify([source.reference]),
          JSON.stringify(value),
        ];
        await client.query(insert, args(id, full));
        await client.query(insert, args(secondId, full));
        await client.query(insert, args(legacyId, { page: full.page }));
        expect(
          (
            await client.query(
              'select view_id from service.ingestion_candidate_saved_view where view_id=$1',
              [id],
            )
          ).rows,
        ).toEqual([{ view_id: id }]);
        await denied(
          client,
          insert,
          args(randomUUID(), { ...full, schemaVersion: 3 }),
          '23514',
        );
        await denied(
          client,
          'update service.ingestion_candidate_saved_view set title=$2 where view_id=$1',
          [id, 'Changed'],
          '42501',
        );
        await client.query('reset role');
        await client.query(
          insert,
          args(delegatedId, full, agent, 'agent', actor),
        );
        await client.query(
          "insert into ingestion.transform_plan(transform_plan_id,tenant_id,project_id,ingestion_id,plan_version,plan,plan_hash,status,security_level) values($1,$2,$3,$4,2,$5::jsonb,decode($6,'hex'),'REVIEW_REQUIRED','L0_PUBLIC')",
          [
            randomUUID(),
            tenant,
            project,
            source.reference.ingestionId,
            JSON.stringify(source.frozen),
            source.reference.reviewHash,
          ],
        );
        await client.query('set local role wiser_data_api');
        await setActor();
        expect(
          (
            await client.query(
              'select view_id from service.ingestion_candidate_saved_view where view_id=$1',
              [id],
            )
          ).rows,
        ).toEqual([{ view_id: id }]);
        expect(
          (
            await client.query(
              'select view_id from service.ingestion_candidate_saved_view where view_id=$1',
              [legacyId],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(
              "select current_setting('wiser.candidate_fixed_refs',true) refs",
            )
          ).rows[0],
        ).toEqual({ refs: '' });
        await client.query('reset role');
        await client.query(
          "update ingestion.session set state='CANCELLED',row_version=row_version+1 where ingestion_id=$1",
          [source.reference.ingestionId],
        );
        await client.query('set local role wiser_data_api');
        await setActor();
        expect(
          (
            await client.query(
              'select view_id from service.ingestion_candidate_saved_view where view_id=$1',
              [id],
            )
          ).rows,
        ).toEqual([]);
        await client.query('set local role wiser_data_metadata');
        expect(
          (
            await client.query(
              'select view_id from service.ingestion_candidate_saved_view',
            )
          ).rows,
        ).toEqual([]);
        await client.query(
          "select set_config('wiser.candidate_topic_receipt_id',$1,true)",
          [id],
        );
        expect(
          (
            await client.query(
              'select view_id from service.ingestion_candidate_saved_view',
            )
          ).rows,
        ).toEqual([{ view_id: id }]);
        for (const column of [
          'title',
          'candidate_refs',
          'view_spec',
          'actor_id',
          'tenant_id',
        ])
          await denied(
            client,
            `select ${column} from service.ingestion_candidate_saved_view`,
            [],
            '42501',
          );
        for (const target of [legacyId, randomUUID()]) {
          await client.query(
            "select set_config('wiser.candidate_topic_receipt_id',$1,true)",
            [target],
          );
          expect(
            (
              await client.query(
                'select view_id from service.ingestion_candidate_saved_view',
              )
            ).rows,
          ).toEqual([]);
        }
        for (const [subject, type, delegate] of [
          [other, 'human', ''],
          [agent, 'agent', other],
        ]) {
          await setActor(subject, type, delegate);
          await client.query(
            "select set_config('wiser.candidate_topic_receipt_id',$1,true)",
            [id],
          );
          expect(
            (
              await client.query(
                'select view_id from service.ingestion_candidate_saved_view',
              )
            ).rows,
          ).toEqual([]);
        }
        await setActor();
        await client.query(
          "select set_config('wiser.candidate_topic_receipt_id',$1,true)",
          [delegatedId],
        );
        expect(
          (
            await client.query(
              'select view_id from service.ingestion_candidate_saved_view',
            )
          ).rows,
        ).toEqual([{ view_id: delegatedId }]);
        for (const guard of [
          "select set_config('wiser.project_id','00000000-0000-4000-8000-000000000001',true)",
          "select set_config('wiser.purpose','another-purpose',true)",
          "select set_config('wiser.candidate_view_deadline','2000-01-01T00:00:00Z',true)",
          "select set_config('wiser.candidate_maintainer','false',true)",
          'select set_config(\'wiser.resource_scope\',\'{"mode":"managed","validUntil":"2000-01-01T00:00:00Z","permissions":{}}\',true)',
        ]) {
          await client.query('savepoint receipt_guard');
          await client.query(guard);
          expect(
            (
              await client.query(
                'select view_id from service.ingestion_candidate_saved_view',
              )
            ).rows,
          ).toEqual([]);
          await client.query('rollback to savepoint receipt_guard');
        }
        await client.query('reset role');
        expect(
          (
            await client.query(
              "select rolname,rolsuper,rolbypassrls from pg_roles where rolname in ('wiser_data_api','wiser_data_metadata') order by rolname",
            )
          ).rows,
        ).toEqual([
          { rolname: 'wiser_data_api', rolsuper: false, rolbypassrls: false },
          {
            rolname: 'wiser_data_metadata',
            rolsuper: false,
            rolbypassrls: false,
          },
        ]);
        expect(
          (
            await client.query(
              "select count(*)::integer count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='service' and p.proname like '%candidate_topic%' and p.prosecdef",
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
});
