import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresProjectAccessService,
  createPostgresAuthorizationContextLoader,
} from '@wiser/platform-auth';
import type { PlatformDelegationTransactionPool } from '@wiser/platform-auth';

const url = process.env['WISER_ACCESS_TEST_DATABASE_URL'];
const owner = '10000000-0000-4000-8000-000000000005';
const project = 'b2000000-0000-4000-8000-000000000001';
const tenant = 'b1000000-0000-4000-8000-000000000001';
const ownerSession = randomUUID();
const reader = randomUUID();
const readerSession = randomUUID();
const deadline = new Date(Date.now() + 86400000).toISOString();
const grantKey = randomUUID();
const initialGrant = {
  projectId: project,
  actorId: reader,
  roleKey: 'data-reader',
  expiresAt: deadline,
  reason: 'Read the synthetic project.',
  expectedVersion: 0,
};

describe.skipIf(url === undefined)(
  'project access with isolated control database',
  () => {
    const pool = new Pool({ connectionString: url, max: 5 });
    const transactionPool: PlatformDelegationTransactionPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query<Row>(text: string, values: readonly unknown[] = []) {
            const r = await client.query(text, [...values]);
            return { rows: r.rows as Row[], rowCount: r.rowCount };
          },
          release() {
            client.release();
          },
        };
      },
    };
    const service = new PostgresProjectAccessService({
      pool: transactionPool,
      verifyHuman: (token: string) =>
        Promise.resolve(
          token === 'owner'
            ? { userId: owner, sessionId: ownerSession }
            : token === 'reader'
              ? { userId: reader, sessionId: readerSession }
              : null,
        ),
    });
    beforeAll(async () => {
      await pool.query('insert into auth.users(id,email) values($1,$2)', [
        reader,
        `access-${reader}@example.test`,
      ]);
      await pool.query(
        'insert into auth.sessions(id,user_id) values($1,$2),($3,$4)',
        [ownerSession, owner, readerSession, reader],
      );
      await pool.query(
        `insert into platform_private.project_access_settings(project_id,requests_enabled) values($1,true) on conflict(project_id) do update set requests_enabled=true`,
        [project],
      );
      await pool.query(
        `insert into platform_private.project_access_roles(project_id,role_id,max_days) select $1,id,30 from platform.roles where role_key='data-reader' on conflict do nothing`,
        [project],
      );
    });
    afterAll(async () => {
      await pool.end();
    });
    it('requires a live direct human session and never treats a UUID as authentication', async () => {
      await expect(
        service.projects({
          token: 'invalid',
          page: { offset: 0, limit: 20, search: '' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    });
    it('shows only explicitly requestable projects to a non-member and denies member enumeration', async () => {
      const projects = await service.projects({
        token: 'reader',
        page: { offset: 0, limit: 20, search: '' },
      });
      expect(projects.items.find((p) => p.projectId === project)).toMatchObject(
        { canManage: false, memberStatus: null },
      );
      await expect(
        service.members({
          token: 'reader',
          projectId: project,
          page: { offset: 0, limit: 20, search: '' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    });
    it('grants a bounded existing role atomically, with one audit event for a retry', async () => {
      const idempotencyKey = grantKey;
      const command = initialGrant;
      const first = await service.grant({
        token: 'owner',
        idempotencyKey,
        command,
      });
      expect(first).toMatchObject({
        actorId: reader,
        status: 'active',
        version: 1,
      });
      expect(
        await service.grant({ token: 'owner', idempotencyKey, command }),
      ).toEqual(first);
      const rows = await pool.query(
        'select * from platform_private.project_access_events where project_id=$1 and subject_id=$2',
        [project, reader],
      );
      expect(rows.rowCount).toBe(1);
      const audit = await pool.query(
        "select id from platform_private.authorization_audit_events where project_id=$1 and resource_id=$2 and capability='platform.membership.manage'",
        [project, reader],
      );
      const outbox = await pool.query(
        "select id from platform_private.control_outbox where aggregate_id=$1 and payload->>'subjectId'=$2 and event_type='project.member.grant'",
        [project, reader],
      );
      expect(audit.rowCount).toBe(1);
      expect(outbox.rowCount).toBe(1);

      await expect(
        service.grant({
          token: 'owner',
          idempotencyKey,
          command: { ...command, reason: 'Different command payload.' },
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });
    it('rejects self-elevation and stale writes without changing membership', async () => {
      const base = {
        projectId: project,
        actorId: reader,
        roleKey: 'data-reader',
        expiresAt: deadline,
        reason: 'Change the test grant.',
        expectedVersion: 0,
      };
      await expect(
        service.grant({
          token: 'owner',
          idempotencyKey: randomUUID(),
          command: base,
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(
        service.grant({
          token: 'owner',
          idempotencyKey: randomUUID(),
          command: { ...base, actorId: owner, expectedVersion: 1 },
        }),
      ).rejects.toMatchObject({ code: 'SELF_CHANGE_FORBIDDEN' });
    });
    it('revokes only the chosen project and prevents replay from restoring a grant', async () => {
      const members = await service.members({
        token: 'owner',
        projectId: project,
        page: { offset: 0, limit: 50, search: reader },
      });
      const member = members.items.find((m) => m.actorId === reader);
      expect(member).toBeDefined();
      await service.revoke({
        token: 'owner',
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          actorId: reader,
          reason: 'Review period completed.',
          expectedVersion: member!.version,
        },
      });
      await service.grant({
        token: 'owner',
        idempotencyKey: grantKey,
        command: initialGrant,
      });
      const r = await pool.query<{ status: string }>(
        'select status from platform.project_memberships where project_id=$1 and actor_id=$2',
        [project, reader],
      );
      expect(r.rows[0]?.status).toBe('revoked');
      const t = await pool.query<{ status: string }>(
        'select status from platform.tenant_memberships where tenant_id=$1 and actor_id=$2',
        [tenant, reader],
      );
      expect(t.rows[0]?.status).toBe('active');
      const projects = await service.projects({
        token: 'reader',
        page: { offset: 0, limit: 50, search: '' },
      });
      expect(projects.items.find((p) => p.projectId === project)).toMatchObject(
        { memberStatus: 'revoked', roles: [] },
      );
    });
    it('does not activate a tenant administrator through a new ordinary project membership', async () => {
      const target = randomUUID();
      await pool.query('insert into auth.users(id,email) values($1,$2)', [
        target,
        `protected-${target}@example.test`,
      ]);
      await pool.query(
        'insert into platform.tenant_memberships(tenant_id,actor_id) values($1,$2)',
        [tenant, target],
      );
      await pool.query(
        `insert into platform.role_bindings(id,actor_id,tenant_id,role_id,created_by_actor_id) select $1,$2,$3,id,$4 from platform.roles where role_key='platform-owner'`,
        [randomUUID(), target, tenant, owner],
      );
      await expect(
        service.grant({
          token: 'owner',
          idempotencyKey: randomUUID(),
          command: { ...initialGrant, actorId: target },
        }),
      ).rejects.toMatchObject({ code: 'PROTECTED_MEMBER' });
      const rows = await pool.query(
        'select 1 from platform.project_memberships where project_id=$1 and actor_id=$2',
        [project, target],
      );
      expect(rows.rowCount).toBe(0);
    });
    it('allows only one of two concurrent writes based on the same membership version', async () => {
      const version = (
        await pool.query<{ membership_version: number }>(
          'select membership_version from platform.project_memberships where project_id=$1 and actor_id=$2',
          [project, reader],
        )
      ).rows[0]?.membership_version;
      const attempts = await Promise.allSettled(
        [1, 2].map((i) =>
          service.grant({
            token: 'owner',
            idempotencyKey: randomUUID(),
            command: {
              ...initialGrant,
              reason: `Concurrent test command ${i}.`,
              expectedVersion: Number(version),
            },
          }),
        ),
      );
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.find((a) => a.status === 'rejected')).toMatchObject({
        reason: { code: 'VERSION_CONFLICT' },
      });
    });

    it('advances effective authorization even when the project version is already higher', async () => {
      await pool.query(
        'update platform.projects set version=version+1000 where id=$1',
        [project],
      );
      const load = createPostgresAuthorizationContextLoader(
        async (sql, values) => pool.query(sql, [...values]),
      );
      const input = {
        actorId: reader,
        sessionId: readerSession,
        tenantId: tenant,
        projectId: project,
        purpose: 'project-access',
      };
      const before = await load(input);
      expect(before).not.toBeNull();
      const version = (
        await pool.query<{ membership_version: number }>(
          'select membership_version from platform.project_memberships where project_id=$1 and actor_id=$2',
          [project, reader],
        )
      ).rows[0]?.membership_version;
      await service.grant({
        token: 'owner',
        idempotencyKey: randomUUID(),
        command: { ...initialGrant, expectedVersion: Number(version) },
      });
      const after = await load(input);
      expect(after!.authzVersion).toBeGreaterThan(before!.authzVersion);
    });
  },
);
