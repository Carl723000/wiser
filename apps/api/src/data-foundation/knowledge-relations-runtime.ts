import {
  loadBusinessRelations,
  storedBusinessMembership,
} from './business-query-runtime.js';
import {
  RELATION_SELECT as SELECT,
  readRelationAssertion as assertion,
} from './knowledge-relation-read.js';
import {
  relationVisibleSql,
  relationSourceVisibleSql,
  relationEvidenceVisibleSql,
} from '@wiser/data-infra';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ImportRelationsInputSchema,
  ImportRelationsOutputSchema,
  RelationGetInputSchema,
  RelationReviewInputSchema,
  RelationBatchListInputSchema,
  QuerySpecSchema,
  type RelationAssertion,
  type RelationCandidate,
} from '@wiser/data-contracts';
import {
  assertRelationEntityConsistency,
  groupRelationCandidates,
} from '@wiser/data-core';
import {
  CommandTransactions,
  PostgresDataCommandError,
  type PostgresDataCommandPool,
  type PostgresDataCommandClient,
} from './postgres-command-executors.js';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutionContext,
  type DataCapabilityExecutor,
} from './capability-handler.js';
import { AUTHORIZED } from './exploration-authorization.js';
import { boundedRelationPage } from './relation-batch-page.js';

type Client = PostgresDataCommandClient;
const fail = (code: 'NOT_FOUND' | 'STATE_CONFLICT' | 'IDEMPOTENCY_CONFLICT') =>
  new PostgresDataCommandError(code);
const VISIBLE = relationVisibleSql();
async function authorize(
  client: Client,
  ref: { dataItemId: string; versionId: string },
  candidates: readonly RelationCandidate[] = [],
) {
  const checked = await client.query(
    `${AUTHORIZED} select count(*)::int total from authorized`,
    [JSON.stringify([ref])],
  );
  if (checked.rows[0]?.['total'] !== 1) throw fail('NOT_FOUND');
  const evidence = [
    ...new Map(
      candidates.flatMap((c) => c.evidence).map((e) => [JSON.stringify(e), e]),
    ).values(),
  ];
  if (evidence.length) {
    const saved = await client.query(
      `select count(*)::int total from jsonb_array_elements($1::jsonb) e cross join (select $2::uuid version_id) owner where ${relationEvidenceVisibleSql('e', 'owner')}`,
      [JSON.stringify(evidence), ref.versionId],
    );
    if (saved.rows[0]?.['total'] !== evidence.length) throw fail('NOT_FOUND');
  }
}
async function authorizeReferences(
  client: Client,
  candidates: readonly RelationCandidate[],
) {
  for (const entity of candidates.flatMap((c) => [c.subject, c.object])) {
    const ref = entity.reference;
    if (!ref) continue;
    await authorize(client, ref);
    const found = await client.query(
      `select value from knowledge.assertion_binding b join knowledge.assertion a using(tenant_id,project_id,assertion_id)
       cross join lateral (values(b.candidate->'subject'),(b.candidate->'object')) entity(value)
       where b.data_item_id=$1::uuid and b.version_id=$2::uuid and b.mapping_version=$3 and value->>'key'=$4
       and not (value ? 'reference') and a.status in ('APPROVED','PENDING_REVIEW') and ${relationSourceVisibleSql()} limit 1`,
      [ref.dataItemId, ref.versionId, ref.mappingVersion, ref.entityKey],
    );
    const saved = found.rows[0]?.['value'] as
      RelationCandidate['subject'] | undefined;
    if (
      !saved ||
      saved.kind !== entity.kind ||
      saved.label !== entity.label ||
      saved.externalId !== entity.externalId
    )
      throw fail('NOT_FOUND');
  }
}

async function load(client: Client, id: string) {
  const rows = await client.query(
    `${SELECT} where b.assertion_id=$1::uuid and ${VISIBLE}`,
    [id],
  );
  if (!rows.rows[0]) throw fail('NOT_FOUND');
  return assertion(rows.rows[0]);
}
export function createKnowledgeRelationExecutors(
  pool: PostgresDataCommandPool,
): readonly DataCapabilityExecutor[] {
  const tx = new CommandTransactions(pool, randomUUID, () => new Date());
  async function read<T>(
    context: DataCapabilityExecutionContext,
    work: (c: Client) => Promise<T>,
  ) {
    const c = await pool.connect();
    try {
      await c.query('begin isolation level repeatable read');
      await c.query(
        "select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),set_config('statement_timeout',$5,true),set_config('wiser.actor_id',$6,true),set_config('wiser.purpose',$7,true)",
        [
          context.authorization.tenantId,
          context.authorization.projectId,
          context.effectiveMaxSecurityLevel,
          String(context.authorization.authzVersion),
          String(context.timeoutMs),
          context.principal.actorId,
          context.authorization.purpose,
        ],
      );
      const result = await work(c);
      if (context.signal.aborted)
        throw new DataCapabilityHandlerError('CAPABILITY_TIMEOUT');
      await c.query('commit');
      return result;
    } catch (error) {
      await c.query('rollback').catch(() => undefined);
      if (error instanceof PostgresDataCommandError)
        throw new DataCapabilityHandlerError(
          error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'EXECUTION_FAILED',
        );
      if (error instanceof DataCapabilityHandlerError) throw error;
      throw new DataCapabilityHandlerError('EXECUTION_FAILED');
    } finally {
      c.release();
    }
  }
  return [
    {
      id: 'data.knowledge.relations.import',
      async execute(raw, context) {
        const input = ImportRelationsInputSchema.parse(raw);
        let grouped: ReturnType<typeof groupRelationCandidates>;
        try {
          grouped = groupRelationCandidates(input.candidates);
        } catch {
          throw new PostgresDataCommandError('INVALID_INPUT');
        }
        if (
          Buffer.byteLength(JSON.stringify(input)) > 262144 ||
          grouped.some(
            (g) => Buffer.byteLength(JSON.stringify(g.candidate)) > 100000,
          )
        )
          throw new PostgresDataCommandError('INVALID_INPUT');
        return tx.run(
          'data.knowledge.relations.import',
          input,
          context,
          async (client, timestamp) => {
            await authorize(
              client,
              input,
              grouped.map((g) => g.candidate),
            );
            await authorizeReferences(
              client,
              grouped.map((g) => g.candidate),
            );
            // Serialize the source/mapping only, so a changed command key cannot race a duplicate import.
            await client.query(
              'select pg_advisory_xact_lock(hashtextextended($1,0))',
              [
                `${context.authorization.tenantId}:${context.authorization.projectId}:${input.versionId}:${input.mappingVersion}`,
              ],
            );
            const keys = [
              ...new Set(
                grouped.flatMap((g) => [
                  g.candidate.subject.key,
                  g.candidate.object.key,
                ]),
              ),
            ];
            const existingEntities = await client.query(
              `select value from knowledge.assertion_binding b cross join lateral (values(b.candidate->'subject'),(b.candidate->'object')) entity(value) where b.version_id=$1::uuid and b.mapping_version=$2 and value->>'key'=any($3::text[])`,
              [input.versionId, input.mappingVersion, keys],
            );
            try {
              assertRelationEntityConsistency([
                ...existingEntities.rows.map((r) => r['value']),
                ...grouped.flatMap((g) => [
                  g.candidate.subject,
                  g.candidate.object,
                ]),
              ]);
            } catch {
              throw fail('STATE_CONFLICT');
            }
            const items: RelationAssertion[] = [];
            let createdCount = 0;
            for (const { identity, candidate } of grouped) {
              const fingerprint = createHash('sha256')
                .update(JSON.stringify(candidate))
                .digest('hex');
              const old = await client.query(
                `select assertion_id,encode(fingerprint,'hex') fingerprint from knowledge.assertion_binding where version_id=$1::uuid and mapping_version=$2 and identity_key=$3`,
                [input.versionId, input.mappingVersion, identity],
              );
              if (old.rows[0]) {
                if (old.rows[0]['fingerprint'] !== fingerprint)
                  throw fail('IDEMPOTENCY_CONFLICT');
                items.push(
                  await load(client, String(old.rows[0]['assertion_id'])),
                );
                continue;
              }
              if (candidate.supersedesId) {
                const previous = await load(client, candidate.supersedesId);
                if (
                  previous.dataItemId !== input.dataItemId ||
                  previous.candidate.subject.key !== candidate.subject.key ||
                  previous.candidate.predicate !== candidate.predicate ||
                  previous.candidate.object.key !== candidate.object.key
                )
                  throw fail('STATE_CONFLICT');
              }
              const id = randomUUID(),
                evidenceId = randomUUID(),
                first = candidate.evidence[0]!;
              const scope = [
                context.authorization.tenantId,
                context.authorization.projectId,
              ];
              await client.query(
                `insert into knowledge.evidence_fragment(evidence_fragment_id,tenant_id,project_id,data_item_id,version_id,asset_id,locator,content_hash,excerpt,security_level,policy_version,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7::jsonb,decode($8,'hex'),$9,$10,$11,$12,$12)`,
                [
                  evidenceId,
                  ...scope,
                  input.dataItemId,
                  input.versionId,
                  first.assetId,
                  JSON.stringify({
                    kind: 'RELATION_EVIDENCE',
                    locations: candidate.evidence,
                  }),
                  first.sourceHash,
                  first.excerpt,
                  context.effectiveMaxSecurityLevel,
                  context.authorization.authzVersion,
                  timestamp,
                ],
              );
              await client.query(
                `insert into knowledge.assertion(assertion_id,tenant_id,project_id,evidence_fragment_id,subject,predicate,object,confidence,generation_method,status,security_level,policy_version,created_at,updated_at) values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,null,$8,'PENDING_REVIEW',$9,$10,$11,$11)`,
                [
                  id,
                  ...scope,
                  evidenceId,
                  JSON.stringify(candidate.subject),
                  candidate.predicate,
                  JSON.stringify(candidate.object),
                  candidate.generation.method,
                  context.effectiveMaxSecurityLevel,
                  context.authorization.authzVersion,
                  timestamp,
                ],
              );
              await client.query(
                `insert into knowledge.assertion_binding(assertion_id,tenant_id,project_id,data_item_id,version_id,mapping_version,identity_key,fingerprint,candidate,security_level,policy_version) values($1,$2,$3,$4,$5,$6,$7,decode($8,'hex'),$9::jsonb,$10,$11)`,
                [
                  id,
                  ...scope,
                  input.dataItemId,
                  input.versionId,
                  input.mappingVersion,
                  identity,
                  fingerprint,
                  JSON.stringify(candidate),
                  context.effectiveMaxSecurityLevel,
                  context.authorization.authzVersion,
                ],
              );
              items.push(await load(client, id));
              createdCount++;
            }
            const output = {
              items,
              createdCount,
              reusedCount: items.length - createdCount,
            };
            return {
              output,
              replayResult: {
                ids: items.map((x) => x.assertionId),
                createdCount,
              },
              aggregateId: input.versionId,
              eventType: 'data.knowledge.relations.imported',
              securityLevel: context.effectiveMaxSecurityLevel,
            };
          },
          async (client, _time, ledger) => {
            const saved = z
              .object({ ids: z.array(z.uuid()), createdCount: z.number() })
              .parse(ledger.result);
            const items = [];
            for (const id of saved.ids) items.push(await load(client, id));
            return ImportRelationsOutputSchema.parse({
              items,
              createdCount: saved.createdCount,
              reusedCount: items.length - saved.createdCount,
            });
          },
        );
      },
    },
    {
      id: 'data.knowledge.relations.get',
      execute: (raw, context) =>
        read(context, async (c) => ({
          assertion: await load(
            c,
            RelationGetInputSchema.parse(raw).assertionId,
          ),
        })),
    },
    {
      id: 'data.knowledge.relations.list',
      execute: (raw, context) =>
        read(context, async (c) => {
          const input = RelationBatchListInputSchema.parse(raw);
          let selectedSources: { dataItemId: string; versionId: string }[];
          if (input.queryId) {
            // Snapshot RLS binds tenant, project and owner. Expiry never becomes an empty success.
            const snapshot = await c.query(
              'select version_refs,spec,business_pins from service.exploration_snapshot where query_id=$1::uuid and actor_id=$2::uuid and expires_at > clock_timestamp()',
              [input.queryId, context.principal.actorId],
            );
            if (!snapshot.rows[0]) throw fail('NOT_FOUND');
            selectedSources = z
              .array(
                z.object({
                  dataItemId: z.uuid(),
                  versionId: z.uuid(),
                  analysisId: z.uuid().nullable().optional(),
                }),
              )
              .max(10000)
              .parse(snapshot.rows[0]['version_refs']);
            const checked = await c.query(
              `${AUTHORIZED} select count(*)::int total from authorized`,
              [JSON.stringify(selectedSources)],
            );
            if (checked.rows[0]?.['total'] !== selectedSources.length)
              throw fail('NOT_FOUND');
            const spec = QuerySpecSchema.parse(snapshot.rows[0]['spec'] ?? {});
            if (
              input.pageMode &&
              (spec.scope !== 'project' || !spec.businessQuery)
            )
              throw new DataCapabilityHandlerError('VALIDATION_FAILED');
            if (spec.businessQuery) {
              if (input.status !== spec.businessQuery.status)
                throw fail('NOT_FOUND');
              const resolved = await loadBusinessRelations(
                c,
                selectedSources,
                spec.businessQuery,
                storedBusinessMembership(
                  spec,
                  snapshot.rows[0]['business_pins'],
                ),
              );
              const matched = resolved.items.filter(
                (row) =>
                  (!input.mappingVersion ||
                    row.mappingVersion === input.mappingVersion) &&
                  (!input.entityKey ||
                    [
                      row.candidate.subject.key,
                      row.candidate.object.key,
                    ].includes(input.entityKey)) &&
                  (!input.entityReference ||
                    [row.candidate.subject, row.candidate.object].some(
                      (entity) => {
                        const ref = entity.reference ?? {
                          dataItemId: row.dataItemId,
                          versionId: row.versionId,
                          mappingVersion: row.mappingVersion,
                          entityKey: entity.key,
                        };
                        return (
                          ref.dataItemId ===
                            input.entityReference!.dataItemId &&
                          ref.versionId === input.entityReference!.versionId &&
                          ref.mappingVersion ===
                            input.entityReference!.mappingVersion &&
                          ref.entityKey === input.entityReference!.entityKey
                        );
                      },
                    )),
              );
              if (
                input.after &&
                !matched.some((row) => row.assertionId === input.after)
              )
                throw fail('NOT_FOUND');
              const offset = input.after
                ? matched.findIndex((row) => row.assertionId === input.after) +
                  1
                : 0;
              if (input.pageMode) {
                try {
                  return boundedRelationPage(matched, offset, input.first);
                } catch (error) {
                  if (error instanceof RangeError)
                    throw new DataCapabilityHandlerError('VALIDATION_FAILED');
                  throw error;
                }
              }
              const items = matched.slice(offset, offset + input.first);
              return {
                items,
                totalCount: matched.length,
                ...(offset + items.length < matched.length
                  ? { nextCursor: items.at(-1)!.assertionId }
                  : {}),
              };
            }
          } else {
            selectedSources = [
              { dataItemId: input.dataItemId!, versionId: input.versionId! },
              ...(input.relatedSources ?? []),
            ];
            // Reject conflicting ownership before deduplication, preserving legacy behavior.
            for (const source of selectedSources) await authorize(c, source);
          }
          if (input.status === 'APPROVED_AND_PENDING')
            throw new DataCapabilityHandlerError('VALIDATION_FAILED');
          const sources = [
            ...new Map(
              selectedSources.map((source) => [source.versionId, source]),
            ).values(),
          ];
          if (
            input.entityReference &&
            !sources.some(
              (s) =>
                s.dataItemId === input.entityReference!.dataItemId &&
                s.versionId === input.entityReference!.versionId,
            )
          )
            throw fail('NOT_FOUND');
          if (input.after) {
            const cursor = await load(c, input.after);
            if (
              !sources.some(
                (s) =>
                  s.versionId === cursor.versionId &&
                  s.dataItemId === cursor.dataItemId,
              ) ||
              cursor.status !== input.status
            )
              throw fail('NOT_FOUND');
          }
          const where = `exists(select 1 from jsonb_array_elements($1::jsonb) source where b.data_item_id=(source->>'dataItemId')::uuid and b.version_id=(source->>'versionId')::uuid)
            and a.status=$2 and ($3::text is null or a.subject->>'key'=$3 or a.object->>'key'=$3)
            and ($4::text is null or b.mapping_version=$4)
            and ($5::jsonb is null or exists(select 1 from (values(b.candidate->'subject'),(b.candidate->'object')) ent(value) where
              (b.data_item_id=($5->>'dataItemId')::uuid and b.version_id=($5->>'versionId')::uuid and b.mapping_version=$5->>'mappingVersion' and value->>'key'=$5->>'entityKey')
              or value->'reference'=$5::jsonb)) and ${VISIBLE}`;
          const values = [
            JSON.stringify(sources),
            input.status,
            input.entityKey ?? null,
            input.mappingVersion ?? null,
            input.entityReference
              ? JSON.stringify(input.entityReference)
              : null,
          ];
          const count = await c.query(
            `select count(*)::int total from knowledge.assertion_binding b join knowledge.assertion a using(tenant_id,project_id,assertion_id) where ${where}`,
            values,
          );
          const page = await c.query(
            `${SELECT} where ${where} and ($6::uuid is null or b.assertion_id>$6::uuid) order by b.assertion_id limit $7`,
            [...values, input.after ?? null, input.first + 1],
          );
          const items = page.rows.slice(0, input.first).map(assertion);
          return {
            items,
            totalCount: count.rows[0]?.['total'],
            ...(page.rows.length > input.first
              ? { nextCursor: items.at(-1)!.assertionId }
              : {}),
          };
        }),
    },
    {
      id: 'data.knowledge.relations.review',
      async execute(raw, context) {
        if (context.principal.actorType !== 'human')
          throw new DataCapabilityHandlerError('FORBIDDEN');
        const input = RelationReviewInputSchema.parse(raw);
        return tx.run(
          'data.knowledge.relations.review',
          input,
          context,
          async (c, timestamp) => {
            await c.query(
              'select assertion_id from knowledge.assertion where assertion_id=$1::uuid for update',
              [input.assertionId],
            );
            const previous = await load(c, input.assertionId);
            if (
              previous.version !== input.expectedVersion ||
              previous.version >= 101
            )
              throw fail('STATE_CONFLICT');
            await c.query(
              `insert into knowledge.review_record(review_record_id,tenant_id,project_id,assertion_id,reviewer_actor_id,decision,rationale,security_level,policy_version,row_version,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
              [
                randomUUID(),
                context.authorization.tenantId,
                context.authorization.projectId,
                input.assertionId,
                context.principal.actorId,
                input.decision,
                input.rationale,
                context.effectiveMaxSecurityLevel,
                context.authorization.authzVersion,
                input.expectedVersion + 1,
                timestamp,
              ],
            );
            await c.query(
              `update knowledge.assertion set status=$2,row_version=row_version+1,updated_at=$3 where assertion_id=$1::uuid and row_version=$4`,
              [
                input.assertionId,
                input.decision,
                timestamp,
                input.expectedVersion,
              ],
            );
            const output = { assertion: await load(c, input.assertionId) };
            return {
              output,
              replayResult: { assertionId: input.assertionId },
              aggregateId: input.assertionId,
              eventType: 'data.knowledge.relation.reviewed',
              securityLevel: context.effectiveMaxSecurityLevel,
            };
          },
          async (c, _time, ledger) => ({
            assertion: await load(
              c,
              RelationGetInputSchema.parse(ledger.result).assertionId,
            ),
          }),
        );
      },
    },
  ];
}
