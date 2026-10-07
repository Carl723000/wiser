import { describe, expect, it } from 'vitest';
import {
  IngestionCandidateSavedViewSpecSchema,
  IngestionCandidateTopicSpecSchema,
} from '@wiser/data-contracts';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutionContext,
} from '../src/data-foundation/capability-handler.js';
import { createIngestionCandidateSavedExecutors } from '../src/data-foundation/ingestion-candidate-saved.js';
import type { PostgresDataCommandPool } from '../src/data-foundation/postgres-command-executors.js';
import type { QueryAdapterPgPool } from '../src/data-foundation/query-adapters.js';

const uuid = (n: number) =>
  `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: uuid(1),
  processingBatchId: uuid(2),
  reviewHash: 'a'.repeat(64),
};
const viewId = uuid(3);
const privateTitle = 'Synthetic private candidate title';
const privateQuestion = 'Synthetic private topic question';

function executionContext(): DataCapabilityExecutionContext {
  return {
    principal: {
      actorId: uuid(10),
      actorType: 'human',
      authenticationMethod: 'supabase_jwt',
      authUserId: uuid(10),
      sessionId: uuid(11),
    },
    authorization: {
      tenantId: uuid(20),
      projectId: uuid(21),
      purpose: 'candidate-review',
      roles: ['data-steward'],
      scopes: ['data.operation.read', 'data.ingestion.write'],
      maxSecurityLevel: 'L0_PUBLIC',
      authzVersion: 1,
    },
    effectiveMaxSecurityLevel: 'L0_PUBLIC',
    traceId: 'b'.repeat(32),
    auditLevel: 'STANDARD',
    timeoutMs: 30_000,
    signal: new AbortController().signal,
  };
}

function legacySpec() {
  return {
    page: { kind: 'assets', reference, first: 2 },
    period: {
      from: '2023-04',
      to: '2023-04',
      unit: 'month',
      includeUndated: false,
    },
  };
}

function completeTopicSpec() {
  return {
    schemaVersion: 2,
    page: { kind: 'assets', reference, first: 2 },
    period: {
      windowMode: 'month',
      from: '2023-04',
      to: '2023-04',
      timeRole: 'REPORT_PERIOD',
      displayUnit: 'month',
      includeUndated: false,
    },
    topic: {
      question: privateQuestion,
      regionIds: ['chaobai'],
      needIds: ['water-quality'],
      recordPins: [],
    },
    rulePins: [
      { kind: 'projection', ruleId: 'synthetic-projection', version: '1' },
      { kind: 'readiness', ruleId: 'synthetic-readiness', version: '1' },
      { kind: 'requirement', ruleId: 'synthetic-requirement', version: '1' },
      { kind: 'impact', ruleId: 'synthetic-impact', version: '1' },
    ],
    dependencyPins: [
      {
        kind: 'asset',
        reference,
        assetId: uuid(30),
        sourceHash: 'c'.repeat(64),
        parserVersion: 'synthetic-parser/1',
      },
    ],
    relationPins: [],
  };
}

/**
 * Only the saved-row and fixed-reference read ports are synthetic. Transaction
 * and scope statements are accepted controls, not proof of PostgreSQL or RLS.
 * No list, anchor, write, command ledger or SQL filtering behavior is simulated.
 */
function fixedReadPool(
  viewSpec: unknown,
  context: DataCapabilityExecutionContext,
): QueryAdapterPgPool & PostgresDataCommandPool {
  const row = {
    view_id: viewId,
    tenant_id: context.authorization.tenantId,
    project_id: context.authorization.projectId,
    actor_id: context.principal.actorId,
    actor_type: context.principal.actorType,
    delegated_by: null,
    purpose: context.authorization.purpose,
    title: privateTitle,
    visibility: 'private',
    candidate_refs: [reference],
    view_spec: viewSpec,
    created_at: '2026-10-01T00:00:00Z',
    revoked_at: null,
  };
  return {
    connect() {
      return Promise.resolve({
        query(sql: string, values: readonly unknown[] = []) {
          if (
            sql === 'begin isolation level repeatable read' ||
            sql === 'commit' ||
            sql === 'rollback' ||
            sql.startsWith('/* candidate.saved.scope */') ||
            sql.startsWith('/* data.ingestion.candidate.scope */')
          )
            return Promise.resolve({ rows: [], rowCount: 0 });
          if (sql.startsWith('/* candidate.saved.get */'))
            return Promise.resolve({
              rows: values[0] === viewId ? [structuredClone(row)] : [],
              rowCount: values[0] === viewId ? 1 : 0,
            });
          if (sql.startsWith('/* candidate.saved.references */')) {
            const requested = JSON.parse(String(values[0])) as unknown;
            expect(requested).toEqual([reference]);
            return Promise.resolve({
              rows: [
                {
                  ingestion_id: reference.ingestionId,
                  processing_batch_id: reference.processingBatchId,
                  review_hash: reference.reviewHash,
                  security_level: 'L0_PUBLIC',
                  submitted_by_actor_id: context.principal.actorId,
                  submitted_actor_type: 'human',
                  submitted_delegator_actor_id: null,
                },
              ],
              rowCount: 1,
            });
          }
          return Promise.reject(
            new Error('Unexpected query outside fixed read fixture.'),
          );
        },
        release() {},
      });
    },
    end() {
      return Promise.resolve();
    },
  };
}

async function openLegacy(viewSpec: unknown) {
  const context = executionContext();
  const executor = createIngestionCandidateSavedExecutors(
    fixedReadPool(viewSpec, context),
  ).find((entry) => entry.id === 'data.ingestion.candidate.view.open');
  if (!executor) throw new Error('Legacy candidate open is not registered.');
  return executor.execute({ viewId }, context);
}

async function expectSafeNotFound(viewSpec: unknown) {
  const error: unknown = await openLegacy(viewSpec).then(
    () => {
      throw new Error('Unsupported legacy configuration was returned.');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DataCapabilityHandlerError);
  expect(error).toMatchObject({ code: 'NOT_FOUND' });
  const diagnostic =
    error instanceof Error
      ? `${error.message}\n${JSON.stringify(error)}`
      : JSON.stringify(error);
  for (const detail of [
    privateTitle,
    privateQuestion,
    reference.ingestionId,
    reference.processingBatchId,
    reference.reviewHash,
  ])
    expect(diagnostic).not.toContain(detail);
}

describe('legacy candidate open saved-spec version boundary', () => {
  it('rejects a valid complete v2 topic as NOT_FOUND without saved-source details', async () => {
    const spec = completeTopicSpec();
    expect(IngestionCandidateTopicSpecSchema.safeParse(spec).success).toBe(
      true,
    );
    await expectSafeNotFound(spec);
  });

  it('rejects an unknown saved-spec version as NOT_FOUND without saved-source details', async () => {
    await expectSafeNotFound({ ...legacySpec(), schemaVersion: 3 });
  });

  it('keeps versionless v1 open and its existing display-only period intact', async () => {
    const spec = IngestionCandidateSavedViewSpecSchema.parse(legacySpec());
    const opened = await openLegacy(spec);
    expect(opened).toMatchObject({
      kind: 'ingestion-candidate-view',
      savedView: { viewId, title: privateTitle, revokedAt: null },
      references: [reference],
      viewSpec: spec,
      request: {
        capabilityId: 'data.ingestion.candidate.get',
        input: { ...reference, first: 2 },
      },
    });
    expect(opened).not.toHaveProperty('viewSpec.schemaVersion');
    expect(opened).not.toHaveProperty('request.input.period');
  });
});
