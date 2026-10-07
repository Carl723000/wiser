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
import {
  CandidateOriginalOutcomeSchema,
  type CandidateOriginalOutcome,
} from './candidate-original-outcomes.js';

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
  /** Opaque in-process receipt. Never serialized to clients or accepted from JSON. */
  readonly outcomeReceipt: object;
}
export interface CandidateOriginalPort {
  createCandidateDownload(
    input: CandidateOriginalInput,
  ): Promise<CandidateOriginalDownload>;
  authorizeCandidateDownload(input: CandidateOriginalInput): Promise<void>;
  appendCandidateOriginalOutcome(
    outcomeReceipt: object,
    outcome: CandidateOriginalOutcome,
  ): Promise<void>;
}

const SCOPE_SQL = `/* data.candidate-original.scope */
select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),
  set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),
  set_config('wiser.candidate_original_ingestion',$5,true),
  set_config('wiser.candidate_original_batch',$6,true),
  set_config('wiser.candidate_original_review_hash',$7,true),
  set_config('wiser.candidate_original_asset',$8,true),
  set_config('statement_timeout','10000',true)
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
const OUTCOME_SCOPE_SQL = `/* data.candidate-original.outcome-scope */
select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),
  set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),
  set_config('statement_timeout','10000',true)
`;
const OUTCOME_SQL = `/* data.candidate-original.outcome */
insert into security.audit_event(tenant_id,project_id,event_id,actor_id,action,resource_type,resource_id,
  decision,purpose,context,security_level,policy_version,row_version)
values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'data.ingestion.candidate.original.output','ingestion-candidate',$5,
  $6,$7,$8::jsonb,$9,$10::bigint,1)
`;
interface OriginalOutcomeReceipt {
  readonly binding: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly maxSecurityLevel: string;
    readonly authzVersion: number;
    readonly purpose: string;
    readonly traceId: string;
    readonly actorId: string;
    readonly actorType: string;
    readonly delegatedBy: string | null;
    readonly reference: IngestionCandidateReference;
    readonly assetId: string;
  };
  readonly sizeBytes: number;
  readonly securityLevel: unknown;
  readonly policyVersion: unknown;
  outcome?: CandidateOriginalOutcome;
  append?: Promise<void>;
}
function safeError(code: 'NOT_FOUND' | 'UNAVAILABLE') {
  return Object.assign(new Error('Pending original access is unavailable.'), {
    code,
  });
}

export class PostgresCandidateOriginalPort implements CandidateOriginalPort {
  private readonly receipts = new WeakMap<object, OriginalOutcomeReceipt>();
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
      await setCandidateReadAuthority(client, input.context, [reference.data]);
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
        download = Object.freeze(
          Object.defineProperty(
            {
              url: signed.url,
              expiresAt: signed.expiresAt,
              sha256: hash,
              sizeBytes,
            },
            'outcomeReceipt',
            { value: Object.freeze({}), enumerable: false },
          ),
        ) as CandidateOriginalDownload;
      }
      await client.query('COMMIT');
      if (download)
        this.receipts.set(download.outcomeReceipt, {
          binding: Object.freeze({
            tenantId: authorization.tenantId,
            projectId: authorization.projectId,
            maxSecurityLevel: authorization.maxSecurityLevel,
            authzVersion: authorization.authzVersion,
            purpose: authorization.purpose,
            traceId: input.context.traceId,
            actorId: input.context.principal.actorId,
            actorType: input.context.principal.actorType,
            delegatedBy: input.context.principal.delegatedBy ?? null,
            reference: Object.freeze({ ...reference.data }),
            assetId: input.assetId,
          }),
          sizeBytes: download.sizeBytes,
          securityLevel: row?.['security_level'],
          policyVersion: row?.['policy_version'],
        });
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
    // Fix signing responsibility before asynchronous store/SQL calls.
    const result = await this.run(
      { ...input, context: structuredClone(input.context) },
      true,
    );
    if (!result) throw safeError('UNAVAILABLE');
    return result;
  }
  async authorizeCandidateDownload(
    input: CandidateOriginalInput,
  ): Promise<void> {
    await this.run(input, false);
  }
  async appendCandidateOriginalOutcome(
    outcomeReceipt: object,
    value: CandidateOriginalOutcome,
  ): Promise<void> {
    const outcome = CandidateOriginalOutcomeSchema.safeParse(value);
    const receipt = this.receipts.get(outcomeReceipt);
    if (
      !outcome.success ||
      !receipt ||
      outcome.data.originalBytes !== receipt.sizeBytes
    )
      throw safeError('UNAVAILABLE');
    if (receipt.append) {
      if (JSON.stringify(receipt.outcome) !== JSON.stringify(outcome.data))
        throw safeError('UNAVAILABLE');
      return receipt.append;
    }
    receipt.outcome = outcome.data;
    receipt.append = this.appendOutcome(receipt, outcome.data);
    return receipt.append;
  }

  private async appendOutcome(
    receipt: OriginalOutcomeReceipt,
    outcome: CandidateOriginalOutcome,
  ): Promise<void> {
    let client: Awaited<ReturnType<AssetDownloadPool['connect']>>;
    try {
      client = await this.pool.connect();
    } catch {
      throw safeError('UNAVAILABLE');
    }
    try {
      const binding = receipt.binding;
      const { reference, assetId } = binding;
      await client.query('BEGIN');
      // Historical output metadata only. Do not rerun or elevate original access.
      await client.query(OUTCOME_SCOPE_SQL, [
        binding.tenantId,
        binding.projectId,
        binding.maxSecurityLevel,
        String(binding.authzVersion),
      ]);
      await client.query(OUTCOME_SQL, [
        binding.tenantId,
        binding.projectId,
        outcome.attemptId,
        binding.actorId,
        reference.ingestionId,
        outcome.terminal,
        binding.purpose,
        JSON.stringify({
          ...outcome,
          traceId: binding.traceId,
          assetId,
          processingBatchId: reference.processingBatchId,
          reviewHash: reference.reviewHash,
          actorType: binding.actorType,
          delegatedBy: binding.delegatedBy,
          byteMeaning: 'offered-to-api-response-stream',
        }),
        receipt.securityLevel,
        receipt.policyVersion,
      ]);
      await client.query('COMMIT');
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Preserve the failed append. */
      }
      throw safeError('UNAVAILABLE');
    } finally {
      client.release();
    }
  }
}
