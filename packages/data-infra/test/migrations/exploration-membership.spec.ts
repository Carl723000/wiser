import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
  'stores large business memberships separately from client conditions and preserves owner isolation and immutable saved history',
  async () => {
    const pool = new Pool({
      connectionString: process.env['DATA_TEST_DATABASE_URL'],
      max: 1,
    });
    const client = await pool.connect();
    const tenant = randomUUID(),
      project = randomUUID(),
      actor = randomUUID();
    const query = randomUUID(),
      view = randomUUID();
    const role = `manifest_test_${actor.replaceAll('-', '')}`;
    const pins = Array.from({ length: 2033 }, () => [randomUUID(), 1]);
    const setScope = async (key: string, value: string) => {
      await client.query('select set_config($1,$2,true)', [key, value]);
    };
    const rejected = async (sql: string, values: unknown[], code = '23514') => {
      await client.query('savepoint rejected');
      await expect(client.query(sql, values)).rejects.toMatchObject({ code });
      await client.query('rollback to savepoint rejected');
    };
    try {
      await client.query('begin');
      await client.query(`create role ${role} nologin nosuperuser nobypassrls`);
      await client.query(`grant usage on schema service,security to ${role}`);
      await client.query(
        `grant execute on all functions in schema service,security to ${role}`,
      );
      // Give UPDATE deliberately: the database guards must still reject mutation.
      await client.query(
        `grant select,insert,update on service.exploration_snapshot,service.exploration_saved_view to ${role}`,
      );
      await client.query(`set local role ${role}`);
      const scope = {
        'wiser.tenant_id': tenant,
        'wiser.project_id': project,
        'wiser.actor_id': actor,
        'wiser.purpose': 'test-manifest',
        'wiser.policy_version': '1',
        'wiser.max_security_level': 'L1_INTERNAL',
      };
      for (const [key, value] of Object.entries(scope))
        await setScope(key, value);
      const insert = `insert into service.exploration_snapshot(query_id,tenant_id,project_id,actor_id,purpose,security_level,policy_version,spec,version_refs,business_pins,created_at,expires_at) values($1,$2,$3,$4,'test-manifest','L1_INTERNAL',1,'{}','[]',$5::jsonb,statement_timestamp(),statement_timestamp()+interval '30 minutes')`;
      await client.query(insert, [
        query,
        tenant,
        project,
        actor,
        JSON.stringify(pins),
      ]);
      const read = await client.query(
        'select spec,business_pins from service.exploration_snapshot where query_id=$1',
        [query],
      );
      expect(read.rows[0]?.['spec']).toEqual({});
      expect(read.rows[0]?.['business_pins']).toEqual(pins);
      for (const [key, value] of Object.entries(scope)) {
        await setScope(
          key,
          key.endsWith('_id')
            ? randomUUID()
            : key.endsWith('version')
              ? '2'
              : key.endsWith('level')
                ? 'L0_PUBLIC'
                : 'other-purpose',
        );
        expect(
          (
            await client.query(
              'select business_pins from service.exploration_snapshot where query_id=$1',
              [query],
            )
          ).rows,
        ).toHaveLength(0);
        await setScope(key, value);
      }
      await rejected(
        "update service.exploration_snapshot set business_pins='[]' where query_id=$1",
        [query],
        '55000',
      );
      for (const invalid of [
        {},
        [null],
        [[randomUUID(), 0]],
        [[randomUUID(), 1.5]],
        [[randomUUID(), '1']],
        [['not-an-id', 1]],
        [pins[0], pins[0]],
        Array.from({ length: 100001 }, () => [randomUUID(), 1]),
      ]) {
        await rejected(insert, [
          randomUUID(),
          tenant,
          project,
          actor,
          JSON.stringify(invalid),
        ]);
      }
      await client.query(insert, [randomUUID(), tenant, project, actor, null]);
      await client.query(insert, [randomUUID(), tenant, project, actor, '[]']);
      await client.query(
        `insert into service.exploration_saved_view(view_id,query_id,tenant_id,project_id,actor_id,purpose,security_level,policy_version,title,visibility,spec,version_refs,view_spec,business_pins,created_at) select $1,query_id,tenant_id,project_id,actor_id,purpose,security_level,policy_version,'Synthetic manifest','private',spec,version_refs,'{}',business_pins,created_at from service.exploration_snapshot where query_id=$2`,
        [view, query],
      );
      expect(
        (
          await client.query(
            'select business_pins from service.exploration_saved_view where view_id=$1',
            [view],
          )
        ).rows[0]?.['business_pins'],
      ).toEqual(pins);
      await rejected(
        "update service.exploration_saved_view set business_pins='[]' where view_id=$1",
        [view],
      );
      await client.query(
        'update service.exploration_saved_view set revoked_at=clock_timestamp() where view_id=$1',
        [view],
      );
      expect(
        (
          await client.query(
            'select business_pins,revoked_at from service.exploration_saved_view where view_id=$1',
            [view],
          )
        ).rows[0],
      ).toMatchObject({ business_pins: pins, revoked_at: expect.any(Date) });
      await setScope('wiser.actor_id', randomUUID());
      expect(
        (
          await client.query(
            'select business_pins from service.exploration_saved_view where view_id=$1',
            [view],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await client.query('rollback');
      client.release();
      await pool.end();
    }
  },
  30000,
);
