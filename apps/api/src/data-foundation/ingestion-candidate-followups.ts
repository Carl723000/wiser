import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ActCandidateFollowupInputSchema,
  CreateCandidateFollowupInputSchema,
  GetCandidateFollowupInputSchema,
  ListCandidateFollowupsInputSchema,
  ReviewCandidateFollowupInputSchema,
  CandidateFollowupSchema,
  CandidateFollowupEvidenceSchema,
  CandidateFollowupResponsibilitySchema,
  type CandidateFollowupEvidence,
  type CandidateFollowupSnapshot,
} from '@wiser/data-contracts/candidate-followups';
import {
  planCandidateFollowupTransition,
  canonicalCandidateFollowupCommand,
  assertIndependentCandidateFollowupReviewer,
} from '@wiser/data-core/candidate-followups';
import { canonicalIngestionUuid } from '@wiser/data-core';
import {
  candidateReadAuthority,
  setCandidateReadAuthority,
} from './candidate-read-authority.js';
import {
  CommandTransactions,
  PostgresDataCommandError,
  type PostgresDataCommandPool,
} from './postgres-command-executors.js';
import { applyResourceReadScope } from './resource-read-scope.js';
import { candidateFollowupListCursor } from './postgres-read-executors.js';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutor,
  type DataCapabilityExecutionContext,
} from './capability-handler.js';
import type {
  QueryAdapterPgClient,
  QueryAdapterPgPool,
} from './query-adapters.js';
import type { CandidateFollowupAssigneeAuthority } from '../platform/candidate-followup-assignee-authority.js';

const uuid = z.uuid();
const rootSchema = z.object({
  followup_id: uuid,
  tenant_id: uuid,
  project_id: uuid,
  type: z.enum(['GAP', 'CORRECTION']),
  source: CandidateFollowupEvidenceSchema,
  rule_id: z.string(),
  rule_version: z.string(),
  reason: z.string(),
  created_by_actor_id: uuid,
  created_actor_type: z.enum(['human', 'agent', 'service']),
  created_delegated_by: uuid.nullable(),
  purpose: z.string(),
  security_level: z.enum([
    'L0_PUBLIC',
    'L1_INTERNAL',
    'L2_RESTRICTED',
    'L3_CONFIDENTIAL',
  ]),
  state: z.enum(['OPEN', 'WORKING', 'REVIEW_PENDING', 'CLOSED']),
  row_version: z.coerce.number().int(),
  assignee: CandidateFollowupResponsibilitySchema.nullable(),
  evidence: z.array(CandidateFollowupEvidenceSchema),
  responsibilities: z.array(CandidateFollowupResponsibilitySchema),
  created_at: z.coerce.date(),
});
type Root = z.infer<typeof rootSchema>;
const ranks = {
  L0_PUBLIC: 0,
  L1_INTERNAL: 1,
  L2_RESTRICTED: 2,
  L3_CONFIDENTIAL: 3,
};
function assertAuthority(
  context: DataCapabilityExecutionContext,
  kind: 'read' | 'maintain' | 'review' = 'read',
) {
  if (context.signal.aborted)
    throw new DataCapabilityHandlerError('REQUEST_CANCELLED');
  const rights = candidateReadAuthority(context);
  if (
    kind === 'maintain'
      ? !rights.maintainer
      : kind === 'review'
        ? !rights.reviewer
        : !rights.maintainer && !rights.reviewer
  )
    throw new DataCapabilityHandlerError('FORBIDDEN');
  return rights;
}
function who(context: DataCapabilityExecutionContext) {
  return CandidateFollowupResponsibilitySchema.parse({
    actorId: canonicalIngestionUuid(context.principal.actorId),
    actorType: context.principal.actorType,
    delegatedBy: context.principal.delegatedBy
      ? canonicalIngestionUuid(context.principal.delegatedBy)
      : null,
    purpose: context.authorization.purpose,
  });
}
function deadline(context: DataCapabilityExecutionContext) {
  const times = [
    context.principal.expiresAt,
    context.authorization.resourceAccess?.scope.mode === 'managed'
      ? context.authorization.resourceAccess.scope.validUntil
      : null,
  ]
    .filter((v): v is string => Boolean(v))
    .map(Date.parse);
  return times.length ? new Date(Math.min(...times)).toISOString() : 'infinity';
}
async function scope(
  client: QueryAdapterPgClient,
  context: DataCapabilityExecutionContext,
) {
  assertAuthority(context);
  await client.query(
    `/* candidate.followup.scope */ select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),set_config('wiser.purpose',$5,true),set_config('wiser.candidate_view_deadline',$6,true)`,
    [
      context.authorization.tenantId,
      context.authorization.projectId,
      context.effectiveMaxSecurityLevel,
      String(context.authorization.authzVersion),
      context.authorization.purpose,
      deadline(context),
    ],
  );
  await applyResourceReadScope(
    client,
    context.authorization,
    context.resourceReadAction,
  );
  await setCandidateReadAuthority(client, context, []);
}
async function sources(
  client: QueryAdapterPgClient,
  context: DataCapabilityExecutionContext,
  evidence: readonly CandidateFollowupEvidence[],
) {
  assertAuthority(context);
  const result = await client.query(
    `/* candidate.followup.sources */ select ingestion.candidate_followup_sources_readable($1::uuid,$2::uuid,$3::jsonb) readable`,
    [
      context.authorization.tenantId,
      context.authorization.projectId,
      JSON.stringify(evidence),
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.['readable'] !== true)
    throw new DataCapabilityHandlerError('NOT_FOUND');
}
function snapshot(row: Root) {
  return {
    followupId: row.followup_id,
    type: row.type,
    state: row.state,
    rowVersion: row.row_version,
    source: row.source,
    createdBy: {
      actorId: row.created_by_actor_id,
      actorType: row.created_actor_type,
      delegatedBy: row.created_delegated_by,
      purpose: row.purpose,
    },
    assignee: row.assignee,
    evidence: row.evidence,
    responsibilities: row.responsibilities,
  };
}
async function root(
  client: QueryAdapterPgClient,
  context: DataCapabilityExecutionContext,
  id: string,
): Promise<Root> {
  const result = await client.query(
    '/* candidate.followup.get */ select * from ingestion.candidate_followup where followup_id=$1::uuid',
    [id],
  );
  const row = rootSchema.safeParse(result.rows[0]);
  if (
    !row.success ||
    row.data.tenant_id !== context.authorization.tenantId ||
    row.data.project_id !== context.authorization.projectId ||
    row.data.purpose !== context.authorization.purpose ||
    ranks[row.data.security_level] > ranks[context.effectiveMaxSecurityLevel]
  )
    throw new DataCapabilityHandlerError('NOT_FOUND');
  await sources(client, context, [row.data.source, ...row.data.evidence]);
  return row.data;
}
async function material(
  client: QueryAdapterPgClient,
  context: DataCapabilityExecutionContext,
  row: Root,
) {
  const result = await client.query(
    '/* candidate.followup.history */ select * from ingestion.candidate_followup_event where followup_id=$1::uuid order by row_version asc limit 201',
    [row.followup_id],
  );
  const followup = CandidateFollowupSchema.parse({
    ...snapshot(row),
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    technicalOnly: true,
    events: result.rows.map((e) => ({
      eventId: e['event_id'],
      rowVersion: Number(e['row_version']),
      expectedVersion: Number(e['expected_version']),
      action: e['action'],
      actor: {
        actorId: e['actor_id'],
        actorType: e['actor_type'],
        delegatedBy: e['delegated_by'],
        purpose: e['purpose'],
      },
      target: e['target'],
      stateAfter: e['state_after'],
      evidence: e['evidence'],
      correction: e['correction'],
      note: e['note'],
      createdAt: z.coerce.date().parse(e['created_at']).toISOString(),
    })),
  });
  if (Buffer.byteLength(JSON.stringify(followup)) > 2_000_000)
    throw new DataCapabilityHandlerError('EXECUTION_FAILED');
  assertAuthority(context);
  return followup;
}
async function target(
  client: QueryAdapterPgClient,
  context: DataCapabilityExecutionContext,
  targetActorId: string,
  evidence: readonly CandidateFollowupEvidence[],
  authority?: CandidateFollowupAssigneeAuthority,
) {
  const value = await authority?.(targetActorId, {
    tenantId: context.authorization.tenantId,
    projectId: context.authorization.projectId,
    purpose: context.authorization.purpose,
  });
  if (
    !value ||
    value.actorId !== targetActorId.toLowerCase() ||
    value.purpose !== context.authorization.purpose ||
    !value.maintainer ||
    Date.parse(value.deadline) <= Date.now()
  )
    throw new DataCapabilityHandlerError('FORBIDDEN');
  const identity = CandidateFollowupResponsibilitySchema.parse({
    actorId: value.actorId,
    actorType: value.actorType,
    delegatedBy: value.delegatedBy,
    purpose: value.purpose,
  });
  await client.query(
    "/* candidate.followup.target-scope */ select set_config('wiser.candidate_followup_target_context',$1,true)",
    [JSON.stringify(value)],
  );
  const result = await client.query(
    '/* candidate.followup.target-live */ select ingestion.candidate_followup_target_live($1::uuid,$2::uuid,$3::jsonb,$4::jsonb) live',
    [
      context.authorization.tenantId,
      context.authorization.projectId,
      JSON.stringify(identity),
      JSON.stringify(evidence),
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.['live'] !== true)
    throw new DataCapabilityHandlerError('FORBIDDEN');
  return identity;
}
async function append(
  client: QueryAdapterPgClient,
  context: DataCapabilityExecutionContext,
  id: string,
  expectedVersion: number,
  action: string,
  note: string,
  key: string,
  hash: string,
  projection: CandidateFollowupSnapshot,
  targetValue: unknown = null,
  evidence: unknown[] = [],
  correction: unknown = null,
) {
  const actor = who(context);
  await client.query(
    `/* candidate.followup.append */ insert into ingestion.candidate_followup_event(event_id,tenant_id,project_id,followup_id,expected_version,row_version,action,actor_id,actor_type,delegated_by,purpose,target,evidence,correction,note,idempotency_key,request_fingerprint,state_after,assignee_after,evidence_after,responsibilities_after)
 values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$5+1,$6,$7::uuid,$8,$9::uuid,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,decode($16,'hex'),$17,$18::jsonb,$19::jsonb,$20::jsonb)`,
    [
      randomUUID(),
      context.authorization.tenantId,
      context.authorization.projectId,
      id,
      expectedVersion,
      action,
      actor.actorId,
      actor.actorType,
      actor.delegatedBy,
      actor.purpose,
      targetValue === null ? null : JSON.stringify(targetValue),
      JSON.stringify(evidence),
      correction === null ? null : JSON.stringify(correction),
      note,
      key,
      hash,
      projection.state,
      JSON.stringify(projection.assignee),
      JSON.stringify(projection.evidence),
      JSON.stringify(projection.responsibilities),
    ],
  );
}
class FollowupCommandRejected extends PostgresDataCommandError {
  constructor(readonly original: DataCapabilityHandlerError) {
    super('INVALID_INPUT');
  }
}
function normalizeError(error: unknown): never {
  if (error instanceof FollowupCommandRejected) throw error.original;
  if (error instanceof DataCapabilityHandlerError) throw error;
  if (error instanceof PostgresDataCommandError) throw error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';
  if (code === '40001' || code === '23505')
    throw new DataCapabilityHandlerError('CONFLICT');
  if (code === '42501') throw new DataCapabilityHandlerError('FORBIDDEN');
  throw new DataCapabilityHandlerError('EXECUTION_FAILED');
}
export function createCandidateFollowupExecutors(
  pool: QueryAdapterPgPool,
  assigneeAuthority?: CandidateFollowupAssigneeAuthority,
): readonly DataCapabilityExecutor[] {
  const transactions = new CommandTransactions(
    pool as PostgresDataCommandPool,
    randomUUID,
    () => new Date(),
  );
  async function runCommand(...args: Parameters<CommandTransactions['run']>) {
    const [id, input, context, action, replay] = args;
    const guarded = async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof DataCapabilityHandlerError)
          throw new FollowupCommandRejected(error);
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['42501', '40001', '23505'].includes(String(error.code))
        )
          throw new FollowupCommandRejected(
            new DataCapabilityHandlerError(
              String(error.code) === '42501' ? 'FORBIDDEN' : 'CONFLICT',
            ),
          );
        throw error;
      }
    };
    return transactions.run(
      id,
      input,
      context,
      (...params) => guarded(() => action(...params)),
      replay ? (...params) => guarded(() => replay(...params)) : undefined,
    );
  }
  async function read<T>(
    context: DataCapabilityExecutionContext,
    action: (client: QueryAdapterPgClient) => Promise<T>,
  ) {
    assertAuthority(context);
    const client = await pool.connect();
    try {
      await client.query('begin isolation level repeatable read');
      await scope(client, context);
      const out = await action(client);
      assertAuthority(context);
      await client.query('commit');
      return out;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      return normalizeError(error);
    } finally {
      client.release();
    }
  }
  const create: DataCapabilityExecutor = {
    id: 'data.ingestion.candidate.followup.create',
    async execute(raw, context) {
      const input = CreateCandidateFollowupInputSchema.parse(
        canonicalCandidateFollowupCommand(raw),
      );
      assertAuthority(context, 'maintain');
      try {
        return await runCommand(
          create.id,
          input,
          context,
          async (client, _time, key, hash) => {
            await scope(client, context);
            await sources(client, context, [input.source]);
            await setCandidateReadAuthority(client, context, [
              input.source.reference,
            ]);
            const batch = await client.query(
              `/* candidate.followup.source-policy */ select security_level,policy_version from ingestion.candidate_batch where ingestion_id=$1::uuid and processing_batch_id=$2::uuid and review_hash=decode($3,'hex')`,
              [
                input.source.reference.ingestionId,
                input.source.reference.processingBatchId,
                input.source.reference.reviewHash,
              ],
            );
            const policy = z
              .object({
                security_level: z.enum([
                  'L0_PUBLIC',
                  'L1_INTERNAL',
                  'L2_RESTRICTED',
                  'L3_CONFIDENTIAL',
                ]),
                policy_version: z.coerce.number().int().positive(),
              })
              .parse(batch.rows[0]);
            const id = randomUUID(),
              actor = who(context);
            await client.query(
              `/* candidate.followup.create */ insert into ingestion.candidate_followup(followup_id,tenant_id,project_id,type,source,rule_id,rule_version,reason,created_by_actor_id,created_actor_type,created_delegated_by,purpose,security_level,policy_version)
   values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7,$8,$9::uuid,$10,$11::uuid,$12,$13,$14)`,
              [
                id,
                context.authorization.tenantId,
                context.authorization.projectId,
                input.type,
                JSON.stringify(input.source),
                input.ruleId,
                input.ruleVersion,
                input.reason,
                actor.actorId,
                actor.actorType,
                actor.delegatedBy,
                actor.purpose,
                policy.security_level,
                policy.policy_version,
              ],
            );
            await append(
              client,
              context,
              id,
              0,
              'CREATE',
              input.reason,
              key,
              hash,
              {
                followupId: id,
                type: input.type,
                state: 'OPEN',
                rowVersion: 0,
                source: input.source,
                createdBy: actor,
                assignee: null,
                evidence: [],
                responsibilities: [],
              },
            );
            const output = {
              followup: await material(
                client,
                context,
                await root(client, context, id),
              ),
            };
            return {
              output,
              replayResult: { followupId: id },
              aggregateId: id,
              eventType: 'CandidateFollowupCreated',
              securityLevel: policy.security_level,
            };
          },
          async (client, _time, ledger) => {
            await scope(client, context);
            const id = uuid.parse(
              (ledger.result as Record<string, unknown>)['followupId'],
            );
            return {
              followup: await material(
                client,
                context,
                await root(client, context, id),
              ),
            };
          },
        );
      } catch (error) {
        return normalizeError(error);
      }
    },
  };
  function command(
    id:
      | 'data.ingestion.candidate.followup.act'
      | 'data.ingestion.candidate.followup.review',
  ): DataCapabilityExecutor {
    return {
      id,
      async execute(raw, context) {
        const review = id.endsWith('.review'),
          input = review
            ? ReviewCandidateFollowupInputSchema.parse(
                canonicalCandidateFollowupCommand(raw),
              )
            : ActCandidateFollowupInputSchema.parse(
                canonicalCandidateFollowupCommand(raw),
              );
        assertAuthority(context, review ? 'review' : 'maintain');
        async function handoff(client: QueryAdapterPgClient, row: Root) {
          return 'action' in input && input.action === 'HANDOFF'
            ? target(
                client,
                context,
                input.targetActorId,
                [row.source, ...row.evidence],
                assigneeAuthority,
              )
            : undefined;
        }
        try {
          return await runCommand(
            id,
            input,
            context,
            async (client, _time, key, hash) => {
              await scope(client, context);
              const row = await root(client, context, input.followupId);
              if ('action' in input && input.action === 'SUPPLEMENT')
                await sources(client, context, [
                  row.source,
                  ...row.evidence,
                  ...input.evidence,
                ]);
              const resolvedTarget = await handoff(client, row);
              let next;
              try {
                next = planCandidateFollowupTransition(
                  snapshot(row),
                  input,
                  who(context),
                  resolvedTarget,
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : '';
                throw new DataCapabilityHandlerError(
                  message === 'CONFLICT'
                    ? 'CONFLICT'
                    : message.includes('RESPONSIBILITY') ||
                        message.includes('INDEPENDENT')
                      ? 'FORBIDDEN'
                      : 'VALIDATION_FAILED',
                );
              }
              await append(
                client,
                context,
                row.followup_id,
                row.row_version,
                'decision' in input ? input.decision : input.action,
                input.note,
                key,
                hash,
                next,
                resolvedTarget ?? null,
                'evidence' in input ? input.evidence : [],
                'correction' in input ? (input.correction ?? null) : null,
              );
              // Auth assignment is not cached: re-read current target rights in the same Data transaction.
              if (resolvedTarget)
                await handoff(
                  client,
                  await root(client, context, row.followup_id),
                );
              assertAuthority(context, review ? 'review' : 'maintain');
              const output = {
                followup: await material(
                  client,
                  context,
                  await root(client, context, row.followup_id),
                ),
              };
              return {
                output,
                replayResult: { followupId: row.followup_id },
                aggregateId: row.followup_id,
                eventType: review
                  ? 'CandidateFollowupReviewed'
                  : 'CandidateFollowupActed',
                securityLevel: row.security_level,
              };
            },
            async (client) => {
              await scope(client, context);
              assertAuthority(context, review ? 'review' : 'maintain');
              const row = await root(client, context, input.followupId);
              if (review) {
                try {
                  assertIndependentCandidateFollowupReviewer(
                    who(context),
                    row.responsibilities,
                  );
                } catch {
                  throw new DataCapabilityHandlerError('FORBIDDEN');
                }
              }
              await handoff(client, row);
              return { followup: await material(client, context, row) };
            },
          );
        } catch (error) {
          return normalizeError(error);
        }
      },
    };
  }
  return [
    create,
    {
      id: 'data.ingestion.candidate.followup.get',
      async execute(raw, context) {
        const input = GetCandidateFollowupInputSchema.parse(raw);
        return read(context, async (client) => ({
          followup: await material(
            client,
            context,
            await root(client, context, input.followupId),
          ),
        }));
      },
    },
    {
      id: 'data.ingestion.candidate.followup.list',
      async execute(raw, context) {
        const input = ListCandidateFollowupsInputSchema.parse(raw);
        const reference = {
          kind: input.kind,
          ingestionId: input.ingestionId,
          processingBatchId: input.processingBatchId,
          reviewHash: input.reviewHash,
        };
        return read(context, async (client) => {
          // Exact fixed-source query; source metadata is not permission to enumerate other tasks.
          await setCandidateReadAuthority(client, context, [reference]);
          const sourceBatch = await client.query(
            `/* candidate.followup.list-source */ select processing_batch_id from ingestion.candidate_batch where ingestion_id=$1::uuid and processing_batch_id=$2::uuid and review_hash=decode($3,'hex') and status<>'PENDING'`,
            [
              reference.ingestionId,
              reference.processingBatchId,
              reference.reviewHash,
            ],
          );
          if (
            sourceBatch.rows.length !== 1 ||
            sourceBatch.rows[0]?.['processing_batch_id'] !==
              reference.processingBatchId
          )
            throw new DataCapabilityHandlerError('NOT_FOUND');
          const after = candidateFollowupListCursor(context, input);
          if (
            after !== undefined &&
            (!Array.isArray(after) ||
              after.length !== 2 ||
              typeof after[0] !== 'string' ||
              typeof after[1] !== 'string')
          )
            throw new DataCapabilityHandlerError('VALIDATION_FAILED');
          const first = input.first ?? 25,
            rows = await client.query(
              `/* candidate.followup.list */ select followup_id,created_at from ingestion.candidate_followup where ingestion_id=$1::uuid and processing_batch_id=$2::uuid and source#>>'{reference,reviewHash}'=$3 and ($4::text is null or state=$4) and ($5::timestamptz is null or (created_at,followup_id)<($5::timestamptz,$6::uuid)) order by created_at desc,followup_id desc limit $7`,
              [
                reference.ingestionId,
                reference.processingBatchId,
                reference.reviewHash,
                input.state ?? null,
                after?.[0] ?? null,
                after?.[1] ?? null,
                first + 1,
              ],
            );
          const selected = rows.rows.slice(0, first),
            items = [];
          for (const row of selected)
            items.push(
              await material(
                client,
                context,
                await root(client, context, uuid.parse(row['followup_id'])),
              ),
            );
          const last = selected.at(-1),
            nextCursor =
              rows.rows.length > first && last
                ? candidateFollowupListCursor(context, input, [
                    z.coerce.date().parse(last['created_at']).toISOString(),
                    uuid.parse(last['followup_id']),
                  ])
                : null;
          const output = { items, nextCursor };
          if (Buffer.byteLength(JSON.stringify(output)) > 2_000_000)
            throw new DataCapabilityHandlerError('EXECUTION_FAILED');
          return output;
        });
      },
    },
    command('data.ingestion.candidate.followup.act'),
    command('data.ingestion.candidate.followup.review'),
  ];
}
