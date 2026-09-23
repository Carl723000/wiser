import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ResourcePolicyStore } from '../src/resource-policy-service.js';
import { PostgresResourceAdministrationService } from '../src/resource-administration-service.js';
import type { ResourceAdministrationSession } from '../src/resource-batch-service.js';
import type { ResourceAdministrationOptions } from '../src/resource-administration-service.js';
const projectId = randomUUID(),
  actorId = randomUUID(),
  sessionId = randomUUID(),
  tenantId = randomUUID();
const proposal = {
  projectId,
  policyId: randomUUID(),
  expectedPolicyVersion: 0,
  resource: {
    kind: 'version' as const,
    dataItemId: randomUUID(),
    versionId: randomUUID(),
  },
  allowedActions: ['content.read' as const],
  managementRoles: ['source-manager'],
  licenseBasis: 'Synthetic permitted use',
  startsAt: '2026-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  maxGrantDays: 7,
  reason: 'Synthetic publication request',
};
function fixture() {
  let appointments = [{ can_propose: true, can_approve: true }];
  const calls: string[] = [];
  const session: ResourceAdministrationSession = {
    project: { id: projectId, tenant_id: tenantId },
    human: { userId: actorId, sessionId },
    context: {
      principal: {
        actorType: 'human',
        actorId,
        authUserId: actorId,
        sessionId,
        authenticationMethod: 'supabase_jwt',
      },
      authorization: {
        tenantId,
        projectId,
        purpose: 'web-console',
        roles: ['source-manager'],
        scopes: ['platform.membership.manage'],
        maxSecurityLevel: 'L1_INTERNAL',
        authzVersion: 1,
      },
      traceId: 'b'.repeat(32),
    },
    client: {
      release() {},
      query<Row>(sql: string) {
        calls.push(sql);
        let rows: unknown[] = [];
        if (sql.includes('from platform_private.resource_policy_roles'))
          rows = appointments;
        else if (sql.includes('from platform_private.resource_policy_versions'))
          rows = [];
        else if (sql === 'select statement_timestamp() now')
          rows = [{ now: new Date() }];
        else
          return Promise.reject(
            Error('Unexpected write in rejected operation'),
          );
        return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
      },
    },
  };
  const validate = vi.fn<ResourceAdministrationOptions['validatePackage']>(() =>
    Promise.resolve(false),
  );
  return {
    session,
    calls,
    validate,
    store: new ResourcePolicyStore(session, validate),
    clearAppointments: () => {
      appointments = [];
    },
  };
}
afterEach(() => vi.useRealTimers());
it('requires both an appointment and the corresponding live base scope', async () => {
  const f = fixture();
  expect(await f.store.authority()).toEqual({
    canPropose: true,
    canApprove: false,
  });
  f.clearAppointments();
  await expect(f.store.requireAuthority('propose')).rejects.toMatchObject({
    code: 'NOT_AUTHORIZED',
  });
  await expect(f.store.requireAuthority('read')).rejects.toMatchObject({
    code: 'NOT_AUTHORIZED',
  });
  await expect(f.store.list({ offset: 0, limit: 20 })).rejects.toMatchObject({
    code: 'NOT_AUTHORIZED',
  });
  const other = fixture();
  other.session.context.authorization.scopes = [];
  await expect(other.store.requireAuthority('approve')).rejects.toMatchObject({
    code: 'NOT_AUTHORIZED',
  });
});
it('fails closed before recording a source proposal when metadata verification fails', async () => {
  const f = fixture();
  await expect(f.store.propose(proposal)).rejects.toMatchObject({
    code: 'RESOURCE_UNAVAILABLE',
  });
  expect(f.calls.some((sql) => /^(insert|update|delete)/.test(sql))).toBe(
    false,
  );
  expect(f.validate.mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(f.session.context.authorization.scopes).toEqual([
    'platform.membership.manage',
  ]);
});
it('aborts timed-out metadata checks without recording a proposal or accepting late success', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let resolve!: (value: boolean) => void;
  f.validate.mockImplementationOnce(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  const request = f.store.propose(proposal);
  const failed = expect(request).rejects.toMatchObject({
    code: 'RESOURCE_UNAVAILABLE',
  });
  await vi.advanceTimersByTimeAsync(5001);
  await failed;
  resolve(true);
  await Promise.resolve();
  expect(f.validate.mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(f.calls.some((sql) => sql.startsWith('insert'))).toBe(false);
});
it('rejects already expired source terms before metadata access', async () => {
  const f = fixture();
  await expect(
    f.store.propose({
      ...proposal,
      startsAt: '2000-01-01T00:00:00Z',
      expiresAt: '2001-01-01T00:00:00Z',
    }),
  ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  expect(f.validate).not.toHaveBeenCalled();
});
it('rejects unauthenticated source commands without connecting to the control database', async () => {
  const connect = vi.fn(() => Promise.reject(Error('Unexpected connection')));
  const service = new PostgresResourceAdministrationService({
    pool: { connect },
    verifyHuman: () => Promise.resolve(null),
    validatePackage: () => Promise.resolve(false),
  });
  const shared = { token: 'invalid', idempotencyKey: randomUUID() },
    action = {
      projectId,
      requestId: randomUUID(),
      expectedVersion: 1,
      reason: 'Synthetic invalid identity',
    };
  for (const call of [
    () => service.proposeSourcePolicy({ ...shared, command: proposal }),
    () =>
      service.decideSourcePolicy({
        ...shared,
        command: { ...action, decision: 'publish' },
      }),
    () => service.withdrawSourcePolicy({ ...shared, command: action }),
    () =>
      service.revokeSourcePolicy({
        ...shared,
        command: {
          projectId,
          policyId: proposal.policyId,
          policyVersion: 1,
          reason: action.reason,
        },
      }),
    () =>
      service.sourcePolicyRequests({
        token: 'invalid',
        projectId,
        page: { offset: 0, limit: 20 },
      }),
  ])
    await expect(call()).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
  expect(connect).not.toHaveBeenCalled();
});
