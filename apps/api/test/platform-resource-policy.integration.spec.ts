import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  compileResourceAccessScope,
  createPostgresResourceAuthorityLoader,
} from '@wiser/platform-auth';
import { ResourceAccessAuthoritySnapshotSchema } from '@wiser/platform-contracts';

const url = process.env['WISER_RESOURCE_TEST_DATABASE_URL'];
const project = randomUUID();
const tenant = 'b1000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000005';
const reader = '10000000-0000-4000-8000-000000000001';
const resource = {
  kind: 'version' as const,
  dataItemId: randomUUID(),
  versionId: randomUUID(),
};
const policyId = randomUUID(),
  packageId = randomUUID(),
  presetId = randomUUID();
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
  traceId: 'b'.repeat(32),
};
describe.skipIf(!url)(
  'trusted source policy in a disposable control database',
  () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    let client: PoolClient;
    const load = createPostgresResourceAuthorityLoader(
      async (text, values) => ({
        rows: (await client.query(text, [...values])).rows,
      }),
    );
    const scope = async () => {
      const { revision: _revision, ...input } =
        ResourceAccessAuthoritySnapshotSchema.parse(await load(context));
      return compileResourceAccessScope(input);
    };
    beforeAll(async () => {
      client = await pool.connect();
      await client.query('begin');
      await client.query(
        "insert into platform.projects(id,tenant_id,slug,name_zh_cn,name_en,created_by_actor_id) values($1,$2,$3,'来源策略隔离测试','Isolated source policy test',$4)",
        [project, tenant, `policy-${project}`, owner],
      );
      await client.query(
        'insert into platform_private.resource_access_settings(project_id,tenant_id,enabled_by) values($1,$2,$3)',
        [project, tenant, owner],
      );
      await client.query(
        "insert into platform_private.resource_package_versions(project_id,package_id,version,name,resources,allowed_actions,license_basis,created_by) values($1,$2,1,'Synthetic package',$3,array['content.read','original.read'],'Package text is not a trusted source license',$4)",
        [project, packageId, JSON.stringify([resource]), owner],
      );
      await client.query(
        "insert into platform_private.resource_preset_versions(project_id,preset_id,version,name,actions,max_days,approval_level,created_by) values($1,$2,1,'Synthetic preset',array['content.read','original.read'],30,'ordinary',$3)",
        [project, presetId, owner],
      );
      await client.query(
        "insert into platform_private.resource_grants(project_id,actor_id,package_id,package_version,preset_id,preset_version,purpose,starts_at,expires_at,created_by,approved_by,reason) values($1,$2,$3,1,$4,1,'research',now()-interval '1 minute',now()+interval '1 day',$5,$5,'Synthetic policy regression')",
        [project, reader, packageId, presetId, owner],
      );
    });
    afterAll(async () => {
      if (client) {
        await client.query('rollback');
        client.release();
      }
      await pool.end();
    });
    const publish = async (
      version: number,
      actions: string[],
      expired = false,
    ) =>
      client.query(
        `insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by) values($1,$2,$3,$4,$5,array['data-steward'],'Synthetic independently approved source policy',now()-interval '2 days',case when $8 then now()-interval '1 hour' else now()+interval '10 days' end,30,$6,$7)`,
        [
          project,
          policyId,
          version,
          JSON.stringify(resource),
          actions,
          reader,
          owner,
          expired,
        ],
      );
    it('denies a managed grant without trusted source policy despite package license text', async () => {
      expect(await load(context)).toMatchObject({
        mode: 'managed',
        limits: [],
      });
      expect(await scope()).toMatchObject({
        permissions: { 'content.read': [], 'original.read': [] },
      });
    });
    it('intersects grant actions with the current exact-resource source policy', async () => {
      await publish(1, ['content.read']);
      expect(await scope()).toMatchObject({
        permissions: { 'content.read': [resource], 'original.read': [] },
      });
      expect(
        await load({
          ...context,
          authorization: { ...context.authorization, tenantId: randomUUID() },
        }),
      ).toBeNull();
    });
    it('uses the latest policy and does not fall back to an earlier broader license', async () => {
      await publish(2, ['source.discover']);
      expect(await load(context)).toMatchObject({
        limits: [{ id: policyId, version: 2 }],
      });
      expect(await scope()).toMatchObject({
        permissions: { 'content.read': [], 'original.read': [] },
      });
    });
    it('does not revive prior permission after current source policy expires', async () => {
      await publish(3, ['content.read', 'original.read'], true);
      expect(await scope()).toMatchObject({
        permissions: { 'content.read': [], 'original.read': [] },
      });
    });
    it('reflects source revocation immediately while preserving grant and policy history', async () => {
      await publish(4, ['content.read', 'original.read']);
      expect(await scope()).toMatchObject({
        permissions: {
          'content.read': [resource],
          'original.read': [resource],
        },
      });
      const before = ResourceAccessAuthoritySnapshotSchema.parse(
        await load(context),
      ).revision;
      await client.query(
        "insert into platform_private.resource_policy_revocations(project_id,policy_id,version,revoked_by,reason) values($1,$2,4,$3,'Synthetic supplier revocation')",
        [project, policyId, owner],
      );
      expect(await load(context)).toMatchObject({
        revision: before + 1,
        limits: [{ version: 4, status: 'revoked' }],
      });
      expect(await scope()).toMatchObject({
        permissions: { 'content.read': [], 'original.read': [] },
      });
      expect(
        (
          await client.query<{ n: number }>(
            'select count(*)::int n from platform_private.resource_policy_versions where project_id=$1 and policy_id=$2',
            [project, policyId],
          )
        ).rows[0]?.n,
      ).toBe(4);
    });
    it('fails closed rather than truncating more than 10000 current source policies', async () => {
      await client.query(
        "insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by) select $1,gen_random_uuid(),1,jsonb_build_object('kind','external-source','sourceId','synthetic-overflow-'||n),array['source.discover'],array['data-steward'],'Synthetic bounded policy check',now(),now()+interval '1 day',1,$2,$3 from generate_series(1,10000) n",
        [project, reader, owner],
      );
      expect(await load(context)).toBeNull();
    }, 30000);
  },
);
