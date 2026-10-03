import { createHash } from 'node:crypto';
import {
  FrozenIngestionCandidateInputSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateRecordPageSchema,
  PlatformUuidSchema,
  SourceRegistrationManifestSchema,
  SourceRegistrationSchema,
  type IngestionCandidateBatch,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  matchesFrozenIngestionCandidate,
  resolveIngestionReviewGovernance,
} from '@wiser/data-core';
import {
  ANALYSIS_PARSER_VERSION,
  AnalysisContentError,
  DATA_INGESTION_PROCESS_JOB_TYPE,
  parseIngestionCandidateContent,
  type AnalysisColumn,
  type AnalysisContentEvent,
  type ClaimedDataJob,
  type DataPostgresPool,
  type S3QuarantineObjectReference,
} from '@wiser/data-infra';
import { resolveAnalysisSource } from '../analysis-source.js';
import type { ExternalIngestionCandidateInput } from '../adapters/analysis-parser.js';
import { canonicalPipelineHash } from './ingestion-pipeline.js';
import { DataJobHandlerError } from './registry.js';

const MAX_BYTES = 64 * 1024 * 1024;
type ParsedRecord = Extract<AnalysisContentEvent, { type: 'record' }>;
type CandidateAsset = IngestionCandidateBatch['assets'][number];

function failure(category = 'CANDIDATE_AUTHORITY_INVALID', retryable = false) {
  return new DataJobHandlerError(
    category,
    retryable,
    'The frozen ingestion candidate could not be processed safely.',
  );
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw failure();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw failure();
  return value;
}
function uuid(value: unknown): string {
  const parsed = PlatformUuidSchema.safeParse(value);
  if (!parsed.success) throw failure();
  return parsed.data;
}

function referenceFor(
  job: ClaimedDataJob,
  ingestionId: string,
  reviewHash: string,
): IngestionCandidateReference {
  const hex = createHash('sha256')
    .update(
      [
        'wiser.ingestion-candidate.batch.v1',
        job.tenantId,
        job.projectId,
        ingestionId,
        reviewHash,
        ANALYSIS_PARSER_VERSION,
      ].join('\0'),
    )
    .digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return {
    kind: 'ingestion-candidate',
    ingestionId,
    reviewHash,
    processingBatchId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  };
}

const LOAD_CHECKPOINT_SQL = `
/* candidate.load-checkpoint */
select session.state, session.security_level, session.policy_version,
  session.operation_id, session.submitted_by_actor_id, session.submitted_actor_type,
  session.submitted_delegator_actor_id, session.review_policy_snapshot,
  frozen.transform_plan_id, frozen.plan as frozen_checkpoint,
  encode(frozen.plan_hash,'hex') as review_hash,
  (select jsonb_build_object('mode',mode,'revision',revision)
    from ingestion.project_review_policy where tenant_id=session.tenant_id
      and project_id=session.project_id and enabled) as current_review_policy
from ingestion.session session
join lateral (
  select transform_plan_id, plan, plan_hash from ingestion.transform_plan
  where tenant_id=session.tenant_id and project_id=session.project_id
    and ingestion_id=session.ingestion_id and status='REVIEW_REQUIRED'
  order by plan_version desc limit 1
) frozen on true
where session.tenant_id=$1::uuid and session.project_id=$2::uuid
  and session.ingestion_id=$3::uuid and session.operation_id=$4::uuid
  and session.owner_project_id=session.project_id and session.state='REVIEW_REQUIRED'
  and session.security_level=$5 and session.policy_version=$6::bigint
for share of session
`;
const LOAD_ASSETS_SQL = `
/* candidate.load-assets */
select asset.asset_id, input.ordinal, asset.storage_key, asset.media_type,
  asset.byte_size, encode(blob.content_hash,'hex') as source_hash
from ingestion.input_asset input
join catalog.asset asset on asset.tenant_id=input.tenant_id
  and asset.project_id=input.project_id and asset.asset_id=input.asset_id
join catalog.content_blob blob on blob.tenant_id=asset.tenant_id
  and blob.project_id=asset.project_id and blob.content_blob_id=asset.content_blob_id
where input.tenant_id=$1::uuid and input.project_id=$2::uuid
  and input.ingestion_id=$3::uuid and input.fingerprint=blob.content_hash
  and asset.lifecycle_state='QUARANTINED' and asset.version_id is null
order by input.ordinal, asset.asset_id
for share of input, asset, blob
`;

function resultFor(batch: IngestionCandidateBatch) {
  return {
    reference: batch.reference,
    status: batch.status,
    parsedRecordCount: batch.assets.reduce(
      (sum, asset) => sum + (asset.recordCount ?? 0),
      0,
    ),
    parsedFeatureCount: batch.assets.reduce(
      (sum, asset) => sum + (asset.featureCount ?? 0),
      0,
    ),
    unknownAssetCount: batch.assets.filter(
      (asset) => asset.recordCount === null,
    ).length,
  };
}

/** Uses the current leased ingestion Job; it never settles, approves or publishes it. */
export function createIngestionCandidateProcessor(options: {
  readonly pool: DataPostgresPool;
  readonly read: (
    input: S3QuarantineObjectReference & { readonly maximumBytes: number },
  ) => Promise<Uint8Array>;
  readonly parseExternal?: (
    input: ExternalIngestionCandidateInput,
  ) => AsyncIterable<AnalysisContentEvent>;
}) {
  return async (
    job: ClaimedDataJob,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const ingestionId = uuid(job.payload['ingestionId']);
    const tenantId = uuid(job.tenantId);
    const projectId = uuid(job.projectId);
    if (
      job.jobType !== DATA_INGESTION_PROCESS_JOB_TYPE ||
      job.cancelRequested ||
      ![job.jobId, job.operationId, job.tenantId, job.projectId].every(
        (id) => PlatformUuidSchema.safeParse(id).success,
      ) ||
      ![
        'L0_PUBLIC',
        'L1_INTERNAL',
        'L2_RESTRICTED',
        'L3_CONFIDENTIAL',
      ].includes(job.securityLevel ?? '') ||
      !Number.isSafeInteger(job.policyVersion) ||
      job.policyVersion === undefined ||
      job.policyVersion < 1 ||
      !Number.isSafeInteger(job.attemptCount) ||
      job.attemptCount < 1 ||
      !job.leaseOwner.length
    )
      throw failure('INVALID_INGESTION_JOB');

    const client = await options.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),
        set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),
        set_config('wiser.candidate_job_id',$5,true),set_config('wiser.candidate_job_owner',$6,true),
        set_config('wiser.candidate_job_attempt',$7,true),
        set_config('idle_in_transaction_session_timeout','15min',true)`,
        [
          job.tenantId,
          job.projectId,
          job.securityLevel,
          String(job.policyVersion),
          job.jobId,
          job.leaseOwner,
          String(job.attemptCount),
        ],
      );
      const row = (
        await client.query(LOAD_CHECKPOINT_SQL, [
          job.tenantId,
          job.projectId,
          ingestionId,
          job.operationId,
          job.securityLevel,
          job.policyVersion,
        ])
      ).rows[0];
      if (
        !row ||
        row['state'] !== 'REVIEW_REQUIRED' ||
        row['operation_id'] !== job.operationId ||
        row['security_level'] !== job.securityLevel ||
        Number(row['policy_version']) !== job.policyVersion
      )
        throw failure('CANDIDATE_CHECKPOINT_UNAVAILABLE');
      uuid(row['submitted_by_actor_id']);
      if (
        !['human', 'agent', 'service'].includes(
          text(row['submitted_actor_type']),
        ) ||
        (row['submitted_actor_type'] !== 'human' &&
          !PlatformUuidSchema.safeParse(row['submitted_delegator_actor_id'])
            .success)
      )
        throw failure();
      const governance = {
        frozen: row['review_policy_snapshot'],
        current: row['current_review_policy'],
      };
      if (
        resolveIngestionReviewGovernance(governance).kind !== 'REQUIRES_REVIEW'
      )
        throw failure('INGESTION_REVIEW_GOVERNANCE_CONFLICT');
      const frozen = object(row['frozen_checkpoint']);
      const { reviewHash, ...frozenBase } = frozen;
      if (
        reviewHash !== row['review_hash'] ||
        !/^[a-f0-9]{64}$/.test(text(reviewHash)) ||
        canonicalPipelineHash(frozenBase) !== reviewHash
      )
        throw failure('CANDIDATE_CHECKPOINT_CONFLICT');
      const manifest = object(frozen['assetManifest']);
      if (
        canonicalPipelineHash(manifest['reviewGovernance']) !==
        canonicalPipelineHash(governance.frozen)
      )
        throw failure('INGESTION_REVIEW_GOVERNANCE_CONFLICT');
      if (
        !Array.isArray(frozen['assetIds']) ||
        !Array.isArray(manifest['assets']) ||
        frozen['assetIds'].length < 1 ||
        frozen['assetIds'].length > 10_000 ||
        new Set(frozen['assetIds']).size !== frozen['assetIds'].length
      )
        throw failure();
      const frozenAssetIds = frozen['assetIds'].map(uuid);
      const frozenAssets = manifest['assets'].map(object);
      const reference = referenceFor(job, ingestionId, text(reviewHash));
      const assetRows = (
        await client.query(LOAD_ASSETS_SQL, [
          job.tenantId,
          job.projectId,
          ingestionId,
        ])
      ).rows;
      const assets = assetRows.map((assetRow) => {
        const assetId = uuid(assetRow['asset_id']);
        const saved = frozenAssets.find(
          (entry) => entry['assetId'] === assetId,
        );
        const expected = object(saved);
        const size = Number(assetRow['byte_size']);
        const storageKey = text(assetRow['storage_key']);
        const prefix = `tenants/${job.tenantId}/projects/${job.projectId}/quarantine/`;
        if (!storageKey.startsWith(prefix) || !storageKey.endsWith('/object'))
          throw failure();
        const uploadId = uuid(
          storageKey.slice(prefix.length, -'/object'.length),
        );
        const hash = text(assetRow['source_hash']);
        if (
          !/^[a-f0-9]{64}$/.test(hash) ||
          expected['sourceHash'] !== hash ||
          expected['uploadId'] !== uploadId ||
          expected['quarantineObjectRef'] !== storageKey ||
          expected['size'] !== size ||
          expected['mediaType'] !== assetRow['media_type'] ||
          expected['ordinal'] !== Number(assetRow['ordinal']) ||
          !Number.isSafeInteger(size) ||
          size < 0
        )
          throw failure('CANDIDATE_ORIGINAL_CONFLICT');
        return {
          assetId,
          sourceHash: hash,
          uploadId,
          mediaType: text(assetRow['media_type']),
          size,
        };
      });
      if (
        assets.length !== frozenAssetIds.length ||
        assets.length !== frozenAssets.length ||
        new Set(assets.map((asset) => asset.assetId)).size !== assets.length ||
        assets.some((asset) => !frozenAssetIds.includes(asset.assetId))
      )
        throw failure('CANDIDATE_ORIGINAL_CONFLICT');
      const authority = FrozenIngestionCandidateInputSchema.parse({
        ingestionId,
        state: 'REVIEW_REQUIRED',
        reviewHash,
        processingBatchId: reference.processingBatchId,
        reviewGovernance: governance,
        assets: assets.map(({ assetId, sourceHash }) => ({
          assetId,
          sourceHash,
        })),
      });
      const leaseFence = async () => {
        const lease = await client.query(
          `/* candidate.lease-fence */
          select job_id from ingestion.job where tenant_id=$1::uuid and project_id=$2::uuid
          and job_id=$3::uuid and operation_id=$4::uuid and ingestion_id=$5::uuid
          and job_type='data.ingestion.process' and status='RUNNING' and lease_owner=$6
          and attempt_count=$7 and lease_expires_at>clock_timestamp() and cancel_requested_at is null
          and (timeout_at is null or timeout_at>clock_timestamp())
          and security_level=$8 and policy_version=$9::bigint for update`,
          [
            job.tenantId,
            job.projectId,
            job.jobId,
            job.operationId,
            ingestionId,
            job.leaseOwner,
            job.attemptCount,
            job.securityLevel,
            job.policyVersion,
          ],
        );
        if (!lease.rows.length) throw failure('JOB_LEASE_LOST');
      };
      const existing = (
        await client.query(
          `/* candidate.load-batch */
        select ingestion.candidate_batch_result(processing_batch_id) as batch from ingestion.candidate_batch
        where processing_batch_id=$1::uuid and status<>'PENDING'`,
          [reference.processingBatchId],
        )
      ).rows[0];
      if (existing) {
        const batch = IngestionCandidateBatchSchema.parse(existing['batch']);
        if (
          batch.parserVersion !== ANALYSIS_PARSER_VERSION ||
          !matchesFrozenIngestionCandidate(authority, batch)
        )
          throw failure('CANDIDATE_CHECKPOINT_CONFLICT');
        await leaseFence();
        await client.query('commit');
        return resultFor(batch);
      }
      await client.query(
        `/* candidate.insert-batch */
        insert into ingestion.candidate_batch(processing_batch_id,tenant_id,project_id,ingestion_id,transform_plan_id,
          operation_id,review_hash,parser_version,security_level,policy_version)
        values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,decode($7,'hex'),$8,$9,$10::bigint)`,
        [
          reference.processingBatchId,
          job.tenantId,
          job.projectId,
          ingestionId,
          uuid(row['transform_plan_id']),
          job.operationId,
          reviewHash,
          ANALYSIS_PARSER_VERSION,
          job.securityLevel,
          job.policyVersion,
        ],
      );

      const sourceRegistration =
        manifest['sourceRegistration'] === undefined
          ? null
          : SourceRegistrationSchema.parse(manifest['sourceRegistration']);
      const read = async (original: (typeof assets)[number]) => {
        const content = await options.read({
          tenantId,
          projectId,
          uploadId: original.uploadId,
          maximumBytes: MAX_BYTES,
        });
        if (
          content.byteLength !== original.size ||
          createHash('sha256').update(content).digest('hex') !==
            original.sourceHash
        )
          throw failure('CANDIDATE_OBJECT_INTEGRITY');
        return content;
      };
      let files: ReturnType<
        typeof SourceRegistrationManifestSchema.parse
      >['files'] = [];
      if (sourceRegistration) {
        const sourceManifest = assets.find(
          (asset) => asset.assetId === sourceRegistration.manifestAssetId,
        );
        if (
          !sourceManifest ||
          sourceManifest.size > 512 * 1024 ||
          sourceManifest.sourceHash !== sourceRegistration.manifestSha256
        )
          throw failure('CANDIDATE_MANIFEST_CONFLICT');
        files = SourceRegistrationManifestSchema.parse(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              await read(sourceManifest),
            ),
          ),
        ).files;
        if (
          files.some(
            (file) =>
              file.assetId !== undefined &&
              !assets.some(
                (asset) =>
                  asset.assetId === file.assetId &&
                  asset.sourceHash === file.preparedSha256,
              ),
          )
        )
          throw failure('CANDIDATE_ORIGINAL_CONFLICT');
      }
      const outcomes: CandidateAsset[] = [];
      for (const asset of assets) {
        let status: CandidateAsset['status'] = 'UNSUPPORTED';
        let reason: string | null = 'UNSUPPORTED_FORMAT';
        let recordCount: number | null = null;
        let featureCount: number | null = null;
        let columns: readonly AnalysisColumn[] = [];
        const source = resolveAnalysisSource(
          asset.assetId,
          asset.mediaType,
          files,
        );
        const isManifest =
          sourceRegistration?.manifestAssetId === asset.assetId;
        await client.query(
          `/* candidate.insert-asset */
          insert into ingestion.candidate_asset(processing_batch_id,asset_id,tenant_id,project_id,source_hash,security_level,policy_version)
          values($1::uuid,$2::uuid,$3::uuid,$4::uuid,decode($5,'hex'),$6,$7::bigint)`,
          [
            reference.processingBatchId,
            asset.assetId,
            job.tenantId,
            job.projectId,
            asset.sourceHash,
            job.securityLevel,
            job.policyVersion,
          ],
        );
        if (isManifest) reason = 'SOURCE_MANIFEST';
        else if (source.companionOf) {
          status = 'PARTIAL';
          reason = 'FORMAT_COMPANION';
          recordCount = 0;
          featureCount = 0;
        } else if (asset.size > MAX_BYTES) reason = 'SIZE_LIMIT';
        else if (source.format === null) reason = 'UNSUPPORTED_FORMAT';
        else if (
          source.format !== 'csv' &&
          source.format !== 'json' &&
          !options.parseExternal
        )
          reason = 'PARSER_NOT_CONFIGURED';
        else {
          await client.query('savepoint candidate_asset_records');
          try {
            const input = {
              reference,
              assetId: asset.assetId,
              sourceHash: asset.sourceHash,
              bytes: await read(asset),
              format: source.format,
            };
            const events =
              source.format === 'csv' || source.format === 'json'
                ? parseIngestionCandidateContent({
                    ...input,
                    format: source.format,
                  })
                : options.parseExternal!({
                    ...input,
                    path: source.path,
                    companions: await Promise.all(
                      source.companions.map(async (companion) => {
                        const linked = assets.find(
                          (entry) => entry.assetId === companion.assetId,
                        );
                        if (!linked)
                          throw failure('CANDIDATE_ORIGINAL_CONFLICT');
                        return {
                          path: companion.path,
                          sourceHash: linked.sourceHash,
                          bytes: await read(linked),
                        };
                      }),
                    ),
                  });
            const records: ParsedRecord[] = [];
            let schemaSeen = false,
              finished = false,
              seen = 0,
              features = 0;
            const flush = async () => {
              if (!records.length) return;
              const checked = IngestionCandidateRecordPageSchema.safeParse({
                reference,
                assetId: asset.assetId,
                columns,
                records: records.map((record) => ({
                  recordId: record.recordId,
                  assetId: asset.assetId,
                  index: record.index,
                  sourceId: record.sourceId,
                  values: record.values,
                  hasGeometry: record.geometry !== null,
                })),
                nextCursor: null,
              });
              if (!checked.success)
                throw new AnalysisContentError('INVALID_CONTENT');
              const body = JSON.stringify(records);
              if (Buffer.byteLength(body) > 3 * 1024 * 1024)
                throw new AnalysisContentError('CAPACITY_LIMIT');
              await client.query(
                `/* candidate.insert-records */
                insert into ingestion.candidate_record(processing_batch_id,record_id,asset_id,tenant_id,project_id,
                  record_index,source_id,record_values,geom,source_crs,security_level,policy_version)
                select $1::uuid,(r->>'recordId')::uuid,$2::uuid,$3::uuid,$4::uuid,(r->>'index')::bigint,r->>'sourceId',r->'values',
                  case when r->'geometry'='null'::jsonb then null else st_setsrid(st_geomfromgeojson((r->'geometry')::text),4326) end,
                  r->>'sourceCrs',$5,$6::bigint from jsonb_array_elements($7::jsonb) r`,
                [
                  reference.processingBatchId,
                  asset.assetId,
                  job.tenantId,
                  job.projectId,
                  job.securityLevel,
                  job.policyVersion,
                  body,
                ],
              );
              records.length = 0;
            };
            for await (const event of events) {
              if (finished) throw new AnalysisContentError('INVALID_CONTENT');
              if (event.type === 'schema') {
                if (schemaSeen)
                  throw new AnalysisContentError('INVALID_CONTENT');
                columns = event.columns;
                schemaSeen = true;
                if (
                  !IngestionCandidateRecordPageSchema.safeParse({
                    reference,
                    assetId: asset.assetId,
                    columns,
                    records: [],
                    nextCursor: null,
                  }).success
                )
                  throw new AnalysisContentError('INCONSISTENT_COLUMNS');
              } else if (event.type === 'record') {
                if (!schemaSeen || event.index !== ++seen || seen > 2_000_000)
                  throw new AnalysisContentError('INVALID_CONTENT');
                if (event.geometry !== null) features += 1;
                records.push(event);
                if (records.length === 200) await flush();
              } else {
                if (
                  !schemaSeen ||
                  event.recordCount !== seen ||
                  event.featureCount !== features
                )
                  throw new AnalysisContentError('INVALID_CONTENT');
                finished = true;
                status = event.status;
                reason = event.reason ?? null;
                recordCount = seen;
                featureCount = features;
              }
            }
            if (!finished) throw new AnalysisContentError('INVALID_CONTENT');
            await flush();
            await client.query('release savepoint candidate_asset_records');
          } catch (error) {
            await client.query('rollback to savepoint candidate_asset_records');
            await client.query('release savepoint candidate_asset_records');
            if (!(error instanceof AnalysisContentError)) throw error;
            status = [
              'RECORD_LIMIT',
              'SIZE_LIMIT',
              'UNKNOWN_CRS',
              'COLUMN_LIMIT',
              'ARCHIVE_LIMIT',
              'CAPACITY_LIMIT',
              'PARSING_FAILED',
              'MISSING_COMPANION',
            ].includes(error.code)
              ? 'UNSUPPORTED'
              : error.code === 'ENCRYPTED_CONTENT'
                ? 'RESTRICTED'
                : 'INVALID';
            reason = error.code;
            recordCount = null;
            featureCount = null;
            columns = [];
          }
        }
        outcomes.push({
          assetId: asset.assetId,
          sourceHash: asset.sourceHash,
          status,
          reason,
          recordCount,
          featureCount,
        });
        await client.query(
          `/* candidate.finish-asset */
          update ingestion.candidate_asset set status=$3,reason=$4,record_count=$5,feature_count=$6,columns=$7::jsonb
          where processing_batch_id=$1::uuid and asset_id=$2::uuid`,
          [
            reference.processingBatchId,
            asset.assetId,
            status,
            reason,
            recordCount,
            featureCount,
            JSON.stringify(columns),
          ],
        );
      }
      const all = outcomes.every((asset) =>
        ['READY', 'EMPTY'].includes(asset.status),
      );
      const unavailable = outcomes.every(
        (asset) => !['READY', 'EMPTY', 'PARTIAL'].includes(asset.status),
      );
      const batch = IngestionCandidateBatchSchema.parse({
        reference,
        parserVersion: ANALYSIS_PARSER_VERSION,
        status: all ? 'READY' : unavailable ? 'UNAVAILABLE' : 'PARTIAL',
        assets: outcomes,
        createdAt: new Date().toISOString(),
      });
      if (!matchesFrozenIngestionCandidate(authority, batch))
        throw failure('CANDIDATE_CHECKPOINT_CONFLICT');
      await leaseFence();
      await client.query(
        `/* candidate.finish-batch */ update ingestion.candidate_batch
        set status=$2,completed_at=clock_timestamp() where processing_batch_id=$1::uuid and status='PENDING'`,
        [reference.processingBatchId, batch.status],
      );
      await client.query('commit');
      return resultFor(batch);
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (error instanceof DataJobHandlerError) throw error;
      throw failure('CANDIDATE_PROCESSING_TEMPORARY', true);
    } finally {
      client.release();
    }
  };
}
