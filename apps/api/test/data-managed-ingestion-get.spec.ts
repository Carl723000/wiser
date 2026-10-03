import { describe, expect, it } from 'vitest';
import {
  DATA_CAPABILITY_REGISTRY,
  DATA_CAPABILITY_ARCHIVE,
  DATA_CAPABILITY_IDS,
} from '@wiser/data-contracts';
import { DataCapabilityHandler } from '../src/data-foundation/capability-handler.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import {
  createPostgresDataReadRuntime,
  type PostgresDataReadClient,
} from '../src/data-foundation/postgres-read-executors.js';
import {
  canReadPendingSubmission,
  ownsPendingSubmission,
} from '../src/data-foundation/managed-ingestion-access.js';

const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const alphaId = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id(4),
  processingBatchId: id(5),
  reviewHash: 'c'.repeat(64),
};
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
class Client implements PostgresDataReadClient {
  queries: string[] = [];
  pendingScopeValues: readonly unknown[] | undefined;
  hasCandidate = true;
  responsibility: Record<string, unknown> = {
    submitted_by_actor_id: id(1),
    submitted_actor_type: 'human',
    submitted_delegator_actor_id: null,
  };
  query(text: string, values?: readonly unknown[]) {
    this.queries.push(text);
    if (text.includes('data.intake.scope')) this.pendingScopeValues = values;
    if (text.includes('data.ingestion.get'))
      return Promise.resolve({
        rows: [
          {
            ingestion_id: id(4),
            tenant_id: id(10),
            project_id: id(11),
            owner_project_id: id(11),
            asset_ids: [id(6)],
            intended_uses: ['water-quality'],
            requested_security_level: 'L1_INTERNAL',
            state: 'REVIEW_REQUIRED',
            operation_id: id(7),
            row_version: 2,
            created_at: '2026-10-03T10:00:00Z',
            updated_at: '2026-10-03T10:00:00Z',
            ...this.responsibility,
          },
        ],
      });
    if (text.includes('data.ingestion.candidate.reference'))
      return Promise.resolve({
        rows: this.hasCandidate
          ? [
              {
                ingestion_id: id(4),
                processing_batch_id: id(5),
                review_hash: reference.reviewHash,
              },
            ]
          : [],
      });
    return Promise.resolve({ rows: [] });
  }
  release() {}
}
function get(client: Client, actor = context) {
  const runtime = createPostgresDataReadRuntime({
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  });
  return runtime.executors
    .find((executor) => executor.id === 'data.ingestion.get')!
    .execute({ ingestionId: id(4) }, actor);
}
describe('managed ingestion discovery', () => {
  it('uses one UUID identity for pending ownership and independent review', () => {
    const sameActor = {
      ...context,
      principal: {
        ...context.principal,
        actorId: alphaId(1).toUpperCase(),
        authUserId: alphaId(1).toUpperCase(),
      },
    };
    const responsibility = { actorId: alphaId(1), actorType: 'human' };
    expect(ownsPendingSubmission(sameActor, responsibility)).toBe(true);
    expect(
      canReadPendingSubmission(sameActor, responsibility, {
        maintainer: false,
        reviewer: true,
      }),
    ).toBe(false);
    expect(
      ownsPendingSubmission(
        {
          ...sameActor,
          principal: { ...sameActor.principal, actorId: alphaId(90) },
        },
        responsibility,
      ),
    ).toBe(false);
  });

  it('does not expose an author to themselves as an uppercase independent reviewer', async () => {
    const client = new Client();
    client.responsibility.submitted_by_actor_id = alphaId(1);
    const reviewer = {
      ...context,
      principal: {
        ...context.principal,
        actorId: alphaId(1).toUpperCase(),
        authUserId: alphaId(1).toUpperCase(),
      },
      authorization: {
        ...context.authorization,
        scopes: ['data.operation.read', 'data.publish'],
      },
    };
    await expect(get(client, reviewer)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(client.pendingScopeValues?.[0]).toBe(alphaId(1));
  });

  it('accepts uppercase owner and delegator UUIDs but rejects another delegator', async () => {
    const client = new Client();
    client.responsibility.submitted_by_actor_id = alphaId(90);
    client.responsibility.submitted_actor_type = 'agent';
    client.responsibility.submitted_delegator_actor_id = alphaId(1);
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
    await expect(get(client, agent)).resolves.toBeDefined();
    expect(client.pendingScopeValues?.slice(0, 3)).toEqual([
      alphaId(90),
      'agent',
      alphaId(1),
    ]);
    await expect(
      get(client, {
        ...agent,
        principal: {
          ...agent.principal,
          delegatedBy: alphaId(93).toUpperCase(),
        },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it('returns the actual frozen candidate reference instead of a published version', async () => {
    const output = await get(new Client());
    expect(output).toMatchObject({ candidateReference: reference });
    expect(DATA_CAPABILITY_REGISTRY['data.ingestion.get'].version).toBe(
      '1.2.0',
    );
    expect(
      [
        DATA_CAPABILITY_REGISTRY['data.ingestion.get'],
        ...DATA_CAPABILITY_ARCHIVE['data.ingestion.get']!,
      ].map((item) => item.version),
    ).toEqual(expect.arrayContaining(['1.0.0', '1.1.0', '1.2.0']));
  });
  it.each(['foreign', 'unknown', 'author-as-reviewer'])(
    'denies %s before summaries are read',
    async (kind) => {
      const client = new Client();
      let actor = context;
      if (kind === 'foreign')
        client.responsibility.submitted_by_actor_id = id(90);
      if (kind === 'unknown')
        client.responsibility = {
          submitted_by_actor_id: null,
          submitted_actor_type: null,
          submitted_delegator_actor_id: null,
        };
      if (kind === 'author-as-reviewer')
        actor = {
          ...context,
          authorization: {
            ...context.authorization,
            scopes: ['data.operation.read', 'data.publish'],
          },
        };
      await expect(get(client, actor)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(
        client.queries.some(
          (sql) => sql.includes('quality-issues') || sql.includes('agent-runs'),
        ),
      ).toBe(false);
    },
  );

  it('allows an independent current human reviewer while blocking its delegated representative', async () => {
    const reviewer = {
      ...context,
      principal: { ...context.principal, actorId: id(90), authUserId: id(90) },
      authorization: {
        ...context.authorization,
        scopes: ['data.operation.read', 'data.publish'],
      },
    };
    expect(await get(new Client(), reviewer)).toMatchObject({
      candidateReference: reference,
    });
    const agent = {
      ...reviewer,
      principal: {
        actorId: id(91),
        actorType: 'agent' as const,
        authenticationMethod: 'delegated_credential' as const,
        credentialId: id(92),
        delegationId: id(93),
        delegatedBy: id(90),
      },
    };
    await expect(get(new Client(), agent)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('retains delegated responsibility and permits its currently authorized human delegator to continue maintenance', async () => {
    const client = new Client();
    client.responsibility = {
      submitted_by_actor_id: id(90),
      submitted_actor_type: 'agent',
      submitted_delegator_actor_id: id(1),
    };
    expect(await get(client)).toMatchObject({ candidateReference: reference });
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
    expect(await get(client, agent)).toMatchObject({
      candidateReference: reference,
    });
    await expect(
      get(client, {
        ...agent,
        principal: { ...agent.principal, delegatedBy: id(93) },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      get(client, {
        ...context,
        authorization: {
          ...context.authorization,
          scopes: ['data.operation.read', 'data.publish'],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(['revoked', 'expired-scope', 'expired-principal', 'invalid-purpose'])(
    'rejects %s authority before reading any ingestion',
    async (kind) => {
      const withSignal = {
        ...context,
        authorization: { ...context.authorization },
        principal: { ...context.principal },
      };
      if (kind === 'revoked')
        withSignal.authorization = {
          ...withSignal.authorization,
          scopes: ['data.operation.read'],
        };
      if (kind === 'expired-scope') {
        const current = context.authorization.resourceAccess!;
        if (current.scope.mode !== 'managed')
          throw Error('fixture must be managed');
        withSignal.authorization.resourceAccess = {
          ...current,
          scope: { ...current.scope, validUntil: '2000-01-01T00:00:00Z' },
        };
      }
      if (kind === 'expired-principal')
        withSignal.principal = {
          ...withSignal.principal,
          expiresAt: '2000-01-01T00:00:00Z',
        };
      if (kind === 'invalid-purpose')
        withSignal.authorization = { ...withSignal.authorization, purpose: '' };
      const client = new Client();
      await expect(get(client, withSignal)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(client.queries).toHaveLength(0);
    },
  );

  it('returns null before a frozen parser batch exists and does not mint a published version', async () => {
    const client = new Client();
    client.hasCandidate = false;
    const output = await get(client);
    expect(output).toMatchObject({ candidateReference: null });
    expect(JSON.stringify(output)).not.toContain('versionId');
  });

  it('preserves get 1.0/1.1 strict output schemas and all transport mappings', async () => {
    const output = (await get(new Client())) as Record<string, unknown>;
    const { candidateReference: _, ...oldOutput } = output;
    for (const old of DATA_CAPABILITY_ARCHIVE['data.ingestion.get']!) {
      expect(old.outputSchema.safeParse(oldOutput).success).toBe(true);
      expect(old.outputSchema.safeParse(output).success).toBe(false);
      expect(old.restMapping).toEqual(
        DATA_CAPABILITY_REGISTRY['data.ingestion.get'].restMapping,
      );
      expect(old.graphqlMapping).toEqual({
        operationType: 'query',
        field: 'dataIngestion',
      });
      expect(old.mcpMapping).toEqual(
        DATA_CAPABILITY_REGISTRY['data.ingestion.get'].mcpMapping,
      );
      expect(old.skillMapping).toEqual(
        DATA_CAPABILITY_REGISTRY['data.ingestion.get'].skillMapping,
      );
    }
  });

  it('admits the scoped get executor through the common handler and still rejects a withdrawn maintainer', async () => {
    const client = new Client();
    const runtime = createPostgresDataReadRuntime({
      connect: () => Promise.resolve(client),
      end: () => Promise.resolve(),
    });
    const selected = runtime.executors.find(
      (e) => e.id === 'data.ingestion.get',
    )!;
    const handler = new DataCapabilityHandler({
      executors: DATA_CAPABILITY_IDS.map((id) =>
        id === selected.id
          ? selected
          : { id, execute: () => Promise.reject(Error('not used')) },
      ),
      audit: { record: () => Promise.resolve() },
    });
    expect(
      await handler.execute({
        capabilityId: selected.id,
        input: { ingestionId: id(4) },
        requestContext: {
          principal: context.principal,
          authorization: context.authorization,
          traceId: context.traceId,
        },
      }),
    ).toMatchObject({ candidateReference: reference });
    await expect(
      handler.execute({
        capabilityId: selected.id,
        input: { ingestionId: id(4) },
        requestContext: {
          principal: context.principal,
          authorization: {
            ...context.authorization,
            scopes: ['data.operation.read'],
          },
          traceId: context.traceId,
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
