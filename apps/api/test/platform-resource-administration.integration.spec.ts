import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { PostgresResourceAdministrationService } from '@wiser/platform-auth';
import type { PlatformDelegationTransactionPool } from '@wiser/platform-auth';
const url = process.env['WISER_RESOURCE_TEST_DATABASE_URL'];
const project = 'b2000000-0000-4000-8000-000000000001';
const tenant = 'b1000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000005';
const reader = '10000000-0000-4000-8000-000000000001';
const sessions = { owner: randomUUID(), reader: randomUUID() };
const resource = {
  kind: 'version' as const,
  dataItemId: randomUUID(),
  versionId: randomUUID(),
};
const packageCommand = {
  projectId: project,
  packageId: randomUUID(),
  expectedVersion: 0,
  name: 'Synthetic package',
  resources: [resource],
  allowedActions: ['content.read' as const],
  licenseBasis: 'Synthetic permitted test resources',
  reason: 'Synthetic version preservation',
};
const presetCommand = {
  projectId: project,
  presetId: randomUUID(),
  expectedVersion: 0,
  name: 'Synthetic reader',
  actions: ['content.read' as const],
  maxDays: 30,
  approvalLevel: 'ordinary' as const,
  reason: 'Synthetic bounded reader preset',
};
describe.skipIf(!url)(
  'immutable resource administration in isolated control storage',
  () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    let client: PoolClient;
    const txPool: PlatformDelegationTransactionPool = {
      connect: () =>
        Promise.resolve({
          async query<Row>(sql: string, values: readonly unknown[] = []) {
            const text = /^begin\b/i.test(sql)
              ? 'savepoint resource_admin'
              : /^commit\b/i.test(sql)
                ? 'release savepoint resource_admin'
                : /^rollback\b/i.test(sql)
                  ? 'rollback to savepoint resource_admin'
                  : sql;
            const r = await client.query(text, [...values]);
            return { rows: r.rows as Row[], rowCount: r.rowCount };
          },
          release() {},
        }),
    };
    const validatePackage = vi.fn(() => Promise.resolve(true));
    const service = new PostgresResourceAdministrationService({
      pool: txPool,
      validatePackage,
      verifyHuman: (token) =>
        Promise.resolve(
          token === 'owner'
            ? { userId: owner, sessionId: sessions.owner }
            : token === 'reader'
              ? { userId: reader, sessionId: sessions.reader }
              : null,
        ),
    });
    beforeAll(async () => {
      client = await pool.connect();
      await client.query('begin');
      await client.query(
        'insert into auth.sessions(id,user_id) values($1,$2),($3,$4)',
        [sessions.owner, owner, sessions.reader, reader],
      );
      await client.query(
        'insert into platform_private.resource_access_settings(project_id,tenant_id,enabled_by) values($1,$2,$3)',
        [project, tenant, owner],
      );
      // The reader has no business-management scope in this fixture.
      await client.query(
        'delete from platform.role_bindings where actor_id=$1',
        [reader],
      );
    });
    afterAll(async () => {
      if (client) {
        await client.query('rollback');
        client.release();
      }
      await pool.end();
    });
    it('does not accept an unverified caller or a member without management authority', async () => {
      for (const token of ['invalid', 'reader'])
        await expect(
          service.savePackage({
            token,
            command: packageCommand,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toMatchObject({
          code: token === 'invalid' ? 'NOT_AUTHENTICATED' : 'NOT_AUTHORIZED',
        });
      expect(validatePackage).not.toHaveBeenCalled();
    });
    it('persists one immutable package and one audit receipt across an identical retry', async () => {
      const request = {
        token: 'owner',
        command: packageCommand,
        idempotencyKey: randomUUID(),
      };
      const receipt = await service.savePackage(request);
      expect(receipt).toMatchObject({
        kind: 'package',
        id: packageCommand.packageId,
        version: 1,
      });
      expect(await service.savePackage(request)).toEqual(receipt);
      expect(
        (
          await client.query(
            'select * from platform_private.resource_access_events where subject_id=$1',
            [packageCommand.packageId],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        service.savePackage({
          ...request,
          command: { ...packageCommand, name: 'Changed retry' },
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });
    it('adds a new version without replacing the old resource list, rejecting stale edits', async () => {
      const next = {
        ...packageCommand,
        expectedVersion: 1,
        resources: [resource, { ...resource, versionId: randomUUID() }],
      };
      expect(
        await service.savePackage({
          token: 'owner',
          command: next,
          idempotencyKey: randomUUID(),
        }),
      ).toMatchObject({ version: 2 });
      const rows = await client.query(
        'select version,resources from platform_private.resource_package_versions where package_id=$1 order by version',
        [packageCommand.packageId],
      );
      expect(rows.rows).toEqual([
        { version: 1, resources: [resource] },
        { version: 2, resources: next.resources },
      ]);
      await expect(
        service.savePackage({
          token: 'owner',
          command: next,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });
    it('never persists unavailable resources or grants from package creation', async () => {
      validatePackage.mockResolvedValueOnce(false);
      await expect(
        service.savePackage({
          token: 'owner',
          command: { ...packageCommand, packageId: randomUUID() },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
      expect(
        (
          await client.query(
            'select count(*)::int count from platform_private.resource_grants where project_id=$1',
            [project],
          )
        ).rows[0],
      ).toMatchObject({ count: 0 });
    });
    it('creates fixed preset versions and cannot downgrade data egress to ordinary approval', async () => {
      expect(
        await service.savePreset({
          token: 'owner',
          command: presetCommand,
          idempotencyKey: randomUUID(),
        }),
      ).toMatchObject({ kind: 'preset', version: 1 });
      await expect(
        service.savePreset({
          token: 'owner',
          command: {
            ...presetCommand,
            expectedVersion: 1,
            actions: ['original.read'],
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(
        await service.savePreset({
          token: 'owner',
          command: {
            ...presetCommand,
            expectedVersion: 1,
            actions: ['original.read'],
            approvalLevel: 'important',
          },
          idempotencyKey: randomUUID(),
        }),
      ).toMatchObject({ version: 2 });
      expect(
        (
          await client.query(
            'select actions from platform_private.resource_preset_versions where preset_id=$1 and version=1',
            [presetCommand.presetId],
          )
        ).rows[0],
      ).toEqual({ actions: ['content.read'] });
    });
  },
);
