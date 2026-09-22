import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresProjectAccessService,
  type PlatformDelegationTransactionPool,
} from '@wiser/platform-auth';
const url = process.env.WISER_ACCESS_TEST_DATABASE_URL;
const owner = '10000000-0000-4000-8000-000000000005',
  project = 'b2000000-0000-4000-8000-000000000001';
describe.skipIf(!url)('project request decisions and effective access', () => {
  const pool = new Pool({ connectionString: url, max: 5 }),
    ownerSession = randomUUID();
  let actorId: string, sessionId: string;
  const transactionPool: PlatformDelegationTransactionPool = {
    async connect() {
      const c = await pool.connect();
      return {
        async query<Row>(sql: string, values: readonly unknown[] = []) {
          const r = await c.query(sql, [...values]);
          return { rows: r.rows as Row[], rowCount: r.rowCount };
        },
        release() {
          c.release();
        },
      };
    },
  };
  const service = new PostgresProjectAccessService({
    pool: transactionPool,
    verifyHuman: (token) =>
      Promise.resolve(
        token === 'owner'
          ? { userId: owner, sessionId: ownerSession }
          : token === 'reader'
            ? { userId: actorId, sessionId }
            : null,
      ),
  });
  beforeAll(async () => {
    await pool.query('insert into auth.sessions(id,user_id) values($1,$2)', [
      ownerSession,
      owner,
    ]);
    await pool.query(
      'insert into platform_private.project_access_settings(project_id,requests_enabled) values($1,true) on conflict(project_id) do update set requests_enabled=true',
      [project],
    );
  });
  beforeEach(async () => {
    actorId = randomUUID();
    sessionId = randomUUID();
    await pool.query('insert into auth.users(id,email) values($1,$2)', [
      actorId,
      `request-${actorId}@example.test`,
    ]);
    await pool.query('insert into auth.sessions(id,user_id) values($1,$2)', [
      sessionId,
      actorId,
    ]);
  });
  afterAll(async () => {
    await pool.end();
  });
  const request = () =>
    service.requestAccess({
      token: 'reader',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        roleKey: 'data-reader',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        reason: 'Read synthetic project evidence',
      },
    });
  it('separates request, independent decision and transactional execution, then reports revocation', async () => {
    const pending = await request();
    expect(pending.status).toBe('pending');
    expect(
      (
        await pool.query(
          'select actor_id from platform.project_memberships where project_id=$1 and actor_id=$2',
          [project, actorId],
        )
      ).rowCount,
    ).toBe(0);
    const approved = await service.decideRequest({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        requestId: pending.id,
        expectedVersion: pending.version,
        decision: 'approve',
        reason: 'Approved for the synthetic review',
      },
    });
    expect(approved.status).toBe('approved');
    expect(
      (
        await pool.query(
          'select actor_id from platform.project_memberships where project_id=$1 and actor_id=$2',
          [project, actorId],
        )
      ).rowCount,
    ).toBe(0);
    const input = {
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        requestId: approved.id,
        expectedVersion: approved.version,
      },
    };
    const applied = await service.executeRequest(input);
    expect(applied).toMatchObject({
      status: 'effective',
      accessState: 'active',
    });
    expect((await service.executeRequest(input)).id).toBe(applied.id);
    const membership = (
      await service.members({
        token: 'owner',
        projectId: project,
        page: { offset: 0, limit: 20, search: actorId },
      })
    ).items[0]!;
    await service.revoke({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        actorId,
        expectedVersion: membership.version,
        reason: 'Synthetic review access revoked',
      },
    });
    const own = await service.requests({
      token: 'reader',
      projectId: project,
      page: { offset: 0, limit: 20, search: '' },
    });
    expect(own.items.find((x) => x.id === applied.id)).toMatchObject({
      status: 'effective',
      accessState: 'revoked',
    });
  });
  it('hides other applicants and rejects caller-supplied identity or role escalation', async () => {
    const pending = await request();
    await expect(
      service.decideRequest({
        token: 'reader',
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          requestId: pending.id,
          expectedVersion: pending.version,
          decision: 'approve',
          reason: 'Not an authorized decision',
        },
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(
      service.requestAccess({
        token: 'reader',
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          roleKey: 'platform-owner',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          reason: 'Role outside the configured policy',
        },
      }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
    const other = randomUUID(),
      otherSession = randomUUID();
    await pool.query('insert into auth.users(id,email) values($1,$2)', [
      other,
      `other-${other}@example.test`,
    ]);
    await pool.query('insert into auth.sessions(id,user_id) values($1,$2)', [
      otherSession,
      other,
    ]);
    const second = new PostgresProjectAccessService({
      pool: transactionPool,
      verifyHuman: () =>
        Promise.resolve({ userId: other, sessionId: otherSession }),
    });
    expect(
      (
        await second.requests({
          token: 'second',
          projectId: project,
          page: { offset: 0, limit: 20, search: '' },
        })
      ).items,
    ).toEqual([]);
    await expect(
      second.withdrawRequest({
        token: 'second',
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          requestId: pending.id,
          expectedVersion: pending.version,
          reason: 'Cannot withdraw another applicant',
        },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_UNAVAILABLE' });
  });
  it('allows withdrawal, rejects stale approval, and never grants rejected requests', async () => {
    const pending = await request();
    const withdrawn = await service.withdrawRequest({
      token: 'reader',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        requestId: pending.id,
        expectedVersion: pending.version,
        reason: 'Applicant no longer needs access',
      },
    });
    expect(withdrawn.status).toBe('withdrawn');
    await expect(
      service.decideRequest({
        token: 'owner',
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          requestId: pending.id,
          expectedVersion: pending.version,
          decision: 'approve',
          reason: 'Stale decision after withdrawal',
        },
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const next = await request();
    const rejected = await service.decideRequest({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        requestId: next.id,
        expectedVersion: next.version,
        decision: 'reject',
        reason: 'Insufficient business justification',
      },
    });
    expect(rejected.status).toBe('rejected');
    await expect(
      service.executeRequest({
        token: 'owner',
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          requestId: rejected.id,
          expectedVersion: rejected.version,
        },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_STATE_CONFLICT' });
  });
  it('does not overwrite a membership changed after submission', async () => {
    const pending = await request();
    const approved = await service.decideRequest({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        requestId: pending.id,
        expectedVersion: pending.version,
        decision: 'approve',
        reason: 'Approved before another operation',
      },
    });
    await service.grant({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        actorId,
        roleKey: 'data-reader',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        reason: 'Independent authorization after request',
        expectedVersion: 0,
      },
    });
    const result = await service.executeRequest({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        requestId: approved.id,
        expectedVersion: approved.version,
      },
    });
    expect(result).toMatchObject({
      status: 'execution_failed',
      lastErrorCode: 'VERSION_CONFLICT',
    });
    expect(
      (
        await service.members({
          token: 'owner',
          projectId: project,
          page: { offset: 0, limit: 20, search: actorId },
        })
      ).items[0]?.version,
    ).toBe(1);
  });
});
