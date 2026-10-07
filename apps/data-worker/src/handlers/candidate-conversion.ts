import { createHash, randomUUID } from 'node:crypto';
import type { IngestionCandidateReference } from '@wiser/data-contracts';
import {
  CandidateConversionCheckSchema,
  CandidateWordStructureSchema,
  type CandidateConversionCheck,
  type CandidateConversionDeclaration,
} from '@wiser/data-contracts/candidate-conversion';
import {
  CANDIDATE_WORD_EQUIVALENCE_RULE,
  compareCandidateConversionStructure,
} from '@wiser/data-core/candidate-conversion';
import type { ClaimedDataJob, DataPostgresClient } from '@wiser/data-infra';
import { canonicalPipelineHash } from './ingestion-pipeline.js';

type Tool = NonNullable<CandidateConversionCheck['tool']>;
type UnverifiableReason = Exclude<
  NonNullable<CandidateConversionCheck['failureReason']>,
  'STRUCTURE_DIFFERENT'
>;

const StructureFailureReasonSchema =
  CandidateConversionCheckSchema.shape.failureReason
    .unwrap()
    .exclude(['STRUCTURE_DIFFERENT']);

/** Strict private shape and enum; unknown kinds/errors never become tool failures. */
export function candidateStructureFailure(
  value: unknown,
): UnverifiableReason | null {
  if (value === null || typeof value !== 'object') return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!Object.hasOwn(fields, 'kind')) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(fields).length !== 2 ||
    !Object.hasOwn(fields, 'reason') ||
    !Object.hasOwn(fields['kind']!, 'value') ||
    !Object.hasOwn(fields['reason']!, 'value') ||
    fields['kind']!.value !== 'UNVERIFIABLE'
  )
    throw new Error('Invalid private structure runner outcome');
  return StructureFailureReasonSchema.parse(fields['reason']!.value);
}

/** Host-only port: discover actual tool identity; never accept it from claims. */
export interface CandidateConversionRunner {
  reconvert(input: {
    readonly originalBytes: Uint8Array;
    readonly maximumBytes: number;
    readonly checkAuthority: () => Promise<void>;
  }): Promise<
    | {
        readonly kind: 'CONVERTED';
        readonly bytes: Uint8Array;
        readonly tool: Tool;
      }
    | { readonly kind: 'UNVERIFIABLE'; readonly reason: UnverifiableReason }
  >;
  extractStructure(input: {
    readonly bytes: Uint8Array;
    readonly maximumBytes: number;
    readonly checkAuthority: () => Promise<void>;
  }): Promise<unknown>;
}

/** Only explicit ordinary tool outcomes are mapped; authority/DB errors propagate. */
export async function verifyCandidateConversion(input: {
  readonly declaration: CandidateConversionDeclaration;
  readonly reference: IngestionCandidateReference;
  readonly maximumBytes: number;
  readonly runner?: CandidateConversionRunner;
  readonly read: (assetId: string) => Promise<Uint8Array>;
  readonly checkAuthority: () => Promise<void>;
}): Promise<CandidateConversionCheck> {
  const base = {
    ...input.declaration,
    schemaVersion: 1 as const,
    resultId: randomUUID(),
    reference: input.reference,
    kind: 'HISTORICAL_EQUIVALENCE' as const,
    rule: CANDIDATE_WORD_EQUIVALENCE_RULE,
  };
  const unverifiable = (reason: UnverifiableReason, tool: Tool | null = null) =>
    CandidateConversionCheckSchema.parse({
      ...base,
      state: 'UNVERIFIABLE',
      tool,
      reconvertedSha256: null,
      comparisonDigest: null,
      comparison: null,
      failureReason: reason,
    });
  await input.checkAuthority();
  if (!input.runner) return unverifiable('TOOL_UNAVAILABLE');
  if (
    input.declaration.original.byteSize > input.maximumBytes ||
    input.declaration.prepared.byteSize > input.maximumBytes
  )
    return unverifiable('BUDGET_EXCEEDED');
  const originalBytes = await input.read(input.declaration.original.assetId);
  const preparedBytes = await input.read(input.declaration.prepared.assetId);
  await input.checkAuthority();
  const converted = await input.runner.reconvert({
    originalBytes,
    maximumBytes: input.maximumBytes,
    checkAuthority: input.checkAuthority,
  });
  await input.checkAuthority();
  if (converted.kind === 'UNVERIFIABLE') return unverifiable(converted.reason);
  if (
    converted.kind !== 'CONVERTED' ||
    !(converted.bytes instanceof Uint8Array)
  )
    throw new Error('Invalid trusted conversion runner response');
  if (converted.bytes.byteLength > input.maximumBytes)
    return unverifiable('BUDGET_EXCEEDED', converted.tool);
  if (!converted.bytes.byteLength)
    return unverifiable('CONVERSION_FAILED', converted.tool);
  const prepared = await input.runner.extractStructure({
    bytes: preparedBytes,
    maximumBytes: input.maximumBytes,
    checkAuthority: input.checkAuthority,
  });
  await input.checkAuthority();
  const preparedFailure = candidateStructureFailure(prepared);
  if (preparedFailure) return unverifiable(preparedFailure, converted.tool);
  const reconverted = await input.runner.extractStructure({
    bytes: converted.bytes,
    maximumBytes: input.maximumBytes,
    checkAuthority: input.checkAuthority,
  });
  await input.checkAuthority();
  const reconvertedFailure = candidateStructureFailure(reconverted);
  if (reconvertedFailure)
    return unverifiable(reconvertedFailure, converted.tool);
  const comparison = compareCandidateConversionStructure(prepared, reconverted);
  if (comparison.kind === 'UNVERIFIABLE')
    return unverifiable(comparison.reason, converted.tool);
  return CandidateConversionCheckSchema.parse({
    ...base,
    state:
      comparison.kind === 'EQUIVALENT'
        ? 'VERIFIED_EQUIVALENT'
        : 'NOT_EQUIVALENT',
    tool: converted.tool,
    reconvertedSha256: createHash('sha256')
      .update(converted.bytes)
      .digest('hex'),
    comparisonDigest: canonicalPipelineHash({
      rule: CANDIDATE_WORD_EQUIVALENCE_RULE,
      prepared: CandidateWordStructureSchema.parse(prepared),
      reconverted: CandidateWordStructureSchema.parse(reconverted),
    }),
    comparison: comparison.summary,
    failureReason:
      comparison.kind === 'EQUIVALENT' ? null : 'STRUCTURE_DIFFERENT',
  });
}

/** The caller owns the current PENDING transaction and its completion fence. */
export async function insertCandidateConversionCheck(input: {
  readonly client: DataPostgresClient;
  readonly job: ClaimedDataJob;
  readonly check: CandidateConversionCheck;
  readonly submittedByActorId: string;
  readonly submittedActorType: string;
  readonly submittedDelegatorActorId: string | null;
  readonly reviewGovernance: unknown;
}): Promise<void> {
  const { client, job, check } = input;
  await client.query(
    `/* candidate.insert-conversion-check */
    insert into ingestion.candidate_conversion_check(
      result_id,tenant_id,project_id,processing_batch_id,ingestion_id,review_hash,
      original_asset_id,original_hash,original_byte_size,prepared_asset_id,prepared_hash,prepared_byte_size,
      manifest_asset_id,manifest_hash,source_local_work_id,historical_tool_version,result_kind,result_state,
      rule_id,rule_version,tool_name,tool_version,tool_digest,reconverted_hash,comparison_digest,
      comparison_summary,failure_reason,worker_job_id,worker_job_attempt,worker_lease_owner,operation_id,
      submitted_by_actor_id,submitted_actor_type,submitted_delegator_actor_id,review_governance,purpose,security_level,policy_version)
    values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,decode($6,'hex'),
      $7::uuid,decode($8,'hex'),$9,$10::uuid,decode($11,'hex'),$12,$13::uuid,decode($14,'hex'),
      $15,$16,$17,$18,$19,$20,$21,$22,decode($23,'hex'),decode($24,'hex'),decode($25,'hex'),
      $26::jsonb,$27,$28::uuid,$29,$30,$31::uuid,$32::uuid,$33,$34::uuid,$35::jsonb,$36,$37,$38::bigint)`,
    [
      check.resultId,
      job.tenantId,
      job.projectId,
      check.reference.processingBatchId,
      check.reference.ingestionId,
      check.reference.reviewHash,
      check.original.assetId,
      check.original.sha256,
      check.original.byteSize,
      check.prepared.assetId,
      check.prepared.sha256,
      check.prepared.byteSize,
      check.manifest.assetId,
      check.manifest.sha256,
      check.sourceLocalWorkId,
      check.historicalToolVersion,
      check.kind,
      check.state,
      check.rule.id,
      check.rule.version,
      check.tool?.name ?? null,
      check.tool?.version ?? null,
      check.tool?.digest ?? null,
      check.reconvertedSha256,
      check.comparisonDigest,
      check.comparison === null ? null : JSON.stringify(check.comparison),
      check.failureReason,
      job.jobId,
      job.attemptCount,
      job.leaseOwner,
      job.operationId,
      input.submittedByActorId,
      input.submittedActorType,
      input.submittedDelegatorActorId,
      JSON.stringify(input.reviewGovernance),
      'candidate-conversion-verification',
      job.securityLevel,
      job.policyVersion,
    ],
  );
}
