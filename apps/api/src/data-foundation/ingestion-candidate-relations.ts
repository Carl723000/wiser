import { z } from 'zod';
import {
  IngestionCandidateReferenceSchema,
  candidateSavedReferenceKey,
} from '@wiser/data-contracts';
import {
  CandidateRelationPinSchema,
  type CandidateRelationPin,
} from '@wiser/data-contracts/candidate-relations';
import { canonicalIngestionUuid } from '@wiser/data-core';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutionContext,
} from './capability-handler.js';
import {
  candidateReadAuthority,
  setCandidateReadAuthority,
} from './candidate-read-authority.js';
import { applyResourceReadScope } from './resource-read-scope.js';
import type { QueryAdapterPgClient } from './query-adapters.js';

const dependencySchema = z.strictObject({
  reference: IngestionCandidateReferenceSchema,
  assetId: z.uuid(),
  recordId: z.uuid().optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const rowSchema = CandidateRelationPinSchema.extend({
  dependencies: z.array(dependencySchema).min(1).max(64),
});
type ParsedRelation = z.infer<typeof rowSchema>;
export type CandidateRelationPinAuthority = Omit<
  ParsedRelation,
  'dependencies'
> & {
  dependencies: (Omit<ParsedRelation['dependencies'][number], 'recordId'> & {
    recordId?: string;
  })[];
};

const pinSql = `/* candidate.relations.fixed-pins */
select r.relation_id as "relationId",r.revision,
  coalesce(d.decision_version,0) as "decisionVersion",
  (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'reference',jsonb_build_object('kind','ingestion-candidate','ingestionId',e.ingestion_id,
      'processingBatchId',e.processing_batch_id,'reviewHash',encode(e.review_hash,'hex')),
    'assetId',e.asset_id,'recordId',e.record_id,'sourceHash',encode(e.source_hash,'hex'))) order by e.ordinal)
    from ingestion.candidate_relation_evidence e where e.tenant_id=r.tenant_id and e.project_id=r.project_id and e.revision_id=r.revision_id) as dependencies
from jsonb_array_elements($1::jsonb) requested
join ingestion.candidate_relation_revision r on r.relation_id=(requested->>'relationId')::uuid
  and r.revision=(requested->>'revision')::integer
left join lateral (select decision_version from ingestion.candidate_relation_decision
  where tenant_id=r.tenant_id and project_id=r.project_id and revision_id=r.revision_id
  order by decision_version desc limit 1) d on true
where r.tenant_id=$2::uuid and r.project_id=$3::uuid
  and ingestion.candidate_relation_sources_readable(r.tenant_id,r.project_id,r.content)
  and (select count(*) from ingestion.candidate_relation_evidence e
    where e.tenant_id=r.tenant_id and e.project_id=r.project_id and e.revision_id=r.revision_id)=jsonb_array_length(r.content->'evidence')`;

function authority(context: DataCapabilityExecutionContext): void {
  if (context.signal.aborted)
    throw new DataCapabilityHandlerError('CAPABILITY_TIMEOUT');
  const value = candidateReadAuthority(context);
  if (!value.maintainer && !value.reviewer)
    throw new DataCapabilityHandlerError('FORBIDDEN');
}

/** Internal host adapter only. The caller owns the already-open scoped transaction.
 * No public capability, source grant, independent transaction or published alias is added.
 */
export async function readCandidateRelationPinAuthorities(
  client: QueryAdapterPgClient,
  context: DataCapabilityExecutionContext,
  rawPins: readonly CandidateRelationPin[],
  rawReferences: unknown = [],
): Promise<readonly CandidateRelationPinAuthority[]> {
  authority(context);
  const references = IngestionCandidateReferenceSchema.array()
    .max(100)
    .safeParse(rawReferences);
  if (!references.success)
    throw new DataCapabilityHandlerError('VALIDATION_FAILED');
  const fixedKeys = new Set(references.data.map(candidateSavedReferenceKey));
  if (fixedKeys.size !== references.data.length)
    throw new DataCapabilityHandlerError('VALIDATION_FAILED');
  const parsed = z
    .array(CandidateRelationPinSchema)
    .max(100)
    .safeParse(rawPins);
  if (!parsed.success)
    throw new DataCapabilityHandlerError('VALIDATION_FAILED');
  const pins = parsed.data.map((pin) => ({
    ...pin,
    relationId: canonicalIngestionUuid(pin.relationId)!,
  }));
  const expected = new Map(
    pins.map((pin) => [`${pin.relationId}:${pin.revision}`, pin]),
  );
  if (expected.size !== pins.length)
    throw new DataCapabilityHandlerError('VALIDATION_FAILED');
  if (pins.length === 0) return [];
  const deadlines = [
    context.principal.expiresAt,
    context.authorization.resourceAccess?.scope.mode === 'managed'
      ? context.authorization.resourceAccess.scope.validUntil
      : null,
  ].filter((value): value is string => Boolean(value));
  await client.query(
    `/* candidate.relations.scope */ select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),
    set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),set_config('wiser.purpose',$5,true),set_config('wiser.candidate_view_deadline',$6,true)`,
    [
      context.authorization.tenantId,
      context.authorization.projectId,
      context.effectiveMaxSecurityLevel,
      String(context.authorization.authzVersion),
      context.authorization.purpose,
      deadlines.length
        ? new Date(Math.min(...deadlines.map(Date.parse))).toISOString()
        : 'infinity',
    ],
  );
  await applyResourceReadScope(
    client,
    context.authorization,
    context.resourceReadAction,
  );
  await setCandidateReadAuthority(client, context, references.data);
  const result = await client.query(pinSql, [
    JSON.stringify(pins),
    context.authorization.tenantId,
    context.authorization.projectId,
  ]);
  authority(context);
  if (result.rows.length !== pins.length)
    throw new DataCapabilityHandlerError('NOT_FOUND');
  const output: CandidateRelationPinAuthority[] = [];
  const seen = new Set<string>();
  for (const row of result.rows) {
    const checked = rowSchema.safeParse(row);
    if (!checked.success)
      throw new DataCapabilityHandlerError('EXECUTION_FAILED');
    const actual = {
      ...checked.data,
      relationId: canonicalIngestionUuid(checked.data.relationId)!,
      dependencies: checked.data.dependencies.map((item) => {
        const { recordId, ...dependency } = item;
        return {
          ...dependency,
          assetId: canonicalIngestionUuid(item.assetId)!,
          reference: {
            ...item.reference,
            ingestionId: canonicalIngestionUuid(item.reference.ingestionId)!,
            processingBatchId: canonicalIngestionUuid(
              item.reference.processingBatchId,
            )!,
          },
          ...(recordId ? { recordId: canonicalIngestionUuid(recordId)! } : {}),
        };
      }),
    };
    const key = `${actual.relationId}:${actual.revision}`,
      pin = expected.get(key);
    if (
      !pin ||
      seen.has(key) ||
      (fixedKeys.size > 0 &&
        actual.dependencies.some(
          (item) => !fixedKeys.has(candidateSavedReferenceKey(item.reference)),
        ))
    )
      throw new DataCapabilityHandlerError('NOT_FOUND');
    if (pin.decisionVersion !== actual.decisionVersion)
      throw new DataCapabilityHandlerError('CONFLICT');
    seen.add(key);
    output.push(actual);
  }
  authority(context);
  return pins.map((pin) =>
    output.find(
      (row) =>
        row.relationId === pin.relationId && row.revision === pin.revision,
    )!,
  );
}
