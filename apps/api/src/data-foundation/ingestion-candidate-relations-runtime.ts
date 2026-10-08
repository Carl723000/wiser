import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CreateCandidateRelationsInputSchema,
  CreateCandidateRelationsOutputSchema,
  GetCandidateRelationInputSchema,
  GetCandidateRelationOutputSchema,
  ListCandidateRelationsInputSchema,
  ListCandidateRelationsOutputSchema,
  ReviewCandidateRelationInputSchema,
  WithdrawCandidateRelationInputSchema,
  RebindCandidateRelationInputSchema,
  CandidateRelationSnapshotSchema,
  IngestionCandidateSavedReferencesSchema,
  candidateSavedReferenceKey,
  type CandidateRelationSnapshot,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  CandidateRelationReviewResponsibilitySchema,
  type CandidateRelationRevision,
  type CandidateRelationState,
} from '@wiser/data-contracts/candidate-relations';
import {
  assertCandidateRelationDecisionTransition,
  assertIndependentCandidateRelationReviewer,
  candidateRelationWithdrawalAllowed,
  validateCandidateRelationRevision,
} from '@wiser/data-core/candidate-relations';
import { canonicalIngestionUuid } from '@wiser/data-core';
import {
  CommandTransactions,
  PostgresDataCommandError,
  type PostgresDataCommandPool,
} from './postgres-command-executors.js';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutor,
  type DataCapabilityExecutionContext,
} from './capability-handler.js';
import {
  candidateReadAuthority,
  setCandidateReadAuthority,
} from './candidate-read-authority.js';
import { applyResourceReadScope } from './resource-read-scope.js';
import {
  canReadPendingSubmission,
  rowSubmissionResponsibility,
} from './managed-ingestion-access.js';
import { candidateRelationListCursor } from './postgres-read-executors.js';
import type {
  QueryAdapterPgClient,
  QueryAdapterPgPool,
} from './query-adapters.js';
const prefix = 'data.ingestion.candidate.relations.';
const rowSchema = z.object({
  snapshot: CandidateRelationSnapshotSchema,
  submitted_by_actor_id: z.uuid(),
  submitted_actor_type: z.enum(['human', 'agent', 'service']),
  submitted_delegator_actor_id: z.uuid().nullable(),
  purpose: z.string(),
  responsibilities: z
    .array(CandidateRelationReviewResponsibilitySchema)
    .min(2)
    .max(65),
});
type Row = z.infer<typeof rowSchema>;
const columns = `jsonb_build_object('revision',jsonb_build_object('revisionId',r.revision_id,'relationId',r.relation_id,'lineageId',r.lineage_id,'revision',r.revision,'supersedesId',r.supersedes_id,
 'reference',jsonb_build_object('kind','ingestion-candidate','ingestionId',r.ingestion_id,'processingBatchId',r.processing_batch_id,'reviewHash',encode(r.review_hash,'hex')),
 'mappingVersion',r.mapping_version,'ruleVersion',r.rule_version,'content',r.content),'decisionVersion',coalesce(d.decision_version,0),'state',coalesce(d.decision,'PENDING_REVIEW'),'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as snapshot,
 r.submitted_by_actor_id,r.submitted_actor_type,r.submitted_delegator_actor_id,r.purpose,
 (select jsonb_agg(jsonb_build_object('actorId',m.actor_id,'actorType',m.actor_type,'delegatedBy',m.delegated_by) order by m.responsibility_kind,m.source_batch_id) from ingestion.candidate_relation_responsibility m where m.tenant_id=r.tenant_id and m.project_id=r.project_id and m.revision_id=r.revision_id) as responsibilities`;
const decisionJoin = `left join lateral (select decision_version,decision from ingestion.candidate_relation_decision where tenant_id=r.tenant_id and project_id=r.project_id and revision_id=r.revision_id order by decision_version desc limit 1) d on true`;
function authority(
  c: DataCapabilityExecutionContext,
  mode: 'read' | 'maintainer' | 'reviewer' = 'read',
) {
  if (c.signal.aborted)
    throw new DataCapabilityHandlerError('CAPABILITY_TIMEOUT');
  const a = candidateReadAuthority(c);
  if (mode === 'read' ? !a.maintainer && !a.reviewer : !a[mode])
    throw new DataCapabilityHandlerError('FORBIDDEN');
  return a;
}
function responsibility(c: DataCapabilityExecutionContext) {
  return {
    actorId: canonicalIngestionUuid(c.principal.actorId)!,
    actorType: c.principal.actorType,
    delegatedBy: c.principal.delegatedBy
      ? canonicalIngestionUuid(c.principal.delegatedBy)!
      : null,
    purpose: c.authorization.purpose,
  };
}
function refsOf(r: CandidateRelationRevision): IngestionCandidateReference[] {
  const refs = new Map(
    r.content.evidence.map((e) => [
      candidateSavedReferenceKey(e.reference),
      e.reference,
    ]),
  );
  refs.set(candidateSavedReferenceKey(r.reference), r.reference);
  return [...refs.values()];
}
// Normalize identity fields only. Excerpts, locators and other source values remain byte-exact.
function canonicalReference(
  r: IngestionCandidateReference,
): IngestionCandidateReference {
  return {
    ...r,
    ingestionId: canonicalIngestionUuid(r.ingestionId)!,
    processingBatchId: canonicalIngestionUuid(r.processingBatchId)!,
  };
}
function canonicalEvidence(
  e: CandidateRelationRevision['content']['evidence'][number],
) {
  return {
    ...e,
    reference: canonicalReference(e.reference),
    assetId: canonicalIngestionUuid(e.assetId)!,
    ...(e.recordId ? { recordId: canonicalIngestionUuid(e.recordId)! } : {}),
  };
}
function canonicalProposal(
  p: Pick<
    CandidateRelationRevision,
    'reference' | 'mappingVersion' | 'ruleVersion' | 'content'
  >,
) {
  const endpoint = (e: CandidateRelationRevision['content']['subject']) => ({
    ...e,
    ...(e.reference
      ? {
          reference: {
            ...e.reference,
            reference: canonicalReference(e.reference.reference),
          },
        }
      : {}),
  });
  return {
    ...p,
    reference: canonicalReference(p.reference),
    content: {
      ...p.content,
      subject: endpoint(p.content.subject),
      object: endpoint(p.content.object),
      evidence: p.content.evidence.map(canonicalEvidence),
    },
  };
}
function canonicalSelection<
  T extends { references: IngestionCandidateReference[]; relationId?: string },
>(input: T): T {
  return {
    ...input,
    references: input.references.map(canonicalReference),
    ...(input.relationId
      ? { relationId: canonicalIngestionUuid(input.relationId)! }
      : {}),
  };
}
async function scope(
  client: QueryAdapterPgClient,
  c: DataCapabilityExecutionContext,
  refs: readonly IngestionCandidateReference[],
) {
  authority(c);
  const parsed = IngestionCandidateSavedReferencesSchema.parse(refs);
  const deadlines = [
    c.principal.expiresAt,
    c.authorization.resourceAccess?.scope.mode === 'managed'
      ? c.authorization.resourceAccess.scope.validUntil
      : null,
  ].filter((v): v is string => Boolean(v));
  await client.query(
    `/* candidate.relations.public.scope */ select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),set_config('wiser.purpose',$5,true),set_config('wiser.candidate_view_deadline',$6,true)`,
    [
      c.authorization.tenantId,
      c.authorization.projectId,
      c.effectiveMaxSecurityLevel,
      String(c.authorization.authzVersion),
      c.authorization.purpose,
      deadlines.length
        ? new Date(Math.min(...deadlines.map(Date.parse))).toISOString()
        : 'infinity',
    ],
  );
  await applyResourceReadScope(client, c.authorization, c.resourceReadAction);
  await setCandidateReadAuthority(client, c, parsed);
  const result = await client.query(
    `/* candidate.relations.public.sources */ select b.ingestion_id,b.processing_batch_id,encode(b.review_hash,'hex') review_hash,s.submitted_by_actor_id,s.submitted_actor_type,s.submitted_delegator_actor_id from jsonb_array_elements($1::jsonb) wanted join ingestion.candidate_batch b on b.ingestion_id=(wanted->>'ingestionId')::uuid and b.processing_batch_id=(wanted->>'processingBatchId')::uuid and encode(b.review_hash,'hex')=wanted->>'reviewHash' join ingestion.session s on s.tenant_id=b.tenant_id and s.project_id=b.project_id and s.ingestion_id=b.ingestion_id where b.tenant_id=$2::uuid and b.project_id=$3::uuid and b.status<>'PENDING'`,
    [
      JSON.stringify(parsed),
      c.authorization.tenantId,
      c.authorization.projectId,
    ],
  );
  const expected = new Set(parsed.map(candidateSavedReferenceKey)),
    seen = new Set<string>();
  const a = authority(c);
  for (const row of result.rows) {
    const key = candidateSavedReferenceKey({
      kind: 'ingestion-candidate',
      ingestionId: String(row['ingestion_id']),
      processingBatchId: String(row['processing_batch_id']),
      reviewHash: String(row['review_hash']),
    });
    if (
      !expected.has(key) ||
      seen.has(key) ||
      !canReadPendingSubmission(c, rowSubmissionResponsibility(row), a)
    )
      throw new DataCapabilityHandlerError('NOT_FOUND');
    seen.add(key);
  }
  if (seen.size !== expected.size)
    throw new DataCapabilityHandlerError('NOT_FOUND');
}
function parseRow(
  raw: unknown,
  refs: readonly IngestionCandidateReference[],
): Row {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) throw new DataCapabilityHandlerError('EXECUTION_FAILED');
  const fixed = new Set(refs.map(candidateSavedReferenceKey));
  if (
    refsOf(parsed.data.snapshot.revision).some(
      (r) => !fixed.has(candidateSavedReferenceKey(r)),
    )
  )
    throw new DataCapabilityHandlerError('NOT_FOUND');
  return parsed.data;
}
async function readRow(
  client: QueryAdapterPgClient,
  c: DataCapabilityExecutionContext,
  pin: { relationId: string; revision: number; decisionVersion: number },
  refs: readonly IngestionCandidateReference[],
  checkVersion = true,
) {
  const result = await client.query(
    `/* candidate.relations.public.get */ select ${columns} from ingestion.candidate_relation_revision r ${decisionJoin} where r.tenant_id=$1::uuid and r.project_id=$2::uuid and r.relation_id=$3::uuid and r.revision=$4::integer and ingestion.candidate_relation_sources_readable(r.tenant_id,r.project_id,r.content)`,
    [
      c.authorization.tenantId,
      c.authorization.projectId,
      pin.relationId,
      pin.revision,
    ],
  );
  if (result.rows.length !== 1)
    throw new DataCapabilityHandlerError('NOT_FOUND');
  const row = parseRow(result.rows[0], refs);
  if (
    row.snapshot.revision.relationId.toLowerCase() !==
      pin.relationId.toLowerCase() ||
    row.snapshot.revision.revision !== pin.revision
  )
    throw new DataCapabilityHandlerError('NOT_FOUND');
  if (checkVersion && row.snapshot.decisionVersion !== pin.decisionVersion)
    throw new DataCapabilityHandlerError('CONFLICT');
  authority(c);
  return row;
}
async function lockLatest(
  client: QueryAdapterPgClient,
  c: DataCapabilityExecutionContext,
  pin: { relationId: string; revision: number },
) {
  await client.query(
    `/* candidate.relations.public.lock */ select pg_advisory_xact_lock(hashtextextended($1::text||':'||$2::text||':'||$3::text,0))`,
    [
      c.authorization.tenantId.toLowerCase(),
      c.authorization.projectId.toLowerCase(),
      pin.relationId.toLowerCase(),
    ],
  );
  const result = await client.query(
    `/* candidate.relations.public.latest */ select max(revision)::integer revision from ingestion.candidate_relation_revision where tenant_id=$1::uuid and project_id=$2::uuid and relation_id=$3::uuid`,
    [c.authorization.tenantId, c.authorization.projectId, pin.relationId],
  );
  if (result.rows[0]?.['revision'] !== pin.revision)
    throw new DataCapabilityHandlerError('CONFLICT');
}
function owner(row: Row, c: DataCapabilityExecutionContext) {
  return candidateRelationWithdrawalAllowed(responsibility(c), {
    actorId: row.submitted_by_actor_id,
    actorType: row.submitted_actor_type,
    delegatedBy: row.submitted_delegator_actor_id,
    purpose: row.purpose,
  });
}
async function insertRevision(
  client: QueryAdapterPgClient,
  c: DataCapabilityExecutionContext,
  r: CandidateRelationRevision,
) {
  const primary = await client.query(
    `/* candidate.relations.public.primary */ select security_level,policy_version from ingestion.candidate_batch where tenant_id=$1::uuid and project_id=$2::uuid and ingestion_id=$3::uuid and processing_batch_id=$4::uuid and review_hash=decode($5,'hex')`,
    [
      c.authorization.tenantId,
      c.authorization.projectId,
      r.reference.ingestionId,
      r.reference.processingBatchId,
      r.reference.reviewHash,
    ],
  );
  if (primary.rows.length !== 1)
    throw new DataCapabilityHandlerError('NOT_FOUND');
  const a = responsibility(c),
    b = primary.rows[0]!;
  await client.query(
    `/* candidate.relations.public.insert */ insert into ingestion.candidate_relation_revision(revision_id,tenant_id,project_id,relation_id,lineage_id,revision,supersedes_id,ingestion_id,processing_batch_id,review_hash,mapping_version,rule_version,content,submitted_by_actor_id,submitted_actor_type,submitted_delegator_actor_id,purpose,security_level,policy_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'),$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)`,
    [
      r.revisionId,
      c.authorization.tenantId,
      c.authorization.projectId,
      r.relationId,
      r.lineageId,
      r.revision,
      r.supersedesId,
      r.reference.ingestionId,
      r.reference.processingBatchId,
      r.reference.reviewHash,
      r.mappingVersion,
      r.ruleVersion,
      JSON.stringify(r.content),
      a.actorId,
      a.actorType,
      a.delegatedBy,
      a.purpose,
      b['security_level'],
      b['policy_version'],
    ],
  );
}
async function commandErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DataCapabilityHandlerError)
      throw new PostgresDataCommandError(
        e.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : e.code === 'CONFLICT'
            ? 'STATE_CONFLICT'
            : e.code === 'FORBIDDEN'
              ? 'INTAKE_FORBIDDEN'
              : 'INVALID_INPUT',
      );
    if (e !== null && typeof e === 'object' && 'code' in e) {
      if (e.code === '42501')
        throw new PostgresDataCommandError('INTAKE_FORBIDDEN');
      if (e.code === '40001' || e.code === '23505')
        throw new PostgresDataCommandError('STATE_CONFLICT');
    }
    throw e;
  }
}
export function createIngestionCandidateRelationExecutors(
  pool: QueryAdapterPgPool & PostgresDataCommandPool,
  options: { idFactory?: () => string; clock?: () => Date } = {},
): readonly DataCapabilityExecutor[] {
  const id = options.idFactory ?? randomUUID,
    transactions = new CommandTransactions(
      pool,
      id,
      options.clock ?? (() => new Date()),
    );
  async function read<T>(
    c: DataCapabilityExecutionContext,
    refs: readonly IngestionCandidateReference[],
    fn: (client: QueryAdapterPgClient) => Promise<T>,
  ) {
    authority(c);
    const client = await pool.connect();
    try {
      await client.query('begin isolation level repeatable read');
      await scope(client, c, refs);
      const output = await fn(client);
      authority(c);
      await client.query('commit');
      return output;
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      if (e instanceof DataCapabilityHandlerError) throw e;
      throw new DataCapabilityHandlerError('EXECUTION_FAILED');
    } finally {
      client.release();
    }
  }
  const outcome = (
    output: unknown,
    aggregateId: string,
    eventType: string,
    c: DataCapabilityExecutionContext,
  ) => ({
    output,
    replayResult: output,
    aggregateId,
    eventType,
    securityLevel: c.effectiveMaxSecurityLevel,
  });
  const pinOf = (r: CandidateRelationSnapshot) => ({
    relationId: r.revision.relationId,
    revision: r.revision.revision,
    decisionVersion: r.decisionVersion,
  });
  async function replay(
    client: QueryAdapterPgClient,
    c: DataCapabilityExecutionContext,
    refs: readonly IngestionCandidateReference[],
    raw: unknown,
    owned: boolean,
  ) {
    await scope(client, c, refs);
    const previous = GetCandidateRelationOutputSchema.parse(raw);
    const row = await readRow(client, c, pinOf(previous.relation), refs, false);
    if (owned && !owner(row, c))
      throw new DataCapabilityHandlerError('NOT_FOUND');
    return { relation: row.snapshot };
  }
  return [
    {
      id: 'data.ingestion.candidate.relations.create',
      async execute(raw, c) {
        const parsed = CreateCandidateRelationsInputSchema.parse(raw);
        const input = {
          ...parsed,
          proposals: parsed.proposals.map(canonicalProposal),
        };
        authority(c, 'maintainer');
        let revisions: CandidateRelationRevision[];
        try {
          revisions = input.proposals.map((p) =>
            validateCandidateRelationRevision({
              ...p,
              revisionId: id(),
              relationId: id(),
              lineageId: id(),
              revision: 1,
              supersedesId: null,
            }),
          );
        } catch {
          throw new DataCapabilityHandlerError('VALIDATION_FAILED');
        }
        const refs = [
          ...new Map(
            revisions
              .flatMap(refsOf)
              .map((r) => [candidateSavedReferenceKey(r), r]),
          ).values(),
        ];
        return transactions.run(
          'data.ingestion.candidate.relations.create',
          input,
          c,
          (client) =>
            commandErrors(async () => {
              await scope(client, c, refs);
              const relations = [];
              for (const r of revisions) {
                await insertRevision(client, c, r);
                relations.push(
                  (
                    await readRow(
                      client,
                      c,
                      {
                        relationId: r.relationId,
                        revision: 1,
                        decisionVersion: 0,
                      },
                      refs,
                    )
                  ).snapshot,
                );
              }
              authority(c, 'maintainer');
              const output = CreateCandidateRelationsOutputSchema.parse({
                relations,
              });
              return outcome(
                output,
                revisions[0]!.relationId,
                `${prefix}created`,
                c,
              );
            }),
          (client, _t, ledger) =>
            commandErrors(async () => {
              await scope(client, c, refs);
              const previous = CreateCandidateRelationsOutputSchema.parse(
                ledger.result,
              );
              const relations = [];
              for (const r of previous.relations) {
                const row = await readRow(client, c, pinOf(r), refs, false);
                if (!owner(row, c))
                  throw new DataCapabilityHandlerError('NOT_FOUND');
                relations.push(row.snapshot);
              }
              authority(c, 'maintainer');
              return { relations };
            }),
        );
      },
    },
    {
      id: 'data.ingestion.candidate.relations.get',
      async execute(raw, c) {
        const input = canonicalSelection(
          GetCandidateRelationInputSchema.parse(raw),
        );
        return read(c, input.references, async (client) =>
          GetCandidateRelationOutputSchema.parse({
            relation: (await readRow(client, c, input, input.references))
              .snapshot,
          }),
        );
      },
    },
    {
      id: 'data.ingestion.candidate.relations.list',
      async execute(raw, c) {
        const input = canonicalSelection(
          ListCandidateRelationsInputSchema.parse(raw),
        );
        return read(c, input.references, async (client) => {
          let cursor: readonly (number | string)[] | string | undefined;
          try {
            cursor = candidateRelationListCursor(c, input);
          } catch {
            throw new DataCapabilityHandlerError('VALIDATION_FAILED');
          }
          if (
            cursor !== undefined &&
            (!Array.isArray(cursor) ||
              cursor.length !== 2 ||
              !z.iso.datetime({ offset: true }).safeParse(cursor[0]).success ||
              !z.uuid().safeParse(cursor[1]).success)
          )
            throw new DataCapabilityHandlerError('VALIDATION_FAILED');
          const result = await client.query(
            `/* candidate.relations.public.list */ select ${columns} from ingestion.candidate_relation_revision r ${decisionJoin} where r.tenant_id=$1::uuid and r.project_id=$2::uuid and ($4::timestamptz is null or (r.created_at,r.relation_id)<($4::timestamptz,$5::uuid)) and not exists(select 1 from ingestion.candidate_relation_revision newer where newer.tenant_id=r.tenant_id and newer.project_id=r.project_id and newer.relation_id=r.relation_id and newer.revision>r.revision) and not exists(select 1 from jsonb_array_elements(r.content->'evidence') e where not exists(select 1 from jsonb_array_elements($3::jsonb) wanted where wanted->>'kind'='ingestion-candidate' and (wanted->>'ingestionId')::uuid=(e#>>'{reference,ingestionId}')::uuid and (wanted->>'processingBatchId')::uuid=(e#>>'{reference,processingBatchId}')::uuid and wanted->>'reviewHash'=e#>>'{reference,reviewHash}')) order by r.created_at desc,r.relation_id desc limit $6`,
            [
              c.authorization.tenantId,
              c.authorization.projectId,
              JSON.stringify(input.references),
              cursor?.[0] ?? null,
              cursor?.[1] ?? null,
              input.first + 1,
            ],
          );
          const available = result.rows.map(
              (r) => parseRow(r, input.references).snapshot,
            ),
            relations: CandidateRelationSnapshot[] = [];
          let bytes = 4096;
          for (const r of available.slice(0, input.first)) {
            const size = Buffer.byteLength(JSON.stringify(r), 'utf8') + 1;
            if (bytes + size > 1024 * 1024) {
              if (relations.length === 0)
                throw new DataCapabilityHandlerError('VALIDATION_FAILED');
              break;
            }
            relations.push(r);
            bytes += size;
          }
          const last = relations.at(-1);
          return ListCandidateRelationsOutputSchema.parse({
            relations,
            nextCursor:
              available.length > relations.length && last
                ? candidateRelationListCursor(c, input, [
                    last.createdAt,
                    last.revision.relationId,
                  ])
                : null,
          });
        });
      },
    },
    ...(['review', 'withdraw'] as const).map(
      (operation): DataCapabilityExecutor => ({
        id:
          operation === 'review'
            ? 'data.ingestion.candidate.relations.review'
            : 'data.ingestion.candidate.relations.withdraw',
        async execute(raw: unknown, c: DataCapabilityExecutionContext) {
          const input = canonicalSelection(
            operation === 'review'
              ? ReviewCandidateRelationInputSchema.parse(raw)
              : WithdrawCandidateRelationInputSchema.parse(raw),
          );
          authority(c, operation === 'review' ? 'reviewer' : 'maintainer');
          const capability =
            operation === 'review'
              ? 'data.ingestion.candidate.relations.review'
              : 'data.ingestion.candidate.relations.withdraw';
          return transactions.run(
            capability,
            input,
            c,
            (client) =>
              commandErrors(async () => {
                await scope(client, c, input.references);
                await lockLatest(client, c, input);
                const row = await readRow(client, c, input, input.references);
                const status: CandidateRelationState =
                  operation === 'review'
                    ? ReviewCandidateRelationInputSchema.parse(input).status
                    : 'WITHDRAWN';
                if (operation === 'withdraw') {
                  if (!owner(row, c))
                    throw new DataCapabilityHandlerError('NOT_FOUND');
                } else {
                  try {
                    assertIndependentCandidateRelationReviewer(
                      responsibility(c),
                      row.responsibilities,
                    );
                  } catch {
                    throw new DataCapabilityHandlerError('FORBIDDEN');
                  }
                }
                try {
                  assertCandidateRelationDecisionTransition(
                    row.snapshot.state,
                    status,
                    input.decisionVersion,
                  );
                } catch {
                  throw new DataCapabilityHandlerError('CONFLICT');
                }
                const a = responsibility(c);
                await client.query(
                  `/* candidate.relations.public.decision */ insert into ingestion.candidate_relation_decision(tenant_id,project_id,revision_id,decision_version,decision,actor_id,actor_type,delegated_by,purpose,rationale) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                  [
                    c.authorization.tenantId,
                    c.authorization.projectId,
                    row.snapshot.revision.revisionId,
                    input.decisionVersion + 1,
                    status,
                    a.actorId,
                    a.actorType,
                    a.delegatedBy,
                    a.purpose,
                    input.rationale,
                  ],
                );
                const updated = await readRow(
                  client,
                  c,
                  { ...input, decisionVersion: input.decisionVersion + 1 },
                  input.references,
                );
                authority(
                  c,
                  operation === 'review' ? 'reviewer' : 'maintainer',
                );
                return outcome(
                  { relation: updated.snapshot },
                  input.relationId,
                  `${prefix}${operation}ed`,
                  c,
                );
              }),
            (client, _t, ledger) =>
              commandErrors(async () => {
                const result = await replay(
                  client,
                  c,
                  input.references,
                  ledger.result,
                  operation === 'withdraw',
                );
                if (operation === 'review') {
                  const row = await readRow(
                    client,
                    c,
                    pinOf(result.relation),
                    input.references,
                    false,
                  );
                  try {
                    assertIndependentCandidateRelationReviewer(
                      responsibility(c),
                      row.responsibilities,
                    );
                  } catch {
                    throw new DataCapabilityHandlerError('FORBIDDEN');
                  }
                }
                authority(
                  c,
                  operation === 'review' ? 'reviewer' : 'maintainer',
                );
                return result;
              }),
          );
        },
      }),
    ),
    {
      id: 'data.ingestion.candidate.relations.rebind',
      async execute(raw, c) {
        const parsed = canonicalSelection(
          RebindCandidateRelationInputSchema.parse(raw),
        );
        const input = {
          ...parsed,
          replacement: canonicalProposal(parsed.replacement),
          mapping: parsed.mapping.map((m) => ({
            from: canonicalEvidence(m.from),
            to: canonicalEvidence(m.to),
          })),
        };
        authority(c, 'maintainer');
        return transactions.run(
          'data.ingestion.candidate.relations.rebind',
          input,
          c,
          (client) =>
            commandErrors(async () => {
              await scope(client, c, input.references);
              await lockLatest(client, c, input);
              const old = await readRow(client, c, input, input.references);
              if (!owner(old, c))
                throw new DataCapabilityHandlerError('NOT_FOUND');
              if (input.revision === 2147483647)
                throw new DataCapabilityHandlerError('CONFLICT');
              let next: CandidateRelationRevision;
              try {
                next = validateCandidateRelationRevision({
                  ...input.replacement,
                  revisionId: id(),
                  relationId: old.snapshot.revision.relationId,
                  lineageId: old.snapshot.revision.lineageId,
                  revision: input.revision + 1,
                  supersedesId: old.snapshot.revision.revisionId,
                });
              } catch {
                throw new DataCapabilityHandlerError('VALIDATION_FAILED');
              }
              const fixed = new Set(
                input.references.map(candidateSavedReferenceKey),
              );
              if (
                refsOf(next).some(
                  (r) => !fixed.has(candidateSavedReferenceKey(r)),
                )
              )
                throw new DataCapabilityHandlerError('VALIDATION_FAILED');
              // Exact multiset equality covers every evidence member, including duplicate ordinals.
              const sameMembers = (
                a: readonly unknown[],
                b: readonly unknown[],
              ) => {
                const remaining = [...b];
                for (const e of a) {
                  const i = remaining.findIndex((v) => isDeepStrictEqual(e, v));
                  if (i < 0) return false;
                  remaining.splice(i, 1);
                }
                return remaining.length === 0;
              };
              if (
                !sameMembers(
                  old.snapshot.revision.content.evidence,
                  input.mapping.map((m) => m.from),
                ) ||
                !sameMembers(
                  next.content.evidence,
                  input.mapping.map((m) => m.to),
                )
              )
                throw new DataCapabilityHandlerError('VALIDATION_FAILED');
              await insertRevision(client, c, next);
              await client.query(
                `/* candidate.relations.public.rebind */ insert into ingestion.candidate_relation_rebind(tenant_id,project_id,revision_id,previous_revision_id,mapping) values($1,$2,$3,$4,$5::jsonb)`,
                [
                  c.authorization.tenantId,
                  c.authorization.projectId,
                  next.revisionId,
                  old.snapshot.revision.revisionId,
                  JSON.stringify(input.mapping),
                ],
              );
              const result = await readRow(
                client,
                c,
                {
                  relationId: next.relationId,
                  revision: next.revision,
                  decisionVersion: 0,
                },
                input.references,
              );
              if (result.snapshot.state !== 'PENDING_REVIEW')
                throw new DataCapabilityHandlerError('EXECUTION_FAILED');
              authority(c, 'maintainer');
              return outcome(
                { relation: result.snapshot },
                next.relationId,
                `${prefix}rebound`,
                c,
              );
            }),
          (client, _t, ledger) =>
            commandErrors(async () => {
              const result = await replay(
                client,
                c,
                input.references,
                ledger.result,
                true,
              );
              authority(c, 'maintainer');
              return result;
            }),
        );
      },
    },
  ];
}
