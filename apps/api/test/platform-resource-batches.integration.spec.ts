import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { createResourceAdministrationModule } from '../src/platform/resource-administration-module.js';
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
  second: randomUUID(),
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
                : token === 'second'
                  ? { userId: second, sessionId: sessions.second }
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
        'insert into auth.sessions(id,user_id) values($1,$2)',
        [sessions.second, second],
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
            "select count(*)::int n from platform_private.resource_batches where project_id='b2000000-0000-4000-8000-000000000001'",
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
            "select count(*)::int n from platform_private.resource_grants where project_id='b2000000-0000-4000-8000-000000000001'",
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
            "select count(*)::int n from platform_private.resource_grants where project_id='b2000000-0000-4000-8000-000000000001'",
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
            "select count(*)::int n from platform_private.resource_grants where project_id='b2000000-0000-4000-8000-000000000001'",
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
            "select count(*)::int n from platform_private.resource_grants where project_id='b2000000-0000-4000-8000-000000000001'",
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
    it('lists bounded project batches for managers and approval-only reviewers, isolated by project', async () => {
      await expect(
        service.batches({
          token: 'second',
          projectId: project,
          page: { offset: 0, limit: 20 },
        }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
      const a = await service.batches({
        token: 'owner',
        projectId: project,
        page: { offset: 0, limit: 1 },
      });
      expect(a.items).toHaveLength(1);
      expect(a.hasMore).toBe(true);
      const review = await service.batches({
        token: 'approver',
        projectId: project,
        page: { offset: 0, limit: 20, status: 'pending' },
      });
      expect(review.items.length).toBeGreaterThan(0);
      expect(
        review.items.every(
          (x) => x.status === 'pending' && x.projectId === project,
        ),
      ).toBe(true);
      await expect(
        service.batches({
          token: 'reader',
          projectId: project,
          page: { offset: 0, limit: 20 },
        }),
      ).resolves.toBeDefined();
      await expect(
        service.batches({
          token: 'owner',
          projectId: randomUUID(),
          page: { offset: 0, limit: 20 },
        }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    });
    it('withdraws only an own pending batch, idempotently, without granting or deleting its history', async () => {
      const pending = await service.previewBatch({
        token: 'owner',
        command: { ...preview, packageVersion: 2 },
        idempotencyKey: randomUUID(),
      });
      const input = {
        token: 'owner',
        command: {
          projectId: project,
          batchId: pending.id,
          expectedVersion: 1,
          reason: 'Withdraw obsolete application',
        },
        idempotencyKey: randomUUID(),
      };
      await expect(
        service.withdrawBatch({ ...input, token: 'approver' }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
      const done = await service.withdrawBatch(input);
      expect(done.status).toBe('withdrawn');
      expect(await service.withdrawBatch(input)).toEqual(done);
      await expect(service.executeBatch(execution(done))).rejects.toMatchObject(
        { code: 'REQUEST_STATE_CONFLICT' },
      );
    });
    it('persists per-member differences and rejects approval after an overlapping grant changes', async () => {
      await client.query('savepoint diff_case');
      try {
        const fresh = {
          ...pack,
          packageId: randomUUID(),
          resources: [{ ...resource, versionId: randomUUID() }],
        };
        await service.savePackage({
          token: 'owner',
          command: fresh,
          idempotencyKey: randomUUID(),
        });
        const from = new Date(Date.now() + 60000),
          middle = new Date(from.getTime() + 3600000),
          until = new Date(from.getTime() + 7200000);
        async function grant(start: Date, end: Date) {
          await client.query(
            "insert into platform_private.resource_grants(project_id,actor_id,package_id,package_version,preset_id,preset_version,purpose,starts_at,expires_at,created_by,approved_by,reason) values($1,$2,$3,1,$4,1,'web-console',$5,$6,$7,$8,'Synthetic overlapping permission')",
            [
              project,
              reader,
              fresh.packageId,
              preset.presetId,
              start,
              end,
              owner,
              approver,
            ],
          );
        }
        await grant(from, middle);
        const pending = await service.previewBatch({
          token: 'owner',
          idempotencyKey: randomUUID(),
          command: {
            ...preview,
            packageId: fresh.packageId,
            startsAt: from.toISOString(),
            expiresAt: until.toISOString(),
          },
        });
        expect(pending.members.find((x) => x.actorId === reader)).toMatchObject(
          { diff: { added: 0, extended: 1, retained: 0, removed: 0 } },
        );
        expect(pending.members.find((x) => x.actorId === second)).toMatchObject(
          { diff: { added: 1, extended: 0, retained: 0, removed: 0 } },
        );
        await grant(middle, until);
        await expect(
          service.decideBatch({
            token: 'approver',
            idempotencyKey: randomUUID(),
            command: {
              projectId: project,
              batchId: pending.id,
              expectedVersion: 1,
              decision: 'approve',
              reason: 'Stale difference must be refreshed',
            },
          }),
        ).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' });
      } finally {
        await client.query('rollback to savepoint diff_case');
      }
    });
    it('fails only a recipient whose overlapping authority changed after approval', async () => {
      await client.query('savepoint changed_grant_case');
      try {
        const approved = await approvedBatch([reader, second]);
        const old = (
          await client.query<{ id: string }>(
            'select id from platform_private.resource_grants g where project_id=$1 and actor_id=$2 and package_id=$3 and not exists(select 1 from platform_private.resource_revocations r where r.grant_id=g.id) limit 1',
            [project, reader, pack.packageId],
          )
        ).rows[0]!;
        await client.query(
          "insert into platform_private.resource_revocations(grant_id,project_id,revoked_by,reason) values($1,$2,$3,'Synthetic intervening revocation')",
          [old.id, project, owner],
        );
        const result = await service.executeBatch(execution(approved));
        expect(result.status).toBe('partial');
        expect(result.members.find((x) => x.actorId === reader)).toMatchObject({
          status: 'failed',
          code: 'ACCESS_CHANGED',
          grantId: null,
        });
        expect(result.members.find((x) => x.actorId === second)).toMatchObject({
          status: 'granted',
          attempts: 1,
        });
        expect(
          (
            await client.query<{ n: number }>(
              'select count(*)::int n from platform_private.resource_revocations where project_id=$1',
              [project],
            )
          ).rows[0]!.n,
        ).toBe(1);
      } finally {
        await client.query('rollback to savepoint changed_grant_case');
      }
    });
    it('lists only own grants without management authority and revokes one immutable grant without touching another', async () => {
      await client.query('savepoint lifecycle_case');
      try {
        const own = await service.grants({
          token: 'reader',
          projectId: project,
          page: { offset: 0, limit: 1 },
        });
        expect(own.items).toHaveLength(1);
        expect(own.hasMore).toBe(true);
        expect(own.items[0]!.actorId).toBe(reader);
        await expect(
          service.grants({
            token: 'reader',
            projectId: project,
            page: { actorId: second, offset: 0, limit: 20 },
          }),
        ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
        const input = {
          token: 'owner',
          idempotencyKey: randomUUID(),
          command: {
            projectId: project,
            grantId: own.items[0]!.id,
            reason: 'End this specific research authorization',
          },
        };
        await expect(
          service.revokeGrant({ ...input, token: 'reader' }),
        ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
        const receipt = await service.revokeGrant(input);
        expect(receipt.alreadyRevoked).toBe(false);
        expect(receipt.otherActiveGrantCount).toBeGreaterThanOrEqual(0);
        expect(await service.revokeGrant(input)).toEqual(receipt);
        expect(
          await service.revokeGrant({ ...input, idempotencyKey: randomUUID() }),
        ).toMatchObject({ alreadyRevoked: true });
        const all = await service.grants({
          token: 'owner',
          projectId: project,
          page: { actorId: reader, offset: 0, limit: 20 },
        });
        expect(
          all.items.find((x) => x.id === input.command.grantId)?.status,
        ).toBe('revoked');
        expect(
          all.items.some(
            (x) => x.id !== input.command.grantId && x.status !== 'revoked',
          ),
        ).toBe(true);
        await expect(
          service.revokeGrant({
            ...input,
            idempotencyKey: randomUUID(),
            command: { ...input.command, projectId: randomUUID() },
          }),
        ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
      } finally {
        await client.query('rollback to savepoint lifecycle_case');
      }
    });
    it('renews by a separately approved future batch without changing the original expiry', async () => {
      await client.query('savepoint renewal_case');
      try {
        const completed = await service.executeBatch(
          execution(await approvedBatch()),
        );
        const grantId = completed.members[0]!.grantId!;
        const prior = (
          await client.query<{ expires_at: Date }>(
            'select expires_at from platform_private.resource_grants where id=$1',
            [grantId],
          )
        ).rows[0]!.expires_at;
        const command = {
          projectId: project,
          grantId,
          expiresAt: new Date(prior.getTime() + 86400000).toISOString(),
          reason: 'Extend approved research collaboration',
        };
        await expect(
          service.renewGrant({
            token: 'reader',
            command,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
        const input = { token: 'owner', command, idempotencyKey: randomUUID() },
          renewal = await service.renewGrant(input);
        expect(await service.renewGrant(input)).toEqual(renewal);
        expect(renewal.previousGrantId).toBe(grantId);
        expect(renewal.batch.status).toBe('pending');
        expect(renewal.batch.startsAt).toBe(prior.toISOString());
        expect(renewal.batch.members[0]!.grantId).toBeNull();
        expect(
          (
            await client.query<{ expires_at: Date }>(
              'select expires_at from platform_private.resource_grants where id=$1',
              [grantId],
            )
          ).rows[0]!.expires_at,
        ).toEqual(prior);
        await service.revokeGrant({
          token: 'owner',
          command: {
            projectId: project,
            grantId,
            reason: 'Withdraw old permission before renewal',
          },
          idempotencyKey: randomUUID(),
        });
        await expect(
          service.renewGrant({ ...input, idempotencyKey: randomUUID() }),
        ).rejects.toMatchObject({ code: 'REQUEST_STATE_CONFLICT' });
      } finally {
        await client.query('rollback to savepoint renewal_case');
      }
    });
    it('roundtrips preview and withdrawal through the HTTP module and actual control storage', async () => {
      const app = Fastify({ logger: false });
      await createResourceAdministrationModule(service).register(app);
      try {
        const headers = {
          authorization: 'Bearer owner',
          'idempotency-key': randomUUID(),
        };
        const created = await app.inject({
          method: 'POST',
          url: '/api/platform/v1/access/resource-batches/preview',
          headers,
          payload: { ...preview, packageVersion: 2 },
        });
        expect(created.statusCode).toBe(200);
        const body = created.json<{ id: string; version: number }>();
        const listed = await app.inject({
          url: `/api/platform/v1/access/projects/${project}/resource-batches?status=pending`,
          headers: { authorization: 'Bearer approver' },
        });
        expect(listed.statusCode).toBe(200);
        expect(listed.body).toContain(body.id);
        const withdrawn = await app.inject({
          method: 'POST',
          url: '/api/platform/v1/access/resource-batches/withdraw',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: {
            projectId: project,
            batchId: body.id,
            expectedVersion: body.version,
            reason: 'Close obsolete request',
          },
        });
        expect(withdrawn.statusCode).toBe(200);
        expect(withdrawn.json<{ status: string }>().status).toBe('withdrawn');
        expect(
          (
            await client.query<{ n: number }>(
              "select count(*)::int n from platform_private.resource_access_events where subject_id=$1 and action='withdraw'",
              [body.id],
            )
          ).rows[0]!.n,
        ).toBe(1);
      } finally {
        await app.close();
      }
    });
  },
);
