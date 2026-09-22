import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PostgresProjectAccessService,
  type PlatformDelegationTransactionPool,
} from '@wiser/platform-auth';
const url = process.env.WISER_ACCESS_TEST_DATABASE_URL;
const owner = '10000000-0000-4000-8000-000000000005',
  project = 'b2000000-0000-4000-8000-000000000001';
describe.skipIf(!url)('isolated project invitation delivery', () => {
  const pool = new Pool({ connectionString: url, max: 5 });
  const session = randomUUID();
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
  const deliver = vi.fn(async (email: string) => {
    const id = randomUUID();
    await pool.query('insert into auth.users(id,email) values($1,$2)', [
      id,
      email,
    ]);
    return { actorId: id };
  });
  const service = new PostgresProjectAccessService({
    pool: transactionPool,
    verifyHuman: (token) =>
      Promise.resolve(
        token === 'owner' ? { userId: owner, sessionId: session } : null,
      ),
    inviteUser: deliver,
  });
  beforeAll(async () => {
    await pool.query('insert into auth.sessions(id,user_id) values($1,$2)', [
      session,
      owner,
    ]);
  });
  afterAll(async () => {
    await pool.end();
  });
  const command = () => ({
    projectId: project,
    email: `invite-${randomUUID()}@example.test`,
    roleKey: 'data-reader',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    reason: 'Synthetic project invitation acceptance',
  });
  it('persists an invitation before delivery and grants once on retry', async () => {
    const key = randomUUID(),
      cmd = command();
    const invitation = await service.invite({
      token: 'owner',
      idempotencyKey: key,
      command: cmd,
    });
    expect(invitation).toMatchObject({
      status: 'pending',
      deliveryMode: 'email',
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      (
        await service.invite({
          token: 'owner',
          idempotencyKey: key,
          command: cmd,
        })
      ).id,
    ).toBe(invitation.id);
    const delivery = {
      projectId: project,
      invitationId: invitation.id,
      expectedVersion: invitation.version,
    };
    const deliveryKey = randomUUID();
    const result = await service.deliverInvitation({
      token: 'owner',
      idempotencyKey: deliveryKey,
      command: delivery,
    });
    expect(result).toMatchObject({ status: 'granted', acceptedAt: null });
    const again = await service.deliverInvitation({
      token: 'owner',
      idempotencyKey: deliveryKey,
      command: delivery,
    });
    expect(again.status).toBe('granted');
    expect(deliver).toHaveBeenCalledTimes(1);
    const grants = await pool.query(
      "select count(*) from platform_private.project_access_events where subject_id=$1 and action='grant'",
      [result.actorId],
    );
    expect(Number(grants.rows[0].count)).toBe(1);
  });
  it('retains a failed delivery without granting and recovers only through an explicit retry', async () => {
    deliver.mockRejectedValueOnce(new Error('private provider detail'));
    const invitation = await service.invite({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: command(),
    });
    const failed = await service.deliverInvitation({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        invitationId: invitation.id,
        expectedVersion: invitation.version,
      },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      lastErrorCode: 'DELIVERY_UNAVAILABLE',
    });
    expect(JSON.stringify(failed)).not.toContain('private provider detail');
    const recovered = await service.deliverInvitation({
      token: 'owner',
      idempotencyKey: randomUUID(),
      command: {
        projectId: project,
        invitationId: failed.id,
        expectedVersion: failed.version,
      },
    });
    expect(recovered.status).toBe('granted');
  });
  it('checks current authority before dispatch and never accepts an administrative role', async () => {
    await expect(
      service.invite({
        token: 'invalid',
        idempotencyKey: randomUUID(),
        command: command(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    await expect(
      service.invite({
        token: 'owner',
        idempotencyKey: randomUUID(),
        command: { ...command(), roleKey: 'platform-owner' },
      }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
  });
});
