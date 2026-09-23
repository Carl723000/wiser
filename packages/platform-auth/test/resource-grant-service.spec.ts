import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ResourceGrantStore } from '../src/resource-grant-service.js';
import { PostgresResourceAdministrationService } from '../src/resource-administration-service.js';
import type { ResourceAdministrationSession } from '../src/resource-batch-service.js';
function fixture() {
  const project = randomUUID(),
    actor = randomUUID(),
    now = new Date('2026-09-23T00:00:00Z');
  const row = {
    id: randomUUID(),
    actor_id: actor,
    package_id: randomUUID(),
    package_version: 1,
    package_name: 'Research',
    preset_id: randomUUID(),
    preset_version: 1,
    preset_name: 'Read',
    actions: ['content.read'],
    resource_count: 1,
    purpose: 'web-console',
    starts_at: now,
    expires_at: new Date('2026-09-24T00:00:00Z'),
    status: 'active',
    revoked_at: null as Date | null,
    reason: 'Research permission',
    revocation_reason: null,
    created_by: randomUUID(),
    approved_by: randomUUID(),
  };
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  let missing = false,
    denyAudit = false;
  const session: ResourceAdministrationSession = {
    project: { id: project, tenant_id: randomUUID() },
    human: { userId: actor, sessionId: randomUUID() },
    context: {
      principal: {
        actorType: 'human',
        actorId: actor,
        authUserId: actor,
        sessionId: randomUUID(),
        authenticationMethod: 'supabase_jwt',
      },
      authorization: {
        tenantId: randomUUID(),
        projectId: project,
        purpose: 'web-console',
        roles: ['reader'],
        scopes: ['data.catalog.read'],
        maxSecurityLevel: 'L1_INTERNAL',
        authzVersion: 1,
      },
      traceId: 'a'.repeat(32),
    },
    client: {
      release() {},
      query<Row>(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        let rows: unknown[] = [];
        if (sql.startsWith('select statement_timestamp()')) rows = [{ now }];
        else if (sql.startsWith('select * from ('))
          rows = [row, { ...row, id: randomUUID() }];
        else if (sql.startsWith('select g.*,p.name'))
          rows = missing ? [] : [row];
        else if (
          sql.startsWith('insert into platform_private.resource_revocations')
        )
          rows = [{ revoked_at: now }];
        else if (sql.startsWith('select count(*)::int n')) rows = [{ n: 1 }];
        else if (
          sql.startsWith('insert into platform_private.resource_access_events')
        ) {
          if (denyAudit)
            return Promise.reject(Error('Synthetic audit failure'));
        } else return Promise.reject(Error('Unexpected operation'));
        return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
      },
    },
  };
  const validator = vi.fn(() => Promise.resolve(true));
  return {
    row,
    session,
    calls,
    store: new ResourceGrantStore(session, validator),
    missing() {
      missing = true;
    },
    denyAudit() {
      denyAudit = true;
    },
  };
}
it('limits ordinary users to their own project records and preserves bounded pagination', async () => {
  const f = fixture();
  await expect(
    f.store.list({ actorId: randomUUID(), offset: 0, limit: 1 }),
  ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  expect(f.calls).toEqual([]);
  const list = await f.store.list({ offset: 0, limit: 1 });
  expect(list.items).toHaveLength(1);
  expect(list.hasMore).toBe(true);
  expect(list.items[0]).toMatchObject({
    actorId: f.session.human.userId,
    status: 'active',
    revokedAt: null,
  });
  expect(f.calls[0]?.values.slice(0, 2)).toEqual([
    f.session.project.id,
    f.session.human.userId,
  ]);
});
it('permits managers to inspect selected members while retaining project and status filters', async () => {
  const f = fixture();
  f.session.context.authorization.scopes.push('platform.membership.manage');
  const other = randomUUID();
  await f.store.list({
    actorId: other,
    offset: 20,
    limit: 20,
    status: 'revoked',
  });
  expect(f.calls[0]?.values).toEqual([
    f.session.project.id,
    other,
    'revoked',
    20,
    21,
  ]);
});
it('preserves the first revocation and reports independent active records separately', async () => {
  const f = fixture();
  f.row.revoked_at = new Date('2026-09-22T00:00:00Z');
  expect(
    await f.store.revoke({
      projectId: f.session.project.id,
      grantId: f.row.id,
      reason: 'Do not replace previous reason',
    }),
  ).toMatchObject({
    alreadyRevoked: true,
    otherActiveGrantCount: 1,
    revokedAt: '2026-09-22T00:00:00.000Z',
  });
  expect(f.calls.some((x) => x.sql.startsWith('insert'))).toBe(false);
});
it('records exactly one selected grant and fails the transaction when audit persistence fails', async () => {
  const f = fixture(),
    command = {
      projectId: f.session.project.id,
      grantId: f.row.id,
      reason: 'End this project resource permission',
    };
  expect(await f.store.revoke(command)).toMatchObject({
    grantId: f.row.id,
    alreadyRevoked: false,
    otherActiveGrantCount: 1,
  });
  const writes = f.calls.filter((x) => x.sql.startsWith('insert'));
  expect(writes).toHaveLength(2);
  expect(writes[0]?.values.slice(0, 2)).toEqual([
    f.row.id,
    f.session.project.id,
  ]);
  expect(f.calls.some((x) => /delete|update/i.test(x.sql))).toBe(false);
  const failed = fixture();
  failed.denyAudit();
  await expect(
    failed.store.revoke({
      ...command,
      projectId: failed.session.project.id,
      grantId: failed.row.id,
    }),
  ).rejects.toThrow('Synthetic audit failure');
});
it('rejects absent grants, revoked renewals, unsupported purposes and non-extending expiry', async () => {
  const f = fixture(),
    command = {
      projectId: f.session.project.id,
      grantId: f.row.id,
      reason: 'Extend scoped research',
      expiresAt: '2026-09-25T00:00:00Z',
    };
  f.row.revoked_at = new Date();
  await expect(f.store.renew(command)).rejects.toMatchObject({
    code: 'REQUEST_STATE_CONFLICT',
  });
  f.row.revoked_at = null;
  f.row.purpose = 'mcp-tool';
  await expect(f.store.renew(command)).rejects.toMatchObject({
    code: 'REQUEST_STATE_CONFLICT',
  });
  f.row.purpose = 'web-console';
  await expect(
    f.store.renew({ ...command, expiresAt: '2026-09-23T00:00:00Z' }),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  f.missing();
  await expect(f.store.revoke(command)).rejects.toMatchObject({
    code: 'RESOURCE_UNAVAILABLE',
  });
});
it('rejects malformed lifecycle commands before opening a control transaction', () => {
  const connect = vi.fn(() => Promise.reject(Error('Must not connect')));
  const service = new PostgresResourceAdministrationService({
    pool: { connect },
    verifyHuman: () => Promise.resolve(null),
    validatePackage: () => Promise.resolve(false),
  });
  expect(() =>
    service.grants({
      token: 'irrelevant',
      projectId: randomUUID(),
      page: { offset: 0, limit: 21 },
    }),
  ).toThrow('VALIDATION_FAILED');
  expect(() =>
    service.revokeGrant({
      token: 'irrelevant',
      idempotencyKey: randomUUID(),
      command: {
        projectId: randomUUID(),
        grantId: 'bad',
        reason: 'Invalid grant',
      },
    }),
  ).toThrow('VALIDATION_FAILED');
  expect(() =>
    service.renewGrant({
      token: 'irrelevant',
      idempotencyKey: randomUUID(),
      command: {
        projectId: randomUUID(),
        grantId: randomUUID(),
        reason: 'Invalid expiry',
        expiresAt: 'bad',
      },
    }),
  ).toThrow('VALIDATION_FAILED');
  expect(connect).not.toHaveBeenCalled();
});
