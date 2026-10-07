import {
  GetCandidateConversionProvenanceInputSchema,
  GetCandidateConversionProvenanceOutputSchema,
} from '@wiser/data-contracts/candidate-conversion';
import { canonicalIngestionUuid, sameIngestionUuid } from '@wiser/data-core';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutionContext,
} from './capability-handler.js';
import {
  candidateReadAuthority,
  setCandidateReadAuthority,
} from './candidate-read-authority.js';
import {
  canReadPendingSubmission,
  rowSubmissionResponsibility,
} from './managed-ingestion-access.js';
import { applyResourceReadScope } from './resource-read-scope.js';
import type { QueryAdapterPgPool } from './query-adapters.js';

const fixedSql = `/* candidate.provenance.fixed */
select b.ingestion_id,b.processing_batch_id,encode(b.review_hash,'hex') as review_hash,a.asset_id,
 s.submitted_by_actor_id,s.submitted_actor_type,s.submitted_delegator_actor_id,
 case when c.result_id is null then null else jsonb_build_object(
  'schemaVersion',1,'resultId',c.result_id,
  'reference',jsonb_build_object('kind','ingestion-candidate','ingestionId',b.ingestion_id,'processingBatchId',b.processing_batch_id,'reviewHash',encode(b.review_hash,'hex')),
  'kind',c.result_kind,'state',c.result_state,
  'original',jsonb_build_object('assetId',c.original_asset_id,'sha256',encode(c.original_hash,'hex'),'byteSize',c.original_byte_size),
  'prepared',jsonb_build_object('assetId',c.prepared_asset_id,'sha256',encode(c.prepared_hash,'hex'),'byteSize',c.prepared_byte_size),
  'manifest',jsonb_build_object('assetId',c.manifest_asset_id,'sha256',encode(c.manifest_hash,'hex')),
  'sourceLocalWorkId',c.source_local_work_id,'historicalToolVersion',c.historical_tool_version,
  'rule',jsonb_build_object('id',c.rule_id,'version',c.rule_version),
  'tool',case when c.tool_name is null then null else jsonb_build_object('name',c.tool_name,'version',c.tool_version,'digest',encode(c.tool_digest,'hex')) end,
  'reconvertedSha256',encode(c.reconverted_hash,'hex'),'comparisonDigest',encode(c.comparison_digest,'hex'),
  'comparison',c.comparison_summary,'failureReason',c.failure_reason) end as provenance
from ingestion.candidate_batch b
join ingestion.candidate_asset a on a.tenant_id=b.tenant_id and a.project_id=b.project_id and a.processing_batch_id=b.processing_batch_id
join ingestion.session s on s.tenant_id=b.tenant_id and s.project_id=b.project_id and s.ingestion_id=b.ingestion_id
left join ingestion.candidate_conversion_check c on c.tenant_id=b.tenant_id and c.project_id=b.project_id and c.processing_batch_id=b.processing_batch_id and c.prepared_asset_id=a.asset_id
where b.ingestion_id=$1::uuid and b.processing_batch_id=$2::uuid and b.review_hash=decode($3,'hex') and a.asset_id=$4::uuid
 and b.status<>'PENDING'`;

function authority(context: DataCapabilityExecutionContext) {
  if (context.signal.aborted)
    throw new DataCapabilityHandlerError('CAPABILITY_TIMEOUT');
  const result = candidateReadAuthority(context);
  if (!result.maintainer && !result.reviewer)
    throw new DataCapabilityHandlerError('FORBIDDEN');
  return result;
}

/** Narrow executor only; registry, managed admission and transport integration remain explicit. */
export function createCandidateConversionProvenanceReader(
  pool: QueryAdapterPgPool,
) {
  return {
    id: 'data.ingestion.candidate.provenance.get' as const,
    async execute(
      raw: unknown,
      context: DataCapabilityExecutionContext,
    ): Promise<unknown> {
      const parsed = GetCandidateConversionProvenanceInputSchema.safeParse(raw);
      if (!parsed.success)
        throw new DataCapabilityHandlerError('VALIDATION_FAILED');
      const input = parsed.data;
      const canonical = {
        reference: {
          kind: input.kind,
          ingestionId: canonicalIngestionUuid(input.ingestionId)!,
          processingBatchId: canonicalIngestionUuid(input.processingBatchId)!,
          reviewHash: input.reviewHash,
        },
        preparedAssetId: canonicalIngestionUuid(input.preparedAssetId)!,
      };
      authority(context);
      const client = await pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        await client.query(
          `/* candidate.provenance.scope */ select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true)`,
          [
            context.authorization.tenantId,
            context.authorization.projectId,
            context.effectiveMaxSecurityLevel,
            String(context.authorization.authzVersion),
          ],
        );
        await applyResourceReadScope(
          client,
          context.authorization,
          context.resourceReadAction,
        );
        await setCandidateReadAuthority(client, context, [canonical.reference]);
        const result = await client.query(fixedSql, [
          canonical.reference.ingestionId,
          canonical.reference.processingBatchId,
          canonical.reference.reviewHash,
          canonical.preparedAssetId,
        ]);
        const row = result.rows[0];
        if (
          result.rows.length !== 1 ||
          !row ||
          !sameIngestionUuid(
            String(row['ingestion_id']),
            canonical.reference.ingestionId,
          ) ||
          !sameIngestionUuid(
            String(row['processing_batch_id']),
            canonical.reference.processingBatchId,
          ) ||
          row['review_hash'] !== canonical.reference.reviewHash ||
          !sameIngestionUuid(
            String(row['asset_id']),
            canonical.preparedAssetId,
          ) ||
          !canReadPendingSubmission(
            context,
            rowSubmissionResponsibility(row),
            authority(context),
          )
        )
          throw new DataCapabilityHandlerError('NOT_FOUND');
        const output = GetCandidateConversionProvenanceOutputSchema.safeParse({
          ...canonical,
          check: row['provenance'],
        });
        if (!output.success)
          throw new DataCapabilityHandlerError('EXECUTION_FAILED');
        authority(context);
        await client.query('commit');
        authority(context);
        return output.data;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if (error instanceof DataCapabilityHandlerError) throw error;
        throw new DataCapabilityHandlerError('EXECUTION_FAILED');
      } finally {
        client.release();
      }
    },
  };
}
