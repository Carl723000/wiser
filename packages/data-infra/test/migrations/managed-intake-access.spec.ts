import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
  'isolates managed quarantine/session maintenance by immutable responsibility without granting published content',
  async () => {
    const url = process.env['DATA_TEST_DATABASE_URL'];
    if (!url) throw Error('DATA_TEST_DATABASE_URL is required');
    const pool = new Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    const tenant = randomUUID(),
      project = randomUUID(),
      actor = randomUUID(),
      other = randomUUID(),
      agent = randomUUID();
    const fixtures = [
      { actor, type: 'human', delegator: null, known: true },
      { actor: other, type: 'human', delegator: null, known: true },
      { actor: agent, type: 'agent', delegator: actor, known: true },
      { actor, type: 'human', delegator: null, known: false },
    ].map((f) => ({
      ...f,
      upload: randomUUID(),
      asset: randomUUID(),
      ingestion: randomUUID(),
    }));
    const permissions = {
      'content.read': [],
      'original.read': [],
      'result.export': [],
      'source.discover': [],
      'external.directory': [],
    };
    const scope = (validUntil: string | null = null) =>
      JSON.stringify({ mode: 'managed', validUntil, permissions });
    const setActor = async (subject: string, type = 'human', delegator = '') =>
      client.query(
        `select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type',$2,true),set_config('wiser.delegated_by',$3,true)`,
        [subject, type, delegator],
      );
    const visibleAssets = async () =>
      new Set(
        (
          await client.query<{ asset_id: string }>(
            'select asset_id from catalog.asset where tenant_id=$1 and project_id=$2',
            [tenant, project],
          )
        ).rows.map((r) => r.asset_id),
      );
    const visibleSessions = async () =>
      new Set(
        (
          await client.query<{ ingestion_id: string }>(
            'select ingestion_id from ingestion.session where tenant_id=$1 and project_id=$2',
            [tenant, project],
          )
        ).rows.map((r) => r.ingestion_id),
      );
    try {
      await client.query('begin');
      await client.query(
        `select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L0_PUBLIC',true),set_config('wiser.policy_version','1',true)`,
        [tenant, project],
      );
      // Synthetic legacy unknown rows precede governance. They must not gain
      // managed visibility merely because the project later becomes governed.
      for (const f of fixtures) {
        await setActor(f.actor, f.type, f.delegator ?? '');
        const responsibility = f.known
          ? {
              actorId: f.actor,
              actorType: f.type,
              ...(f.delegator ? { delegatedBy: f.delegator } : {}),
              purpose: 'intake-test',
            }
          : undefined;
        await client.query(
          `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload)
          values($1,$2,$3,'data.uploadSession.create',$4,'SUCCEEDED','L0_PUBLIC',$5::jsonb)`,
          [
            f.upload,
            tenant,
            project,
            f.actor,
            JSON.stringify({
              assets: [{ assetId: f.asset }],
              ...(responsibility
                ? { intakeResponsibility: responsibility }
                : {}),
            }),
          ],
        );
        await client.query(
          `insert into catalog.asset(asset_id,tenant_id,project_id,storage_key,media_type,byte_size,lifecycle_state,security_level)
          values($1,$2,$3,$4,'text/csv',1,'QUARANTINED','L0_PUBLIC')`,
          [f.asset, tenant, project, `quarantine/synthetic/${f.asset}`],
        );
        await client.query(
          `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload)
          values($1,$2,$3,'data.ingestion.create',$4,'WAITING_INPUT','L0_PUBLIC','{}')`,
          [f.ingestion, tenant, project, f.actor],
        );
        await client.query(
          `insert into ingestion.session(ingestion_id,tenant_id,project_id,operation_id,owner_project_id,state,intended_uses,requested_security_level,security_level,submitted_by_actor_id,submitted_actor_type,submitted_delegator_actor_id)
          values($1,$2,$3,$1,$3,'RECEIVED',array['synthetic-intake-test'],'L0_PUBLIC','L0_PUBLIC',$4,$5,$6)`,
          [
            f.ingestion,
            tenant,
            project,
            f.known ? f.actor : null,
            f.known ? f.type : null,
            f.known ? f.delegator : null,
          ],
        );
      }
      await client.query('set local role wiser_data_api');
      await setActor(actor);
      await client.query(
        `select set_config('wiser.resource_scope',$1,true),set_config('wiser.resource_action','content.read',true),
        set_config('wiser.candidate_maintainer','true',true),set_config('wiser.candidate_reviewer','false',true),
        set_config('wiser.candidate_purpose','intake-test',true),set_config('wiser.intake_capability','data.ingestion.create',true)`,
        [scope()],
      );
      expect(await visibleAssets()).toEqual(
        new Set([fixtures[0]!.asset, fixtures[2]!.asset]),
      );
      expect(await visibleSessions()).toEqual(
        new Set([fixtures[0]!.ingestion, fixtures[2]!.ingestion]),
      );
      expect(
        (
          await client.query(
            'select version_id from catalog.data_item_version where tenant_id=$1 and project_id=$2',
            [tenant, project],
          )
        ).rows,
      ).toEqual([]);
      await client.query(
        "select set_config('wiser.intake_capability','data.catalog.get',true)",
      );
      expect(await visibleAssets()).toEqual(new Set());
      await client.query(
        "select set_config('wiser.intake_capability','data.ingestion.create',true),set_config('wiser.candidate_maintainer','false',true)",
      );
      expect(await visibleAssets()).toEqual(new Set());
      expect(await visibleSessions()).toEqual(new Set());
      await client.query(
        "select set_config('wiser.candidate_reviewer','true',true)",
      );
      expect(await visibleSessions()).toEqual(
        new Set([fixtures[1]!.ingestion]),
      );
      expect(await visibleAssets()).toEqual(new Set());
      await client.query(
        "select set_config('wiser.candidate_reviewer','false',true),set_config('wiser.candidate_maintainer','true',true)",
      );
      await setActor(agent, 'agent', actor);
      expect(await visibleAssets()).toEqual(new Set([fixtures[2]!.asset]));
      expect(await visibleSessions()).toEqual(
        new Set([fixtures[2]!.ingestion]),
      );
      await setActor(agent, 'agent', other);
      expect(await visibleAssets()).toEqual(new Set());
      expect(await visibleSessions()).toEqual(new Set());
      await setActor(actor);
      await client.query("select set_config('wiser.resource_scope',$1,true)", [
        scope('2000-01-01T00:00:00Z'),
      ]);
      expect(await visibleSessions()).toEqual(new Set());
      expect(await visibleAssets()).toEqual(new Set());
      await client.query(
        "select set_config('wiser.resource_scope',$1,true),set_config('wiser.candidate_purpose','',true)",
        [scope()],
      );
      expect(await visibleSessions()).toEqual(new Set());
      await client.query(
        "select set_config('wiser.candidate_purpose','intake-test',true),set_config('wiser.project_id',$1,true)",
        [randomUUID()],
      );
      expect(await visibleAssets()).toEqual(new Set());
      await client.query('set local role wiser_data_worker');
      await client.query(
        "select set_config('wiser.project_id',$1,true),set_config('wiser.resource_scope','',true)",
        [project],
      );
      expect(await visibleAssets()).toEqual(
        new Set(fixtures.map((f) => f.asset)),
      );
      expect(await visibleSessions()).toEqual(
        new Set(fixtures.map((f) => f.ingestion)),
      );
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await pool.end();
    }
  },
);
