import {
  IngestionCandidateReferenceSchema,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  PlatformUuidSchema,
  type PlatformRequestContext,
} from '@wiser/platform-contracts';
import type { S3AuthorityObjectStore } from '@wiser/data-infra/object-store';
import type { AssetDownloadPool } from './postgres-asset-download.js';
import { applyResourceReadScope } from './resource-read-scope.js';
import { setCandidateReadAuthority } from './candidate-read-authority.js';

export const MAX_CANDIDATE_ORIGINAL_BYTES = 32 * 1024 * 1024;
export interface CandidateOriginalInput {
  readonly context: PlatformRequestContext;
  readonly reference: IngestionCandidateReference;
  readonly assetId: string;
}
export interface CandidateOriginalDownload {
  /** Internal only: callers must proxy and verify, never redirect to this URL. */
  readonly url: string;
  readonly expiresAt: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface CandidateOriginalPort {
  createCandidateDownload(
    input: CandidateOriginalInput,
  ): Promise<CandidateOriginalDownload>;
  authorizeCandidateDownload(input: CandidateOriginalInput): Promise<void>;
}

const SCOPE_SQL = `/* data.candidate-original.scope */
select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),
  set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),
  set_config('wiser.candidate_original_ingestion',$5,true),
  set_config('wiser.candidate_original_batch',$6,true),
  set_config('wiser.candidate_original_review_hash',$7,true),
  set_config('wiser.candidate_original_asset',$8,true)
`;
const LOOKUP_SQL = `/* data.candidate-original.lookup */
select encode(candidate.source_hash,'hex') as source_hash,
  encode(asset.content_hash,'hex') as content_hash,encode(blob.content_hash,'hex') as blob_hash,
  asset.storage_key,asset.byte_size,asset.media_type,asset.security_level,asset.policy_version
from ingestion.candidate_batch batch
join ingestion.candidate_asset candidate using(tenant_id,project_id,processing_batch_id)
join ingestion.input_asset input on input.tenant_id=candidate.tenant_id and input.project_id=candidate.project_id
  and input.ingestion_id=batch.ingestion_id and input.asset_id=candidate.asset_id
join catalog.asset asset on asset.tenant_id=candidate.tenant_id and asset.project_id=candidate.project_id
  and asset.asset_id=candidate.asset_id
join catalog.content_blob blob on blob.tenant_id=asset.tenant_id and blob.project_id=asset.project_id
  and blob.content_blob_id=asset.content_blob_id
where batch.processing_batch_id=$1::uuid and batch.ingestion_id=$2::uuid and batch.review_hash=decode($3,'hex')
  and candidate.asset_id=$4::uuid and batch.status<>'PENDING' and candidate.status not in ('PENDING','RESTRICTED')
  and asset.lifecycle_state='FINGERPRINTED' and asset.version_id is null
  and input.scan_status='CLEAN' and input.fingerprint=candidate.source_hash
  and asset.content_hash=candidate.source_hash and blob.content_hash=candidate.source_hash
  and asset.byte_size=blob.byte_size and asset.byte_size between 1 and 33554432
  and security.authorized_row(asset.tenant_id,asset.project_id,asset.security_level,asset.policy_version)
  and security.authorized_row(blob.tenant_id,blob.project_id,blob.security_level,blob.policy_version)
for key share of asset
`;
const AUDIT_SQL = `/* data.candidate-original.audit */
insert into security.audit_event(tenant_id,project_id,actor_id,action,resource_type,resource_id,
  decision,purpose,context,security_level,policy_version,row_version)
values($1::uuid,$2::uuid,$3::uuid,'data.ingestion.candidate.original.read','ingestion-candidate',$4,
  'ALLOWED',$5,jsonb_build_object('traceId',$6::text,'assetId',$7::text,'processingBatchId',$8::text,'reviewHash',$9::text,
    'actorType',$12::text,'delegatedBy',$13::text),$10,$11::bigint,1)
`;
function safeError(code: 'NOT_FOUND' | 'UNAVAILABLE') {
  return Object.assign(new Error('Pending original access is unavailable.'), {
    code,
  });
}

export class PostgresCandidateOriginalPort implements CandidateOriginalPort {
  constructor(
    private readonly pool: AssetDownloadPool,
    private readonly store: Pick<
      S3AuthorityObjectStore,
      'planCandidateDownload'
    >,
    private readonly ttlSeconds = 60,
  ) {}

  private async run(input: CandidateOriginalInput, sign: boolean) {
    const reference = IngestionCandidateReferenceSchema.safeParse(
      input.reference,
    );
    if (
      !reference.success ||
      !PlatformUuidSchema.safeParse(input.assetId).success
    )
      throw safeError('NOT_FOUND');
    let client: Awaited<ReturnType<AssetDownloadPool['connect']>>;
    try {
      client = await this.pool.connect();
    } catch {
      throw safeError('UNAVAILABLE');
    }
    try {
      await client.query('BEGIN');
      const authorization = input.context.authorization;
      await client.query(SCOPE_SQL, [
        authorization.tenantId,
        authorization.projectId,
        authorization.maxSecurityLevel,
        String(authorization.authzVersion),
        reference.data.ingestionId,
        reference.data.processingBatchId,
        reference.data.reviewHash,
        input.assetId,
      ]);
      await applyResourceReadScope(client, authorization, 'original.read');
      await setCandidateReadAuthority(client, input.context);
      const result = await client.query(LOOKUP_SQL, [
        reference.data.processingBatchId,
        reference.data.ingestionId,
        reference.data.reviewHash,
        input.assetId,
      ]);
      const row = result.rows[0];
      const hash = row?.['source_hash'];
      const sizeBytes = Number(row?.['byte_size']);
      const mediaType = row?.['media_type'];
      const key = row?.['storage_key'];
      const prefix = `tenants/${authorization.tenantId}/projects/${authorization.projectId}/quarantine/`;
      const uploadId =
        typeof key === 'string' &&
        key.startsWith(prefix) &&
        key.endsWith('/object')
          ? key.slice(prefix.length, -7)
          : null;
      if (
        result.rows.length !== 1 ||
        typeof hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        hash !== row?.['content_hash'] ||
        hash !== row?.['blob_hash'] ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > MAX_CANDIDATE_ORIGINAL_BYTES ||
        typeof mediaType !== 'string' ||
        mediaType.length > 255 ||
        !uploadId ||
        !PlatformUuidSchema.safeParse(uploadId).success
      )
        throw safeError('NOT_FOUND');
      let download: CandidateOriginalDownload | undefined;
      if (sign) {
        const signed = await this.store.planCandidateDownload({
          tenantId: authorization.tenantId,
          projectId: authorization.projectId,
          uploadId,
          sizeBytes,
          contentType: mediaType,
          sha256: hash,
          ttlSeconds: this.ttlSeconds,
        });
        await client.query(AUDIT_SQL, [
          authorization.tenantId,
          authorization.projectId,
          input.context.principal.actorId,
          reference.data.ingestionId,
          authorization.purpose,
          input.context.traceId,
          input.assetId,
          reference.data.processingBatchId,
          reference.data.reviewHash,
          row?.['security_level'],
          row?.['policy_version'],
          input.context.principal.actorType,
          input.context.principal.delegatedBy ?? null,
        ]);
        download = Object.freeze({
          url: signed.url,
          expiresAt: signed.expiresAt,
          sha256: hash,
          sizeBytes,
        });
      }
      await client.query('COMMIT');
      return download;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Preserve the sanitized outcome. */
      }
      if (
        error instanceof Error &&
        'code' in error &&
        ['NOT_FOUND', 'FORBIDDEN'].includes(String(error.code))
      )
        throw error;
      throw safeError('UNAVAILABLE');
    } finally {
      client.release();
    }
  }
  async createCandidateDownload(
    input: CandidateOriginalInput,
  ): Promise<CandidateOriginalDownload> {
    const result = await this.run(input, true);
    if (!result) throw safeError('UNAVAILABLE');
    return result;
  }
  async authorizeCandidateDownload(
    input: CandidateOriginalInput,
  ): Promise<void> {
    await this.run(input, false);
  }
}
