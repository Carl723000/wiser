import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import { createCandidateConversionProvenanceReader } from '../src/data-foundation/ingestion-candidate-provenance.js';

const id = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
const input = { ...reference, preparedAssetId: id(3) };
const response = { reference, preparedAssetId: id(3), check: null };
const startsAt = Date.parse('2026-10-06T00:00:00.000Z');
const endsAt = startsAt + 1000;
const expiry = new Date(endsAt).toISOString();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function executionContext(
  controller: AbortController,
  deadlines: { principal?: string; managedScope?: string } = {},
): DataCapabilityExecutionContext {
  return {
    principal: {
      actorId: id(4),
      actorType: 'human',
      authenticationMethod: 'supabase_jwt',
      authUserId: id(4),
      sessionId: id(5),
      ...(deadlines.principal ? { expiresAt: deadlines.principal } : {}),
    },
    authorization: {
      tenantId: id(6),
      projectId: id(7),
      purpose: 'candidate-review',
      roles: ['data-steward'],
      scopes: ['data.operation.read', 'data.ingestion.write'],
      maxSecurityLevel: 'L0_PUBLIC',
      authzVersion: 1,
      ...(deadlines.managedScope
        ? {
            resourceAccess: {
              revision: 1,
              fingerprint: 'c'.repeat(64),
              scope: {
                mode: 'managed' as const,
                permissions: {
                  'source.discover': [],
                  'content.read': [],
                  'original.read': [],
                  'result.export': [],
                  'external.directory': [],
                },
                validUntil: deadlines.managedScope,
              },
            },
          }
        : {}),
    },
    effectiveMaxSecurityLevel: 'L0_PUBLIC',
    traceId: 'b'.repeat(32),
    auditLevel: 'STANDARD',
    timeoutMs: 10000,
    signal: controller.signal,
  };
}

// The query seam controls only await completion. It does not prove PostgreSQL
// COMMIT semantics, RLS, live Auth revocation, or Worker lease acceptance.
function commitGateStorage() {
  const commitEntered = deferred();
  const allowCommitResponse = deferred();
  let released = false;
  const pool = {
    connect() {
      return Promise.resolve({
        async query(sql: string) {
          if (sql === 'commit') {
            commitEntered.resolve();
            await allowCommitResponse.promise;
          }
          return {
            rows: sql.includes('candidate.provenance.fixed')
              ? [
                  {
                    ingestion_id: id(1),
                    processing_batch_id: id(2),
                    review_hash: reference.reviewHash,
                    asset_id: id(3),
                    submitted_by_actor_id: id(4),
                    submitted_actor_type: 'human',
                    submitted_delegator_actor_id: null,
                    provenance: null,
                  },
                ]
              : [],
          };
        },
        release() {
          released = true;
        },
      });
    },
  };
  return {
    pool,
    commitEntered: commitEntered.promise,
    allowCommitResponse: allowCommitResponse.resolve,
    released: () => released,
  };
}

type ReaderOutcome =
  { ok: true; value: unknown } | { ok: false; error: unknown };

function observe(execution: Promise<unknown>): Promise<ReaderOutcome> {
  return execution.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function waitForCommit(
  storage: ReturnType<typeof commitGateStorage>,
  outcome: Promise<ReaderOutcome>,
) {
  await Promise.race([
    storage.commitEntered,
    outcome.then((result) => {
      if (!result.ok) throw result.error;
      throw new Error('Reader returned before the COMMIT response gate.');
    }),
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('candidate provenance authority at asynchronous return', () => {
  it('returns the exact readable result when both deadlines remain valid after COMMIT', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(startsAt);
    const storage = commitGateStorage();
    const controller = new AbortController();
    const outcome = observe(
      createCandidateConversionProvenanceReader(storage.pool).execute(
        input,
        executionContext(controller, {
          principal: expiry,
          managedScope: expiry,
        }),
      ),
    );
    await waitForCommit(storage, outcome);
    now.mockReturnValue(endsAt - 1);
    storage.allowCommitResponse();

    expect(await outcome).toEqual({ ok: true, value: response });
    expect(storage.released()).toBe(true);
  });

  it.each(['principal', 'managedScope'] as const)(
    'refuses a successful result when the %s deadline expires during COMMIT wait',
    async (deadline) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(startsAt);
      const storage = commitGateStorage();
      const controller = new AbortController();
      const outcome = observe(
        createCandidateConversionProvenanceReader(storage.pool).execute(
          input,
          executionContext(controller, { [deadline]: expiry }),
        ),
      );
      await waitForCommit(storage, outcome);
      now.mockReturnValue(endsAt + 1);
      storage.allowCommitResponse();

      expect(await outcome).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      });
      expect(storage.released()).toBe(true);
    },
  );

  it('refuses a successful result when its signal aborts during COMMIT wait', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(startsAt);
    const storage = commitGateStorage();
    const controller = new AbortController();
    const outcome = observe(
      createCandidateConversionProvenanceReader(storage.pool).execute(
        input,
        executionContext(controller, {
          principal: expiry,
          managedScope: expiry,
        }),
      ),
    );
    await waitForCommit(storage, outcome);
    controller.abort();
    storage.allowCommitResponse();

    // This tests the executor's existing timeout code, not the outer HTTP
    // handler's cancellation mapping.
    expect(await outcome).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_TIMEOUT' },
    });
    expect(storage.released()).toBe(true);
  });
});
