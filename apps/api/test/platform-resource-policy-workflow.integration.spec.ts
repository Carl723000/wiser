import { ResourcePolicyRequestViewSchema } from '@wiser/platform-contracts';
import Fastify from 'fastify';
import { createResourceAdministrationModule } from '../src/platform/resource-administration-module.js';
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
    let inspectionTime: Date | null = null;
    const txPool: PlatformDelegationTransactionPool = {
      connect: () =>
        Promise.resolve({
          async query<Row>(sql: string, values: readonly unknown[] = []) {
            if (sql === 'select statement_timestamp() now' && inspectionTime)
              return { rows: [{ now: inspectionTime }] as Row[], rowCount: 1 };
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
    const catalogResource = {
      dataItemId: randomUUID(),
      versionId: randomUUID(),
    };
    const listManagementCatalog = vi.fn<
      NonNullable<ResourceAdministrationOptions['listManagementCatalog']>
    >((input) => {
      if (
        consumeResourceManagementPermit(
          input.managementPermit,
          input.context,
          [],
          [],
        ) === null
      )
        throw Error('No management permit');
      return Promise.resolve({
        items: [
          {
            ...catalogResource,
            name: 'Synthetic published source',
            sourceOrganization: 'Synthetic provider',
            versionNumber: 1,
            securityLevel: 'L1_INTERNAL',
            processingStage: 'RAW',
            publicationStatus: 'PUBLISHED',
            acceptanceStatus: 'PASSED',
            policyId: null,
            expectedPolicyVersion: 0,
          },
        ],
        hasMore: false,
        checkedAt: new Date().toISOString(),
        managementRoleOptions: [],
      });
    });
    const service = new PostgresResourceAdministrationService({
      pool: txPool,
      validatePackage,
      listManagementCatalog,
      verifyHuman: (token) => {
        const key = token as keyof typeof actors;
        return Promise.resolve(
          actors[key]
            ? { userId: actors[key], sessionId: sessions[key] }
            : null,
        );
      },
    });
    const submit = async (command = proposal(), token = 'owner') =>
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
      inspectionTime = null;
      validatePackage.mockClear();
      listManagementCatalog.mockClear();
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
    it('lists only for currently appointed staff and returns the current fixed-version policy', async () => {
      await expect(
        service.managementCatalog({
          token: 'reader',
          projectId: project,
          page: { offset: 0, limit: 20, search: '' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
      expect(listManagementCatalog).not.toHaveBeenCalled();
      const first = await service.managementCatalog({
        token: 'owner',
        projectId: project,
        page: { offset: 0, limit: 20, search: 'Synthetic' },
      });
      expect(first.items).toMatchObject([
        { ...catalogResource, policyId: null, expectedPolicyVersion: 0 },
      ]);
      expect(first.managementRoleOptions).toContain('platform-owner');
      const command = {
        ...proposal(),
        resource: { kind: 'version' as const, ...catalogResource },
      };
      const request = await submit(command);
      await decide(request.id);
      const updated = await service.managementCatalog({
        token: 'owner',
        projectId: project,
        page: { offset: 0, limit: 20, search: '' },
      });
      expect(updated.items).toMatchObject([
        {
          ...catalogResource,
          policyId: command.policyId,
          expectedPolicyVersion: 1,
        },
      ]);
      await client.query(
        "update platform_private.resource_policy_roles set active=false where role_key='platform-owner'",
      );
      await expect(
        service.managementCatalog({
          token: 'owner',
          projectId: project,
          page: { offset: 0, limit: 20, search: '' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
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
            'select * from platform_private.resource_policy_versions where policy_id=$1',
            [input.command.policyId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            'select * from platform_private.resource_grants where project_id=$1',
            [project],
          )
        ).rowCount,
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
      const result: unknown = (
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
      expect(validatePackage).toHaveBeenCalledTimes(3);
      expect(
        (
          await client.query(
            'select * from platform_private.resource_grants where project_id=$1',
            [project],
          )
        ).rowCount,
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
            'select * from platform_private.resource_policy_versions where policy_id=any($1::uuid[])',
            [[first.policyId, second.policyId]],
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
              'select * from platform_private.resource_policy_versions where policy_id=$1',
              [request.policyId],
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
    it('rechecks the original source policy window at publication after supplier terms change', async () => {
      const command = proposal();
      const request = await submit(command);
      validatePackage.mockImplementationOnce((input) => {
        expect(input.policyWindow).toEqual({
          startsAt: command.startsAt,
          expiresAt: command.expiresAt,
        });
        // The trusted supplier check now rejects the old end date.
        return Promise.resolve(false);
      });
      await expect(decide(request.id)).rejects.toMatchObject({
        code: 'RESOURCE_UNAVAILABLE',
      });
      expect(validatePackage).toHaveBeenCalledTimes(2);
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
    it('refuses a new policy identity for an already published resource', async () => {
      const command = proposal();
      const request = await submit(command);
      await decide(request.id);
      await expect(
        submit({ ...command, policyId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });
    it('rechecks independent reviewer appointment and an expired source period', async () => {
      const request = await submit();
      await client.query(
        "update platform_private.resource_policy_roles set active=false where role_key='source-reviewer-test'",
      );
      await expect(decide(request.id)).rejects.toMatchObject({
        code: 'NOT_AUTHORIZED',
      });
      await expect(
        submit({
          ...proposal(),
          startsAt: new Date(Date.now() - 86400000).toISOString(),
          expiresAt: new Date(Date.now() - 60000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    });
    it('runs authenticated HTTP proposal and publication against the actual control store', async () => {
      const app = Fastify({ logger: false });
      await createResourceAdministrationModule(service).register(app);
      try {
        const command = proposal();
        const response = await app.inject({
          method: 'POST',
          url: '/api/platform/v1/access/source-policies/propose',
          headers: {
            authorization: 'Bearer owner',
            'idempotency-key': randomUUID(),
          },
          payload: command,
        });
        expect(response.statusCode).toBe(200);
        const request = ResourcePolicyRequestViewSchema.parse(response.json());
        expect(request.status).toBe('pending');
        const published = await app.inject({
          method: 'POST',
          url: '/api/platform/v1/access/source-policies/decide',
          headers: {
            authorization: 'Bearer approver',
            'idempotency-key': randomUUID(),
          },
          payload: {
            projectId: project,
            requestId: request.id,
            expectedVersion: 1,
            decision: 'publish',
            reason: 'Independent HTTP review',
          },
        });
        expect(published.statusCode).toBe(200);
        expect(
          ResourcePolicyRequestViewSchema.parse(published.json()).status,
        ).toBe('published');
        expect(published.headers['cache-control']).toBe('private, no-store');
        const denied = await app.inject({
          url: `/api/platform/v1/access/projects/${project}/source-policy-requests`,
          headers: { authorization: 'Bearer reader' },
        });
        expect(denied.statusCode).toBe(403);
        expect(
          (
            await client.query(
              'select approved_by from platform_private.resource_policy_versions where policy_id=$1',
              [command.policyId],
            )
          ).rows[0],
        ).toEqual({ approved_by: actors.approver });
      } finally {
        await app.close();
      }
    });
    it('evaluates scheduled, expired and superseded publication states at the server check time', async () => {
      const command = {
        ...proposal(),
        startsAt: new Date(Date.now() + 86400000).toISOString(),
      };
      const request = await submit(command);
      await decide(request.id);
      const read = () =>
        service.sourcePolicyRequests({
          token: 'approver',
          projectId: project,
          page: { offset: 0, limit: 20, status: 'published' },
        });
      expect((await read()).items[0]).toMatchObject({
        publicationState: 'scheduled',
      });
      inspectionTime = new Date(command.expiresAt);
      const expired = await read();
      expect(expired.checkedAt).toBe(inspectionTime.toISOString());
      expect(expired.items[0]).toMatchObject({
        status: 'published',
        publicationState: 'expired',
      });
      inspectionTime = null;
      const newer = await submit({
        ...command,
        expectedPolicyVersion: 1,
        startsAt: proposal().startsAt,
      });
      await decide(newer.id);
      const current = await read();
      expect(current.items.find((x) => x.id === request.id)).toMatchObject({
        publicationState: 'superseded',
      });
      expect(current.items.find((x) => x.id === newer.id)).toMatchObject({
        publicationState: 'active',
      });
      await service.revokeSourcePolicy({
        token: 'owner',
        idempotencyKey: randomUUID(),
        command: {
          projectId: project,
          policyId: command.policyId,
          policyVersion: 2,
          reason: 'Synthetic newer permission revocation',
        },
      });
      const revoked = await read();
      expect(revoked.items.find((x) => x.id === request.id)).toMatchObject({
        publicationState: 'superseded',
      });
      expect(revoked.items.find((x) => x.id === newer.id)).toMatchObject({
        publicationState: 'revoked',
      });
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
      const publishedPage = () =>
        service.sourcePolicyRequests({
          token: 'approver',
          projectId: project,
          page: { offset: 0, limit: 20, status: 'published' },
        });
      expect((await publishedPage()).items[0]).toMatchObject({
        status: 'published',
        publicationState: 'active',
      });
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
      expect((await publishedPage()).items[0]).toMatchObject({
        status: 'published',
        publicationState: 'revoked',
      });
      expect(
        (
          await client.query(
            'select * from platform_private.resource_policy_versions where policy_id=$1',
            [command.policyId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await client.query(
            'select * from platform_private.resource_policy_revocations where policy_id=$1',
            [command.policyId],
          )
        ).rowCount,
      ).toBe(1);
    });
  },
);
