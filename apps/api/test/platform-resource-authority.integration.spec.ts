import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  compileResourceAccessScope,
  createPostgresResourceAuthorityLoader,
} from '@wiser/platform-auth';
import { ResourceAccessAuthoritySnapshotSchema } from '@wiser/platform-contracts';

const url = process.env['WISER_RESOURCE_TEST_DATABASE_URL'];
const project = 'b2000000-0000-4000-8000-000000000001';
const tenant = 'b1000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000005';
const reader = '10000000-0000-4000-8000-000000000001';
const packageId = randomUUID(),
  presetId = randomUUID(),
  grantId = randomUUID();
const resource = {
  kind: 'version' as const,
  dataItemId: randomUUID(),
  versionId: randomUUID(),
};
const context = {
  principal: {
    actorId: reader,
    actorType: 'human' as const,
    authenticationMethod: 'supabase_jwt' as const,
    authUserId: reader,
    sessionId: randomUUID(),
  },
  authorization: {
    tenantId: tenant,
    projectId: project,
    purpose: 'research',
    roles: ['data-reader'],
    scopes: ['data.catalog.read'],
    maxSecurityLevel: 'L0_PUBLIC' as const,
    authzVersion: 1,
  },
  traceId: 'a'.repeat(32),
};
describe.skipIf(!url)(
  'resource authority in a disposable control database',
  () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    let client: PoolClient;
    const load = createPostgresResourceAuthorityLoader(async (text, values) => {
      const r = await client.query(text, [...values]);
      return { rows: r.rows };
    });
    beforeAll(async () => {
      client = await pool.connect();
      await client.query('begin');
    });
    afterAll(async () => {
      if (client) {
        await client.query('rollback');
        client.release();
      }
      await pool.end();
    });
    it('preserves an explicitly unconfigured project as legacy', async () => {
      expect(await load(context)).toMatchObject({
        mode: 'legacy',
        tenantId: tenant,
        projectId: project,
        actorId: reader,
        purpose: 'research',
        grants: [],
      });
    });
    it('loads exact package and action versions for the verified subject', async () => {
      await client.query(
        'insert into platform_private.resource_access_settings(project_id,tenant_id,enabled_by) values($1,$2,$3)',
        [project, tenant, owner],
      );
      await client.query(
        "insert into platform_private.resource_package_versions(project_id,package_id,version,name,resources,allowed_actions,license_basis,created_by) values($1,$2,1,'Test package',$3,array['content.read'],'Synthetic licensed resources',$4)",
        [project, packageId, JSON.stringify([resource]), owner],
      );
      await client.query(
        "insert into platform_private.resource_preset_versions(project_id,preset_id,version,name,actions,max_days,approval_level,created_by) values($1,$2,1,'Test reader',array['content.read'],30,'ordinary',$3)",
        [project, presetId, owner],
      );
      await client.query(
        "insert into platform_private.resource_grants(id,project_id,actor_id,package_id,package_version,preset_id,preset_version,purpose,starts_at,expires_at,created_by,approved_by,reason) values($1,$2,$3,$4,1,$5,1,'research',now()-interval '1 minute',now()+interval '1 day',$6,$6,'Synthetic resource acceptance')",
        [grantId, project, reader, packageId, presetId, owner],
      );
      await client.query(
        "insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by) values($1,$2,1,$3,array['content.read'],array['data-steward'],'Synthetic independent source license',now()-interval '1 day',now()+interval '10 days',30,$4,$5)",
        [project, randomUUID(), JSON.stringify(resource), reader, owner],
      );
      const raw = await load(context);
      const { revision, ...input } =
        ResourceAccessAuthoritySnapshotSchema.parse(raw);
      expect(revision).toBe(5);
      expect(compileResourceAccessScope(input)).toMatchObject({
        permissions: { 'content.read': [resource], 'original.read': [] },
      });
    });
    it('does not turn another purpose or subject into a wildcard grant', async () => {
      expect(
        await load({
          ...context,
          authorization: { ...context.authorization, purpose: 'teaching' },
        }),
      ).toMatchObject({ grants: [] });
      expect(
        await load({
          ...context,
          principal: {
            ...context.principal,
            actorId: owner,
            authUserId: owner,
          },
        }),
      ).toMatchObject({ grants: [] });
    });
    it('keeps existing grants on the old package when a new resource version is published', async () => {
      await client.query(
        "insert into platform_private.resource_package_versions(project_id,package_id,version,name,resources,allowed_actions,license_basis,created_by) values($1,$2,2,'Test package v2',$3,array['content.read'],'Synthetic licensed resources',$4)",
        [
          project,
          packageId,
          JSON.stringify([resource, { ...resource, versionId: randomUUID() }]),
          owner,
        ],
      );
      expect(await load(context)).toMatchObject({
        grants: [{ packageVersion: 1, resources: [resource] }],
      });
    });
    it('reflects revocation on the next read without deleting grant history', async () => {
      await client.query(
        'insert into platform_private.resource_revocations(grant_id,project_id,revoked_by,reason) values($1,$2,$3,$4)',
        [grantId, project, owner, 'Synthetic local revocation'],
      );
      expect(await load(context)).toMatchObject({ revision: 7, grants: [] });
      expect(
        (
          await client.query(
            'select id from platform_private.resource_grants where id=$1',
            [grantId],
          )
        ).rowCount,
      ).toBe(1);
    });

    it('fails closed if the live grant set exceeds the bounded authority snapshot', async () => {
      await client.query(
        "insert into platform_private.resource_grants(project_id,actor_id,package_id,package_version,preset_id,preset_version,purpose,starts_at,expires_at,created_by,approved_by,reason) select $1,$2,$3,1,$4,1,'research',now(),now()+interval '1 day',$5,$5,'Synthetic bounded grant check' from generate_series(1,1001)",
        [project, reader, packageId, presetId, owner],
      );
      expect(await load(context)).toBeNull();
    });
  },
);
