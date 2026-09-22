import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { PostgresResourceAdministrationService } from '@wiser/platform-auth';
import type { PlatformDelegationTransactionPool } from '@wiser/platform-auth';
const url = process.env['WISER_RESOURCE_TEST_DATABASE_URL'];
const project = 'b2000000-0000-4000-8000-000000000001',
  tenant = 'b1000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000005',
  approver = '10000000-0000-4000-8000-000000000002';
const reader = '10000000-0000-4000-8000-000000000001',
  second = '10000000-0000-4000-8000-000000000003';
const sessions = {
  owner: randomUUID(),
  approver: randomUUID(),
  reader: randomUUID(),
};
const resource = {
  kind: 'version' as const,
  dataItemId: randomUUID(),
  versionId: randomUUID(),
};
const pack = {
  projectId: project,
  packageId: randomUUID(),
  expectedVersion: 0,
  name: 'Synthetic package',
  resources: [resource],
  allowedActions: ['content.read' as const],
  licenseBasis: 'Synthetic research permit',
  reason: 'Synthetic batch fixture',
};
const preset = {
  projectId: project,
  presetId: randomUUID(),
  expectedVersion: 0,
  name: 'Synthetic read preset',
  actions: ['content.read' as const],
  maxDays: 30,
  approvalLevel: 'ordinary' as const,
  reason: 'Synthetic batch fixture',
};
const preview = {
  projectId: project,
  packageId: pack.packageId,
  packageVersion: 1,
  presetId: preset.presetId,
  presetVersion: 1,
  actorIds: [reader, second],
  purpose: 'web-console' as const,
  startsAt: new Date(Date.now() + 60000).toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  reason: 'Research group review',
};
describe.skipIf(!url)(
  'bounded resource batches in isolated control storage',
  () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    let client: PoolClient;
    let failRecipient = false;
    const txPool: PlatformDelegationTransactionPool = {
      connect: () =>
        Promise.resolve({
          async query<Row>(sql: string, values: readonly unknown[] = []) {
            if (
              failRecipient &&
              /insert into platform_private.resource_grants\(/.test(sql) &&
              values.includes(second)
            ) {
              failRecipient = false;
              throw Error('Synthetic temporary storage failure');
            }
            const text = /^begin\b/i.test(sql)
              ? 'savepoint batch_service'
              : /^commit\b/i.test(sql)
                ? 'release savepoint batch_service'
                : /^rollback$/i.test(sql)
                  ? 'rollback to savepoint batch_service'
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
            : token === 'approver'
              ? { userId: approver, sessionId: sessions.approver }
              : token === 'reader'
                ? { userId: reader, sessionId: sessions.reader }
                : null,
        ),
    });
    beforeAll(async () => {
      client = await pool.connect();
      await client.query('begin');
      await client.query(
        'insert into auth.sessions(id,user_id) values($1,$2),($3,$4),($5,$6)',
        [
          sessions.owner,
          owner,
          sessions.approver,
          approver,
          sessions.reader,
          reader,
        ],
      );
      await client.query(
        'insert into platform_private.resource_access_settings(project_id,tenant_id,enabled_by) values($1,$2,$3)',
        [project, tenant, owner],
      );
      // Separate approval-only role, without membership management or Data read authority.
      const role = randomUUID();
      await client.query(
        "insert into platform.roles(id,role_key,system_id,max_security_level) values($1,'batch-approver-test','platform','L0_PUBLIC')",
        [role],
      );
      await client.query(
        "insert into platform.role_scopes(role_id,scope) values($1,'platform.access.approve')",
        [role],
      );
      await client.query(
        'insert into platform.role_bindings(actor_id,tenant_id,project_id,role_id,created_by_actor_id) values($1,$2,$3,$4,$5),($6,$2,$3,$4,$5)',
        [approver, tenant, project, role, owner, reader],
      );
      await service.savePackage({
        token: 'owner',
        command: pack,
        idempotencyKey: randomUUID(),
      });
      await service.savePreset({
        token: 'owner',
        command: preset,
        idempotencyKey: randomUUID(),
      });
    });
    afterAll(async () => {
      if (client) {
        await client.query('rollback');
        client.release();
      }
      await pool.end();
    });
    it('rejects ordinary callers and invalid ranges without persisting a batch', async () => {
      await expect(
        service.previewBatch({
          token: 'reader',
          command: preview,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
      await expect(
        service.previewBatch({
          token: 'owner',
          command: {
            ...preview,
            expiresAt: new Date(Date.now() + 40 * 86400000).toISOString(),
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(
        (
          await client.query<{ n: number }>(
            'select count(*)::int n from platform_private.resource_batches',
          )
        ).rows[0]!.n,
      ).toBe(0);
    });
    it('preserves explicit members across duplicate previews and grants nothing before execution', async () => {
      const input = {
        token: 'owner',
        command: preview,
        idempotencyKey: randomUUID(),
      };
      const a = await service.previewBatch(input);
      expect(await service.previewBatch(input)).toEqual(a);
      expect(a.status).toBe('pending');
      expect(a.members.map((m) => m.actorId).sort()).toEqual(
        [reader, second].sort(),
      );
      expect(
        a.members.every((m) => m.status === 'pending' && m.grantId === null),
      ).toBe(true);
      expect(
        (
          await client.query<{ n: number }>(
            'select count(*)::int n from platform_private.resource_grants',
          )
        ).rows[0]!.n,
      ).toBe(0);
      await expect(
        service.decideBatch({
          token: 'owner',
          command: {
            projectId: project,
            batchId: a.id,
            expectedVersion: a.version,
            decision: 'approve',
            reason: 'Applicant cannot approve',
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'SELF_CHANGE_FORBIDDEN' });
      await expect(
        service.decideBatch({
          token: 'reader',
          command: {
            projectId: project,
            batchId: a.id,
            expectedVersion: a.version,
            decision: 'approve',
            reason: 'Recipient cannot approve',
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'SELF_CHANGE_FORBIDDEN' });
      const approved = await service.decideBatch({
        token: 'approver',
        command: {
          projectId: project,
          batchId: a.id,
          expectedVersion: a.version,
          decision: 'approve',
          reason: 'Independent scope review',
        },
        idempotencyKey: randomUUID(),
      });
      expect(approved.status).toBe('approved');
      expect(
        (
          await client.query<{ n: number }>(
            'select count(*)::int n from platform_private.resource_grants',
          )
        ).rows[0]!.n,
      ).toBe(0);
      failRecipient = true;
      const partial = await service.executeBatch({
        token: 'owner',
        command: {
          projectId: project,
          batchId: a.id,
          expectedVersion: approved.version,
          reason: 'Execute approved scope',
        },
        idempotencyKey: randomUUID(),
      });
      expect(partial.status).toBe('partial');
      expect(partial.members.find((m) => m.actorId === reader)?.status).toBe(
        'granted',
      );
      expect(partial.members.find((m) => m.actorId === second)?.code).toBe(
        'EXECUTION_FAILED',
      );
      const key = randomUUID(),
        command = {
          projectId: project,
          batchId: a.id,
          expectedVersion: partial.version,
          reason: 'Retry failed recipient',
        };
      const complete = await service.executeBatch({
        token: 'owner',
        command,
        idempotencyKey: key,
      });
      expect(complete.status).toBe('executed');
      expect(complete.members.find((m) => m.actorId === reader)?.attempts).toBe(
        1,
      );
      expect(complete.members.find((m) => m.actorId === second)?.attempts).toBe(
        2,
      );
      expect(
        await service.executeBatch({
          token: 'owner',
          command,
          idempotencyKey: key,
        }),
      ).toEqual(complete);
      expect(
        (
          await client.query<{ n: number }>(
            'select count(*)::int n from platform_private.resource_grants',
          )
        ).rows[0]!.n,
      ).toBe(2);
    });
    it('requires a new preview after package update and never reinterprets an approval', async () => {
      const a = await service.previewBatch({
        token: 'owner',
        command: preview,
        idempotencyKey: randomUUID(),
      });
      const approved = await service.decideBatch({
        token: 'approver',
        command: {
          projectId: project,
          batchId: a.id,
          expectedVersion: 1,
          decision: 'approve',
          reason: 'Independent review',
        },
        idempotencyKey: randomUUID(),
      });
      await service.savePackage({
        token: 'owner',
        command: { ...pack, expectedVersion: 1, name: 'Updated package' },
        idempotencyKey: randomUUID(),
      });
      await expect(
        service.executeBatch({
          token: 'owner',
          command: {
            projectId: project,
            batchId: a.id,
            expectedVersion: approved.version,
            reason: 'Old approval execution',
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(
        (
          await client.query<{ n: number }>(
            'select count(*)::int n from platform_private.resource_grants',
          )
        ).rows[0]!.n,
      ).toBe(2);
    });
    it('does not silently approve important actions with ordinary approval authority', async () => {
      const important = {
        ...preset,
        presetId: randomUUID(),
        approvalLevel: 'important' as const,
      };
      await service.savePreset({
        token: 'owner',
        command: important,
        idempotencyKey: randomUUID(),
      });
      const a = await service.previewBatch({
        token: 'owner',
        command: {
          ...preview,
          packageVersion: 2,
          presetId: important.presetId,
        },
        idempotencyKey: randomUUID(),
      });
      await expect(
        service.decideBatch({
          token: 'approver',
          command: {
            projectId: project,
            batchId: a.id,
            expectedVersion: 1,
            decision: 'approve',
            reason: 'Missing designated role',
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'IMPORTANT_APPROVAL_REQUIRED' });
    });
    async function approvedBatch(actorIds = [reader]) {
      const batch = await service.previewBatch({
        token: 'owner',
        command: { ...preview, packageVersion: 2, actorIds },
        idempotencyKey: randomUUID(),
      });
      return service.decideBatch({
        token: 'approver',
        command: {
          projectId: project,
          batchId: batch.id,
          expectedVersion: 1,
          decision: 'approve',
          reason: 'Independent scope review',
        },
        idempotencyKey: randomUUID(),
      });
    }
    function execution(batch: { id: string; version: number }) {
      return {
        token: 'owner',
        command: {
          projectId: project,
          batchId: batch.id,
          expectedVersion: batch.version,
          reason: 'Execute current approved snapshot',
        },
        idempotencyKey: randomUUID(),
      };
    }
    it('rejects preview key reuse with another recipient selection', async () => {
      const key = randomUUID();
      const input = {
        token: 'owner',
        command: { ...preview, packageVersion: 2 },
        idempotencyKey: key,
      };
      await service.previewBatch(input);
      await expect(
        service.previewBatch({
          ...input,
          command: { ...input.command, actorIds: [reader] },
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });
    it.each(['project', 'tenant', 'actor'] as const)(
      'does not hide a changed %s authority version behind another unchanged version',
      async (kind) => {
        await client.query('savepoint authority_case');
        try {
          const batch = await approvedBatch();
          const sql =
            kind === 'project'
              ? 'update platform.project_memberships set membership_version=membership_version+1 where project_id=$1 and actor_id=$2'
              : kind === 'tenant'
                ? 'update platform.tenant_memberships set membership_version=membership_version+1 where tenant_id=$1 and actor_id=$2'
                : 'update platform.actors set authz_version=authz_version+1 where id=$2 and $1::uuid is not null';
          await client.query(sql, [
            kind === 'tenant' ? tenant : project,
            reader,
          ]);
          const result = await service.executeBatch(execution(batch));
          expect(result.status).toBe('partial');
          expect(result.members[0]).toMatchObject({
            status: 'failed',
            code: 'MEMBERSHIP_CHANGED',
            grantId: null,
            attempts: 1,
          });
          expect(
            (
              await client.query<{ n: number }>(
                'select count(*)::int n from platform_private.resource_batch_attempts where batch_id=$1 and grant_id is not null',
                [batch.id],
              )
            ).rows[0]!.n,
          ).toBe(0);
        } finally {
          await client.query('rollback to savepoint authority_case');
        }
      },
    );
    it.each(['session', 'role'] as const)(
      'rechecks the recorded approver %s before issuing grants',
      async (kind) => {
        await client.query('savepoint approver_case');
        try {
          const batch = await approvedBatch();
          if (kind === 'session')
            await client.query('delete from auth.sessions where id=$1', [
              sessions.approver,
            ]);
          else
            await client.query(
              "update platform.role_bindings set status='revoked' where actor_id=$1 and project_id=$2",
              [approver, project],
            );
          await expect(
            service.executeBatch(execution(batch)),
          ).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
          expect(
            (
              await client.query<{ n: number }>(
                'select count(*)::int n from platform_private.resource_batch_attempts where batch_id=$1',
                [batch.id],
              )
            ).rows[0]!.n,
          ).toBe(0);
        } finally {
          await client.query('rollback to savepoint approver_case');
        }
      },
    );
    it('rechecks Data authority after approval and preserves a retryable approval when unavailable', async () => {
      const batch = await approvedBatch();
      validatePackage.mockResolvedValueOnce(false);
      await expect(
        service.executeBatch(execution(batch)),
      ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
      expect(
        (
          await client.query(
            'select status,version from platform_private.resource_batches where id=$1',
            [batch.id],
          )
        ).rows[0],
      ).toMatchObject({ status: 'approved', version: batch.version });
      expect((await service.executeBatch(execution(batch))).status).toBe(
        'executed',
      );
    });
    it('accepts configured important approval and blocks execution when that designation is withdrawn', async () => {
      await client.query('savepoint important_case');
      try {
        const important = {
          ...preset,
          presetId: randomUUID(),
          approvalLevel: 'important' as const,
        };
        await service.savePreset({
          token: 'owner',
          command: important,
          idempotencyKey: randomUUID(),
        });
        await client.query(
          "insert into platform_private.resource_approval_roles(project_id,role_id,configured_by,reason) select $1,id,$2,'Synthetic designated approval' from platform.roles where role_key='batch-approver-test'",
          [project, owner],
        );
        const pending = await service.previewBatch({
          token: 'owner',
          command: {
            ...preview,
            packageVersion: 2,
            presetId: important.presetId,
          },
          idempotencyKey: randomUUID(),
        });
        const approved = await service.decideBatch({
          token: 'approver',
          command: {
            projectId: project,
            batchId: pending.id,
            expectedVersion: 1,
            decision: 'approve',
            reason: 'Designated important scope review',
          },
          idempotencyKey: randomUUID(),
        });
        await client.query(
          'update platform_private.resource_approval_roles set active=false where project_id=$1',
          [project],
        );
        await expect(
          service.executeBatch(execution(approved)),
        ).rejects.toMatchObject({ code: 'IMPORTANT_APPROVAL_REQUIRED' });
      } finally {
        await client.query('rollback to savepoint important_case');
      }
    });
    it('expires a saved preview without issuing grants or allowing late approval', async () => {
      const now = Date.now();
      const pending = await service.previewBatch({
        token: 'owner',
        command: {
          ...preview,
          packageVersion: 2,
          startsAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 200).toISOString(),
        },
        idempotencyKey: randomUUID(),
      });
      await client.query('select pg_sleep(0.25)');
      await expect(
        service.decideBatch({
          token: 'approver',
          command: {
            projectId: project,
            batchId: pending.id,
            expectedVersion: 1,
            decision: 'approve',
            reason: 'Late review cannot grant',
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
    });
  },
);
