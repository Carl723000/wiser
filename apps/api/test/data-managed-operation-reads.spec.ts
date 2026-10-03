import { describe, expect, it } from 'vitest';
import {
  DATA_CAPABILITY_IDS,
  DATA_CAPABILITY_REGISTRY,
} from '@wiser/data-contracts';
import { DataCapabilityHandler } from '../src/data-foundation/capability-handler.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import {
  createPostgresDataReadRuntime,
  type PostgresDataReadClient,
} from '../src/data-foundation/postgres-read-executors.js';

const id = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const alphaId = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context: DataCapabilityExecutionContext = {
  principal: {
    actorId: id(1),
    actorType: 'human',
    authenticationMethod: 'supabase_jwt',
    authUserId: id(1),
    sessionId: id(2),
  },
  authorization: {
    tenantId: id(10),
    projectId: id(11),
    roles: ['data-steward'],
    scopes: ['data.ingestion.write', 'data.operation.read'],
    purpose: 'candidate-review',
    maxSecurityLevel: 'L1_INTERNAL',
    authzVersion: 1,
    resourceAccess: {
      revision: 1,
      fingerprint: 'a'.repeat(64),
      scope: {
        mode: 'managed',
        validUntil: '2099-01-01T00:00:00Z',
        permissions: {
          'content.read': [],
          'original.read': [],
          'result.export': [],
          'source.discover': [],
          'external.directory': [],
        },
      },
    },
  },
  effectiveMaxSecurityLevel: 'L1_INTERNAL',
  traceId: 'b'.repeat(32),
  auditLevel: 'STANDARD',
  timeoutMs: 30000,
  signal: new AbortController().signal,
};
const operationRow = {
  operation_id: id(4),
  tenant_id: id(10),
  project_id: id(11),
  capability_id: 'data.ingestion.create',
  status: 'WAITING_REVIEW',
  progress_percent: 50,
  row_version: 3,
  created_at: '2026-10-03T10:00:00Z',
  updated_at: '2026-10-03T10:01:00Z',
  started_at: null,
  completed_at: null,
  error_code: null,
  error_message: null,
  error_retryable: null,
};
const managedScope = context.authorization.resourceAccess!.scope;
if (managedScope.mode !== 'managed') throw Error('Expected managed fixture');
class Client implements PostgresDataReadClient {
  queries: string[] = [];
  pendingScopeValues: readonly unknown[] | undefined;
  operation: Record<string, unknown> = operationRow;
  eventMessage = 'Review required.';
  access: Record<string, unknown> = {
    operation_id: id(4),
    tenant_id: id(10),
    project_id: id(11),
    capability_id: 'data.ingestion.create',
    actor_id: id(1),
    ingestion_id: id(5),
    owner_project_id: id(11),
    submitted_by_actor_id: id(1),
    submitted_actor_type: 'human',
    submitted_delegator_actor_id: null,
  };
  query(sql: string, values?: readonly unknown[]) {
    this.queries.push(sql);
    if (sql.includes('data.intake.scope')) this.pendingScopeValues = values;
    if (sql.includes('data.operation.intake-access'))
      return Promise.resolve({ rows: [this.access] });
    if (sql.includes('data.operation.get'))
      return Promise.resolve({ rows: [this.operation] });
    if (sql.includes('data.operation.exists'))
      return Promise.resolve({ rows: [{ exists: true }] });
    if (sql.includes('data.operation.events'))
      return Promise.resolve({
        rows: [1, 2].map((sequence) => ({
          event_id: id(20 + sequence),
          operation_id: id(4),
          sequence_number: sequence,
          event_type: 'STATUS_CHANGED',
          to_status: 'WAITING_REVIEW',
          progress_percent: 50,
          operation_version: sequence,
          created_at: '2026-10-03T10:01:00Z',
          message: this.eventMessage,
        })),
      });
    return Promise.resolve({ rows: [] });
  }
  release() {}
}
const capabilities = ['data.operation.get', 'data.operation.events'] as const;
function runtime(client: Client) {
  return createPostgresDataReadRuntime({
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  });
}
function read(
  client: Client,
  capability: (typeof capabilities)[number],
  actor = context,
  after?: string,
  operationId = id(4),
) {
  return runtime(client)
    .executors.find((e) => e.id === capability)!
    .execute(
      {
        operationId,
        ...(capability === 'data.operation.events'
          ? { first: 1, ...(after ? { after } : {}) }
          : {}),
      },
      actor,
    );
}
function reviewer(actorId = id(90)) {
  return {
    ...context,
    principal: { ...context.principal, actorId, authUserId: actorId },
    authorization: {
      ...context.authorization,
      scopes: ['data.operation.read', 'data.publish'],
    },
  };
}
describe('managed standard intake Operation reads', () => {
  it.each(capabilities)(
    'accepts a schema-valid uppercase UUID for %s without changing the identity',
    async (capability) => {
      const client = new Client();
      client.access = { ...client.access, operation_id: alphaId(4) };
      client.operation = { ...client.operation, operation_id: alphaId(4) };
      await expect(
        read(client, capability, context, undefined, alphaId(4).toUpperCase()),
      ).resolves.toBeDefined();
      const { resourceAccess: _, ...legacy } = context.authorization;
      await expect(
        read(
          client,
          capability,
          { ...context, authorization: legacy },
          undefined,
          alphaId(4).toUpperCase(),
        ),
      ).resolves.toBeDefined();
    },
  );
  it.each(capabilities)(
    'canonicalizes validated scope and immutable human responsibility for %s',
    async (capability) => {
      const client = new Client();
      client.access = {
        ...client.access,
        tenant_id: alphaId(10),
        project_id: alphaId(11),
        actor_id: alphaId(1),
        capability_id: 'data.uploadSession.create',
        intake_responsibility: {
          actorId: alphaId(1).toUpperCase(),
          actorType: 'human',
          purpose: 'standard-intake',
        },
      };
      client.operation = {
        ...client.operation,
        tenant_id: alphaId(10),
        project_id: alphaId(11),
      };
      const uppercase = {
        ...context,
        principal: {
          ...context.principal,
          actorId: alphaId(1).toUpperCase(),
          authUserId: alphaId(1).toUpperCase(),
        },
        authorization: {
          ...context.authorization,
          tenantId: alphaId(10).toUpperCase(),
          projectId: alphaId(11).toUpperCase(),
        },
      };
      await expect(read(client, capability, uppercase)).resolves.toBeDefined();
      expect(client.pendingScopeValues?.slice(0, 3)).toEqual([
        alphaId(1),
        'human',
        '',
      ]);
      client.access = {
        ...client.access,
        intake_responsibility: {
          actorId: alphaId(90).toUpperCase(),
          actorType: 'human',
          purpose: 'standard-intake',
        },
      };
      await expect(read(client, capability, uppercase)).rejects.toMatchObject({
        statusCode: 404,
      });
    },
  );
  it.each(capabilities)(
    'canonicalizes an agent and delegator without treating another delegator as owner for %s',
    async (capability) => {
      const client = new Client();
      client.access = {
        ...client.access,
        actor_id: alphaId(90),
        submitted_by_actor_id: alphaId(90),
        submitted_actor_type: 'agent',
        submitted_delegator_actor_id: alphaId(1),
      };
      const agent = {
        ...context,
        principal: {
          actorId: alphaId(90).toUpperCase(),
          actorType: 'agent' as const,
          authenticationMethod: 'delegated_credential' as const,
          credentialId: id(91),
          delegationId: id(92),
          delegatedBy: alphaId(1).toUpperCase(),
        },
      };
      await expect(read(client, capability, agent)).resolves.toBeDefined();
      expect(client.pendingScopeValues?.slice(0, 3)).toEqual([
        alphaId(90),
        'agent',
        alphaId(1),
      ]);
      await expect(
        read(client, capability, {
          ...agent,
          principal: {
            ...agent.principal,
            delegatedBy: alphaId(93).toUpperCase(),
          },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    },
  );
  it('keeps completed and published standard-ingestion Operation DTO behavior', async () => {
    const client = new Client();
    client.operation = {
      ...operationRow,
      status: 'SUCCEEDED',
      progress_percent: 100,
      completed_at: '2026-10-03T10:02:00Z',
    };
    const output = await read(client, 'data.operation.get');
    expect(
      DATA_CAPABILITY_REGISTRY['data.operation.get'].outputSchema.safeParse(
        output,
      ).success,
    ).toBe(true);
    expect(output).toMatchObject({
      status: 'SUCCEEDED',
      completedAt: '2026-10-03T10:02:00Z',
    });
  });
  it('preserves public status/error fields while suppressing upstream diagnostic messages in managed responses', async () => {
    const client = new Client();
    const diagnostic =
      'Read /private/internal/file.csv from http://storage.internal/quarantine/key failed';
    client.operation = {
      ...operationRow,
      status: 'FAILED',
      completed_at: '2026-10-03T10:02:00Z',
      error_code: 'PROCESSING_FAILED',
      error_message: diagnostic,
      error_retryable: true,
    };
    client.eventMessage = diagnostic;
    expect(await read(client, 'data.operation.get')).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'PROCESSING_FAILED',
        message: 'Operation failed.',
        retryable: true,
      },
    });
    expect(
      JSON.stringify(await read(client, 'data.operation.events')),
    ).not.toContain(diagnostic);
    client.operation = {
      ...client.operation,
      error_code: 'http://upstream.internal/private/path',
    };
    expect(await read(client, 'data.operation.get')).toMatchObject({
      error: { code: 'HANDLER_UNEXPECTED' },
    });
    const { resourceAccess: _, ...authorization } = context.authorization;
    expect(
      await read(client, 'data.operation.get', { ...context, authorization }),
    ).toMatchObject({ error: { message: diagnostic } });
  });
  it.each(capabilities)(
    'admits %s through the handler after immutable responsibility guards',
    async (capability) => {
      const client = new Client();
      const selected = runtime(client).executors.find(
        (e) => e.id === capability,
      )!;
      const handler = new DataCapabilityHandler({
        executors: DATA_CAPABILITY_IDS.map((id) =>
          id === capability
            ? selected
            : { id, execute: () => Promise.reject(Error('not used')) },
        ),
        audit: { record: () => Promise.resolve() },
      });
      const output = await handler.execute({
        capabilityId: capability,
        input: {
          operationId: id(4),
          ...(capability === 'data.operation.events' ? { first: 1 } : {}),
        },
        requestContext: {
          principal: context.principal,
          authorization: context.authorization,
          traceId: context.traceId,
        },
      });
      expect(
        DATA_CAPABILITY_REGISTRY[capability].outputSchema.safeParse(output)
          .success,
      ).toBe(true);
      expect(
        client.queries.findIndex((sql) =>
          sql.includes('data.operation.intake-access'),
        ),
      ).toBeGreaterThan(-1);
      expect(JSON.stringify(output)).not.toMatch(
        /intakeResponsibility|submitted_by|storageKey/,
      );
    },
  );

  it.each(capabilities)(
    'allows owned upload and independent human review for %s',
    async (capability) => {
      const client = new Client();
      client.access = {
        ...client.access,
        capability_id: 'data.uploadSession.create',
        intake_responsibility: {
          actorId: id(1),
          actorType: 'human',
          purpose: 'standard-intake',
        },
      };
      await expect(read(client, capability)).resolves.toBeDefined();
      await expect(
        read(client, capability, reviewer(id(80))),
      ).resolves.toBeDefined();
      await expect(
        read(client, capability, reviewer(id(1))),
      ).rejects.toMatchObject({ statusCode: 404 });
      client.access = { ...client.access, intake_responsibility: null };
      await expect(read(client, capability)).rejects.toMatchObject({
        statusCode: 404,
      });
    },
  );

  it.each(capabilities)(
    'denies foreign, unknown and unrelated %s before status/errors/events',
    async (capability) => {
      for (const change of [
        { submitted_by_actor_id: id(90), actor_id: id(90) },
        { submitted_by_actor_id: null, submitted_actor_type: null },
        { actor_id: id(90) },
        { owner_project_id: id(90) },
        { tenant_id: id(90) },
        { project_id: id(90) },
        { capability_id: 'data.reconciliation.create' },
        { ingestion_id: null },
      ]) {
        const client = new Client();
        client.access = { ...client.access, ...change };
        await expect(read(client, capability)).rejects.toMatchObject({
          statusCode: 404,
        });
        expect(
          client.queries.some((sql) =>
            /data\.operation\.(get|events|exists)/.test(sql),
          ),
        ).toBe(false);
      }
    },
  );

  it.each(capabilities)(
    'requires exact delegated responsibility for %s and allows its human delegator',
    async (capability) => {
      const client = new Client();
      client.access = {
        ...client.access,
        actor_id: id(90),
        submitted_by_actor_id: id(90),
        submitted_actor_type: 'agent',
        submitted_delegator_actor_id: id(1),
      };
      const agent = {
        ...context,
        principal: {
          actorId: id(90),
          actorType: 'agent' as const,
          authenticationMethod: 'delegated_credential' as const,
          credentialId: id(91),
          delegationId: id(92),
          delegatedBy: id(1),
        },
      };
      await expect(read(client, capability, agent)).resolves.toBeDefined();
      await expect(read(client, capability)).resolves.toBeDefined();
      await expect(
        read(client, capability, {
          ...agent,
          principal: { ...agent.principal, delegatedBy: id(93) },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        read(client, capability, {
          ...agent,
          principal: { ...agent.principal, actorType: 'service' },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        read(client, capability, reviewer(id(1))),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        read(client, capability, reviewer(id(80))),
      ).resolves.toBeDefined();
      await expect(
        read(client, capability, {
          ...agent,
          authorization: reviewer().authorization,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    },
  );

  it.each(capabilities)(
    'rejects invalid or withdrawn authority before acquiring a client for %s',
    async (capability) => {
      for (const actor of [
        {
          ...context,
          authorization: {
            ...context.authorization,
            scopes: ['data.operation.read'],
          },
        },
        {
          ...context,
          authorization: { ...context.authorization, purpose: '' },
        },
        {
          ...context,
          principal: {
            ...context.principal,
            expiresAt: '2000-01-01T00:00:00Z',
          },
        },
        {
          ...context,
          authorization: {
            ...context.authorization,
            resourceAccess: {
              ...context.authorization.resourceAccess!,
              scope: {
                ...managedScope,
                mode: 'managed' as const,
                validUntil: '2000-01-01T00:00:00Z',
              },
            },
          },
        },
      ]) {
        const client = new Client();
        await expect(read(client, capability, actor)).rejects.toMatchObject({
          statusCode: 403,
        });
        expect(client.queries).toEqual([]);
      }
    },
  );

  it('binds continuation to actor, delegator, purpose and resource scope while accepting a fresh currently authorized purpose', async () => {
    const client = new Client();
    const page = (await read(client, 'data.operation.events')) as {
      nextCursor: string;
    };
    expect(page.nextCursor).toBeDefined();
    await expect(
      read(client, 'data.operation.events', context, page.nextCursor),
    ).resolves.toBeDefined();
    const newPurpose = {
      ...context,
      authorization: { ...context.authorization, purpose: 'water-governance' },
    };
    await expect(
      read(client, 'data.operation.get', newPurpose),
    ).resolves.toBeDefined();
    for (const changed of [
      newPurpose,
      reviewer(),
      {
        ...context,
        authorization: {
          ...context.authorization,
          resourceAccess: {
            ...context.authorization.resourceAccess!,
            fingerprint: 'c'.repeat(64),
          },
        },
      },
    ]) {
      const denied = new Client();
      await expect(
        read(denied, 'data.operation.events', changed, page.nextCursor),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(denied.queries).toEqual([]);
    }
  });

  it.each(capabilities)(
    'preserves legacy %s reads without requiring unknown submission ownership',
    async (capability) => {
      const { resourceAccess: _, ...authorization } = context.authorization;
      const client = new Client();
      client.access = {};
      await expect(
        read(client, capability, { ...context, authorization }),
      ).resolves.toBeDefined();
      expect(client.queries.some((sql) => sql.includes('intake-access'))).toBe(
        false,
      );
    },
  );
});
