import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  PostgresResourceAdministrationService,
  consumeResourceManagementPermit,
  type PlatformDelegationTransactionPool,
  type ResourceAdministrationOptions,
} from '@wiser/platform-auth';
const url = process.env['WISER_RESOURCE_TEST_DATABASE_URL'];
const project = 'b2000000-0000-4000-8000-000000000001',
  tenant = 'b1000000-0000-4000-8000-000000000001';
const actors = {
  owner: '10000000-0000-4000-8000-000000000005',
  approver: '10000000-0000-4000-8000-000000000002',
  reader: '10000000-0000-4000-8000-000000000001',
};
const sessions = {
  owner: randomUUID(),
  approver: randomUUID(),
  reader: randomUUID(),
};
const proposal = () => ({
  projectId: project,
  policyId: randomUUID(),
  expectedPolicyVersion: 0,
  resource: {
    kind: 'version' as const,
    dataItemId: randomUUID(),
    versionId: randomUUID(),
  },
  allowedActions: ['content.read' as const],
  managementRoles: ['platform-owner'],
  licenseBasis: 'Synthetic source permission evidence',
  startsAt: new Date(Date.now() - 60000).toISOString(),
  expiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
  maxGrantDays: 7,
  reason: 'Synthetic source registration',
});
describe.skipIf(!url)(
  'source stewardship application workflow in isolated control storage',
  () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    let client: PoolClient;
    const txPool: PlatformDelegationTransactionPool = {
      connect: () =>
        Promise.resolve({
          async query<Row>(sql: string, values: readonly unknown[] = []) {
            const text = /^begin\b/i.test(sql)
              ? 'savepoint source_service'
              : /^commit\b/i.test(sql)
                ? 'release savepoint source_service'
                : /^rollback$/i.test(sql)
                  ? 'rollback to savepoint source_service'
                  : sql;
            const result = await client.query(text, [...values]);
            return { rows: result.rows as Row[], rowCount: result.rowCount };
          },
          release() {},
        }),
    };
    const validatePackage = vi.fn<
      ResourceAdministrationOptions['validatePackage']
    >((input) =>
      Promise.resolve(
        consumeResourceManagementPermit(
          input.managementPermit,
          input.context,
          input.command.resources,
          input.command.allowedActions,
        ) !== null,
      ),
    );
    const service = new PostgresResourceAdministrationService({
      pool: txPool,
      validatePackage,
      verifyHuman: (token) => {
        const key = token as keyof typeof actors;
        return Promise.resolve(
          actors[key]
            ? { userId: actors[key], sessionId: sessions[key] }
            : null,
        );
      },
    });
    const submit = (command = proposal(), token = 'owner') =>
      service.proposeSourcePolicy({
        token,
        idempotencyKey: randomUUID(),
        command,
      });
    const decide = (
      id: string,
      decision: 'publish' | 'reject' = 'publish',
      token = 'approver',
      version = 1,
    ) =>
      service.decideSourcePolicy({
        token,
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          requestId: id,
          expectedVersion: version,
          decision,
          reason: 'Independent synthetic review',
        },
      });
    beforeAll(async () => {
      client = await pool.connect();
      await client.query('begin');
      for (const key of Object.keys(actors) as (keyof typeof actors)[])
        await client.query(
          'insert into auth.sessions(id,user_id) values($1,$2)',
          [sessions[key], actors[key]],
        );
      await client.query(
        'insert into platform_private.resource_access_settings(project_id,tenant_id,enabled_by) values($1,$2,$3)',
        [project, tenant, actors.owner],
      );
      const role = randomUUID();
      await client.query(
        "insert into platform.roles(id,role_key,system_id,max_security_level) values($1,'source-reviewer-test','platform','L0_PUBLIC')",
        [role],
      );
      await client.query(
        "insert into platform.role_scopes(role_id,scope) values($1,'platform.access.approve')",
        [role],
      );
      await client.query(
        'insert into platform.role_bindings(actor_id,tenant_id,project_id,role_id,created_by_actor_id) values($1,$2,$3,$4,$5)',
        [actors.approver, tenant, project, role, actors.owner],
      );
      await client.query(
        "insert into platform_private.resource_policy_roles(project_id,role_key,can_propose,can_approve,configured_by,reason) values($1,'platform-owner',true,true,$2,'Synthetic explicit appointment'),($1,'source-reviewer-test',false,true,$2,'Synthetic independent appointment')",
        [project, actors.owner],
      );
    });
    beforeEach(async () => {
      validatePackage.mockClear();
      await client.query('savepoint source_case');
    });
    afterEach(async () => {
      await client.query('rollback to savepoint source_case');
    });
    afterAll(async () => {
      if (client) {
        await client.query('rollback');
        client.release();
      }
      await pool.end();
    });
    it('requires explicit stewardship beyond ordinary membership management', async () => {
      await client.query(
        "update platform_private.resource_policy_roles set active=false where role_key='platform-owner'",
      );
      await expect(submit()).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
      expect(validatePackage).not.toHaveBeenCalled();
    });
    it('registers an immutable proposal idempotently without granting access', async () => {
      const input = {
        token: 'owner',
        idempotencyKey: randomUUID(),
        command: proposal(),
      };
      const first = await service.proposeSourcePolicy(input);
      expect(first).toMatchObject({
        status: 'pending',
        version: 1,
        applicantId: actors.owner,
      });
      expect(await service.proposeSourcePolicy(input)).toEqual(first);
      await expect(
        service.proposeSourcePolicy({
          ...input,
          command: {
            ...input.command,
            licenseBasis: 'Changed source license evidence',
          },
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(
        (
          await client.query(
            'select * from platform_private.resource_policy_versions',
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await client.query('select * from platform_private.resource_grants'))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            'select * from platform_private.resource_access_events where subject_id=$1',
            [first.id],
          )
        ).rowCount,
      ).toBe(1);
    });
    it('rejects caller-supplied authority and ordinary-reader administration', async () => {
      await expect(
        submit({ ...proposal(), approvedBy: actors.owner } as ReturnType<
          typeof proposal
        >),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(submit(proposal(), 'reader')).rejects.toMatchObject({
        code: 'NOT_AUTHORIZED',
      });
      await expect(
        service.sourcePolicyRequests({
          token: 'reader',
          projectId: project,
          page: { offset: 0, limit: 20 },
        }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    });
    it('requires independent review and publishes exactly the submitted evidence', async () => {
      const command = proposal();
      const request = await submit(command);
      await expect(
        decide(request.id, 'publish', 'owner'),
      ).rejects.toMatchObject({ code: 'SELF_CHANGE_FORBIDDEN' });
      const published = await decide(request.id);
      expect(published).toMatchObject({
        status: 'published',
        version: 2,
        publishedVersion: 1,
        decidedBy: actors.approver,
      });
      const result = (
        await client.query(
          'select * from platform_private.resource_policy_versions where policy_id=$1',
          [command.policyId],
        )
      ).rows[0];
      expect(result).toMatchObject({
        resource: command.resource,
        license_basis: command.licenseBasis,
        created_by: actors.owner,
        approved_by: actors.approver,
      });
      expect(validatePackage).toHaveBeenCalledTimes(2);
      expect(
        (await client.query('select * from platform_private.resource_grants'))
          .rowCount,
      ).toBe(0);
    });
    it('rejects or withdraws without creating authority, and refuses stale and terminal decisions', async () => {
      const first = await submit();
      await expect(
        decide(first.id, 'reject', 'approver', 2),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await decide(first.id, 'reject')).toMatchObject({
        status: 'rejected',
      });
      const second = await submit();
      expect(
        await service.withdrawSourcePolicy({
          token: 'owner',
          idempotencyKey: randomUUID(),
          command: {
            projectId: project,
            requestId: second.id,
            expectedVersion: 1,
            reason: 'Synthetic withdrawal reason',
          },
        }),
      ).toMatchObject({ status: 'withdrawn' });
      await expect(
        decide(second.id, 'publish', 'approver', 2),
      ).rejects.toMatchObject({ code: 'REQUEST_STATE_CONFLICT' });
      expect(
        (
          await client.query(
            'select * from platform_private.resource_policy_versions',
          )
        ).rowCount,
      ).toBe(0);
    });
    it.each(['role', 'session'])(
      'rechecks the original applicant %s before publication',
      async (kind) => {
        const request = await submit();
        if (kind === 'role')
          await client.query(
            "update platform_private.resource_policy_roles set can_propose=false where role_key='platform-owner'",
          );
        else
          await client.query('delete from auth.sessions where id=$1', [
            sessions.owner,
          ]);
        await expect(decide(request.id)).rejects.toMatchObject({
          code: 'AUTHORITY_CHANGED',
        });
        expect(
          (
            await client.query(
              'select * from platform_private.resource_policy_versions',
            )
          ).rowCount,
        ).toBe(0);
      },
    );
    it('rechecks source metadata and preserves pending state when it becomes unavailable', async () => {
      const request = await submit();
      validatePackage.mockResolvedValueOnce(false);
      await expect(decide(request.id)).rejects.toMatchObject({
        code: 'RESOURCE_UNAVAILABLE',
      });
      expect(
        (
          await client.query(
            'select status from platform_private.resource_policy_requests where id=$1',
            [request.id],
          )
        ).rows[0],
      ).toEqual({ status: 'pending' });
    });
    it('detects a competing publication and preserves policy identity across updates', async () => {
      const command = proposal(),
        first = await submit(command),
        second = await submit(command);
      await decide(first.id);
      await expect(decide(second.id)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
      });
      await expect(
        submit({
          ...command,
          policyId: randomUUID(),
          expectedPolicyVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      const revision = await submit({
        ...command,
        expectedPolicyVersion: 1,
        licenseBasis: 'Revised synthetic license evidence',
      });
      expect(await decide(revision.id)).toMatchObject({ publishedVersion: 2 });
    });
    it('provides bounded review lists and append-only revocation without deleting publication history', async () => {
      const command = proposal(),
        request = await submit(command);
      await decide(request.id);
      await submit();
      const page = await service.sourcePolicyRequests({
        token: 'approver',
        projectId: project,
        page: { offset: 0, limit: 1 },
      });
      expect(page.items).toHaveLength(1);
      expect(page.hasMore).toBe(true);
      const input = {
        token: 'owner',
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          policyId: command.policyId,
          policyVersion: 1,
          reason: 'Synthetic source revocation',
        },
      };
      const receipt = await service.revokeSourcePolicy(input);
      expect(receipt).toMatchObject({
        policyId: command.policyId,
        policyVersion: 1,
        status: 'revoked',
      });
      expect(await service.revokeSourcePolicy(input)).toEqual(receipt);
      expect(
        (
          await client.query(
            'select * from platform_private.resource_policy_versions',
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await client.query(
            'select * from platform_private.resource_policy_revocations',
          )
        ).rowCount,
      ).toBe(1);
    });
  },
);
