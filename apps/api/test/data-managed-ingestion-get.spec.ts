import { describe, expect, it } from 'vitest';
import {
  DATA_CAPABILITY_REGISTRY,
  DATA_CAPABILITY_ARCHIVE,
} from '@wiser/data-contracts';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import {
  createPostgresDataReadRuntime,
  type PostgresDataReadClient,
} from '../src/data-foundation/postgres-read-executors.js';

const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
  responsibility: Record<string, unknown> = {
    submitted_by_actor_id: id(1),
    submitted_actor_type: 'human',
    submitted_delegator_actor_id: null,
  };
  query(text: string) {
    this.queries.push(text);
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
        rows: [
          {
            ingestion_id: id(4),
            processing_batch_id: id(5),
            review_hash: reference.reviewHash,
          },
        ],
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
  it('returns the actual frozen candidate reference instead of a published version', async () => {
    const output = await get(new Client());
    expect(output).toMatchObject({ candidateReference: reference });
    expect(DATA_CAPABILITY_REGISTRY['data.ingestion.get'].version).toBe(
      '1.2.0',
    );
    expect(
      [
        DATA_CAPABILITY_REGISTRY['data.ingestion.get'],
        ...DATA_CAPABILITY_ARCHIVE['data.ingestion.get'],
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
});
