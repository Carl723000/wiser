import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceBatchStore,
  type ResourceAdministrationSession,
} from '../src/resource-batch-service.js';
import { PostgresResourceAdministrationService } from '../src/resource-administration-service.js';
const projectId = randomUUID(),
  actorId = randomUUID(),
  recipient = randomUUID();
const now = new Date('2026-09-23T00:00:00Z');
const command = {
  projectId,
  packageId: randomUUID(),
  packageVersion: 1,
  presetId: randomUUID(),
  presetVersion: 1,
  actorIds: [recipient],
  purpose: 'web-console' as const,
  startsAt: now.toISOString(),
  expiresAt: '2026-09-24T00:00:00Z',
  reason: 'Authorized research review',
};
function fixture() {
  const definition = {
    package_id: command.packageId,
    package_version: 1,
    package_name: 'Research resources',
    resources: [
      { kind: 'version', dataItemId: randomUUID(), versionId: randomUUID() },
    ],
    allowed_actions: ['content.read'],
    license_basis: 'Permitted research use',
    preset_id: command.presetId,
    preset_version: 1,
    preset_name: 'Read only',
    actions: ['content.read'],
    max_days: 30,
    approval_level: 'ordinary',
    latest_package: 1,
    latest_preset: 1,
  };
  const batch = {
    ...definition,
    id: String(randomUUID()),
    project_id: projectId,
    version: 1,
    status: 'pending',
    applicant_id: actorId,
    purpose: 'web-console',
    starts_at: now,
    expires_at: new Date(command.expiresAt),
    valid_until: new Date(now.getTime() + 900000),
    reason: command.reason,
    decided_by: null as string | null,
    decided_session_id: null as string | null,
    decision_reason: null as string | null,
  };
  const members = [
    {
      actor_id: recipient,
      membership_version: '2',
      tenant_membership_version: '3',
      actor_authz_version: '4',
      display_name: 'Research reader',
      existing_grant_count: 0,
      grant_id: null,
      error_code: null,
      attempt: null,
    },
  ];
  const writes: string[] = [];
  const query = <Row>(sql: string, values: readonly unknown[] = []) => {
    let rows: unknown[] = [];
    if (sql.startsWith('select id from platform_private.resource_batches'))
      rows = [{ id: batch.id }, { id: randomUUID() }];
    else if (sql.includes('select statement_timestamp() now')) rows = [{ now }];
    else if (sql.startsWith('select p.package_id')) rows = [definition];
    else if (sql.startsWith('select g.id,p.resources')) rows = [];
    else if (
      sql.startsWith('select * from platform_private.resource_batch_members')
    )
      rows = members;
    else if (sql.includes('from platform.project_memberships')) rows = members;
    else if (sql.startsWith('select * from platform_private.resource_batches'))
      rows = [batch];
    else if (sql.startsWith('select package_id,package_version'))
      rows = [batch];
    else if (sql.startsWith('select m.*,a.grant_id')) rows = members;
    else if (sql.startsWith('insert into platform_private.resource_batches(')) {
      batch.id = String(values[0]);
      writes.push(sql);
    } else if (sql.startsWith('insert into')) writes.push(sql);
    else if (sql.startsWith('update platform_private.resource_batches')) {
      batch.status = sql.includes("status='withdrawn'")
        ? 'withdrawn'
        : String(values[1]);
      batch.version++;
      batch.decided_by = typeof values[2] === 'string' ? values[2] : null;
      batch.decision_reason = typeof values[4] === 'string' ? values[4] : null;
      writes.push(sql);
    } else throw Error('Unexpected storage operation');
    return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
  };
  const session: ResourceAdministrationSession = {
    client: { query, release() {} },
    human: { userId: actorId, sessionId: randomUUID() },
    project: { id: projectId, tenant_id: randomUUID() },
    context: {
      principal: {
        actorType: 'human',
        actorId,
        authUserId: actorId,
        sessionId: randomUUID(),
        authenticationMethod: 'supabase_jwt',
      },
      authorization: {
        tenantId: randomUUID(),
        projectId,
        purpose: 'web-console',
        maxSecurityLevel: 'L1_INTERNAL',
        roles: ['manager'],
        scopes: ['data.catalog.read'],
        authzVersion: 1,
      },
      traceId: 'a'.repeat(32),
    },
  };
  const validate = vi.fn<
    (
      input: Parameters<ConstructorParameters<typeof ResourceBatchStore>[1]>[0],
    ) => Promise<boolean>
  >(() => Promise.resolve(true));
  return {
    definition,
    batch,
    members,
    writes,
    session,
    validate,
    store: new ResourceBatchStore(session, validate),
  };
}
afterEach(() => vi.useRealTimers());
describe('batch service failure and cancellation boundaries', () => {
  it.each(['denied', 'throws', 'timeout'])(
    'never saves a preview when the trusted Data validator %s',
    async (mode) => {
      const f = fixture();
      if (mode === 'denied') f.validate.mockResolvedValue(false);
      if (mode === 'throws')
        f.validate.mockRejectedValue(Error('private upstream detail'));
      if (mode === 'timeout') {
        vi.useFakeTimers();
        f.validate.mockImplementation(() => new Promise(() => {}));
      }
      const result = expect(f.store.preview(command)).rejects.toMatchObject({
        code: 'RESOURCE_UNAVAILABLE',
      });
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(5001);
      await result;
      expect(f.writes).toEqual([]);
      expect(f.validate.mock.calls[0]?.[0].signal.aborted).toBe(true);
    },
  );
  it('persists an explicit preview and audit only after current scoped Data validation', async () => {
    const f = fixture();
    const result = await f.store.preview(command);
    expect(result).toMatchObject({
      status: 'pending',
      members: [
        {
          actorId: recipient,
          membershipVersion: 2,
          status: 'pending',
          grantId: null,
        },
      ],
    });
    expect(f.validate.mock.calls[0]?.[0].context).toBe(f.session.context);
    expect(f.writes).toHaveLength(3);
    expect(f.writes.some((sql) => sql.includes('resource_grants'))).toBe(false);
    expect(f.validate.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });
  it('rejects stale definitions, incompatible actions and missing members before contacting Data', async () => {
    for (const kind of ['version', 'action', 'member']) {
      const f = fixture();
      if (kind === 'version') f.definition.latest_preset = 2;
      if (kind === 'action') f.definition.allowed_actions = [];
      if (kind === 'member') f.members.splice(0);
      await expect(f.store.preview(command)).rejects.toMatchObject({
        code:
          kind === 'version'
            ? 'VERSION_CONFLICT'
            : kind === 'action'
              ? 'VALIDATION_FAILED'
              : 'MEMBERSHIP_CHANGED',
      });
      expect(f.validate).not.toHaveBeenCalled();
      expect(f.writes).toEqual([]);
    }
  });
  it('permits a separate approver to reject an obsolete pending preview without issuing grants', async () => {
    const f = fixture();
    f.session.human = { userId: randomUUID(), sessionId: randomUUID() };
    f.definition.latest_preset = 2;
    const result = await f.store.decide({
      projectId,
      batchId: f.batch.id,
      expectedVersion: 1,
      decision: 'reject',
      reason: 'Obsolete scope requires new preview',
    });
    expect(result.status).toBe('rejected');
    expect(result.version).toBe(2);
    expect(f.writes.some((sql) => sql.includes('resource_grants'))).toBe(false);
  });
  it('does not execute a pending, expired or stale batch', async () => {
    for (const kind of ['pending', 'expired', 'version']) {
      const f = fixture();
      if (kind === 'expired') {
        f.batch.status = 'approved';
        f.batch.valid_until = new Date(now.getTime() - 1);
      }
      await expect(
        f.store.execute({
          projectId,
          batchId: f.batch.id,
          expectedVersion: kind === 'version' ? 2 : 1,
          reason: 'Review before execution',
        }),
      ).rejects.toMatchObject({
        code:
          kind === 'version'
            ? 'VERSION_CONFLICT'
            : kind === 'expired'
              ? 'PREVIEW_EXPIRED'
              : 'REQUEST_STATE_CONFLICT',
      });
      expect(f.writes).toEqual([]);
    }
  });
  it('rejects forged commands and unauthenticated callers before opening a transaction', async () => {
    const connect = vi.fn(() => Promise.reject(Error('must not connect')));
    const service = new PostgresResourceAdministrationService({
      pool: { connect },
      verifyHuman: () => Promise.resolve(null),
      validatePackage: () => Promise.resolve(true),
    });
    const action = {
      projectId,
      batchId: randomUUID(),
      expectedVersion: 1,
      reason: 'Scope review required',
    };
    for (const invoke of [
      () =>
        service.previewBatch({
          token: 'none',
          idempotencyKey: randomUUID(),
          command: { ...command, actorIds: [] },
        }),
      () =>
        service.decideBatch({
          token: 'none',
          idempotencyKey: randomUUID(),
          command: { ...action, decision: 'approve', expectedVersion: 0 },
        }),
      () =>
        service.executeBatch({
          token: 'none',
          idempotencyKey: randomUUID(),
          command: { ...action, reason: '' },
        }),
    ])
      expect(invoke).toThrow('VALIDATION_FAILED');
    for (const result of [
      service.previewBatch({
        token: 'none',
        idempotencyKey: randomUUID(),
        command,
      }),
      service.decideBatch({
        token: 'none',
        idempotencyKey: randomUUID(),
        command: { ...action, decision: 'approve' },
      }),
      service.executeBatch({
        token: 'none',
        idempotencyKey: randomUUID(),
        command: action,
      }),
    ])
      await expect(result).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    expect(connect).not.toHaveBeenCalled();
  });
  it('returns only the bounded page and records own withdrawal without a grant', async () => {
    const f = fixture();
    const page = await f.store.list({ offset: 0, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const result = await f.store.withdraw({
      projectId,
      batchId: f.batch.id,
      expectedVersion: 1,
      reason: 'Withdraw obsolete scope',
    });
    expect(result.status).toBe('withdrawn');
    expect(f.writes.some((sql) => sql.includes('resource_grants'))).toBe(false);
  });
  it('requires authentication and valid paging for batch listing and withdrawal', async () => {
    const connect = vi.fn(() => Promise.reject(Error('must not connect')));
    const service = new PostgresResourceAdministrationService({
      pool: { connect },
      verifyHuman: () => Promise.resolve(null),
      validatePackage: () => Promise.resolve(true),
    });
    expect(() =>
      service.batches({
        token: 'none',
        projectId,
        page: { offset: 0, limit: 21 },
      }),
    ).toThrow('VALIDATION_FAILED');
    expect(() =>
      service.withdrawBatch({
        token: 'none',
        idempotencyKey: randomUUID(),
        command: {
          projectId,
          batchId: randomUUID(),
          expectedVersion: 0,
          reason: 'Withdraw old scope',
        },
      }),
    ).toThrow('VALIDATION_FAILED');
    await expect(
      service.batches({
        token: 'none',
        projectId,
        page: { offset: 0, limit: 20 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    await expect(
      service.withdrawBatch({
        token: 'none',
        idempotencyKey: randomUUID(),
        command: {
          projectId,
          batchId: randomUUID(),
          expectedVersion: 1,
          reason: 'Withdraw old scope',
        },
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    expect(connect).not.toHaveBeenCalled();
  });
});
