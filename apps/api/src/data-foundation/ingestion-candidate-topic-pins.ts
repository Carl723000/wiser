import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  candidateSavedReferenceKey,
  IngestionCandidateReferenceSchema,
  IngestionCandidateTopicRelationPinSchema,
  IngestionCandidateTopicRulePinSchema,
  type CreateIngestionCandidateTopicInput,
  type IngestionCandidateSavedReferences,
} from '@wiser/data-contracts';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutionContext,
} from './capability-handler.js';
import type { QueryAdapterPgClient } from './query-adapters.js';

type Spec = CreateIngestionCandidateTopicInput['viewSpec'];
type RecordPin = Spec['topic']['recordPins'][number];
type RelationPin = Spec['relationPins'][number];
export type CandidateTopicRelationAuthority = RelationPin & {
  dependencies: readonly {
    reference: RecordPin['reference'];
    assetId: string;
    recordId?: string;
    sourceHash: string;
  }[];
};

/** Host composition only. These providers must read current adopted/source authority,
 * never echo the request or substitute published assertion versions. */
export interface CandidateTopicPinAuthorities {
  loadRules(
    client: QueryAdapterPgClient,
    context: DataCapabilityExecutionContext,
    selection: Spec['topic'],
    // Lookup only: the provider must read the actual complete adopted set.
    // New rule availability must not replace still-applicable fixed versions.
    pins: readonly Spec['rulePins'][number][],
    /** Internal producer applicability; legacy host implementations may omit it. */
    period?: Spec['period'],
  ): Promise<readonly Spec['rulePins'][number][]>;
  loadRelations?(
    client: QueryAdapterPgClient,
    context: DataCapabilityExecutionContext,
    pins: readonly RelationPin[],
    references: IngestionCandidateSavedReferences,
  ): Promise<readonly CandidateTopicRelationAuthority[]>;
  sourceObjectKey?(
    client: QueryAdapterPgClient,
    context: DataCapabilityExecutionContext,
    pin: RecordPin,
  ): Promise<string | null>;
}

const RECORD_BYTES = 262_144;
const GEOMETRY_BYTES = 3_145_728;
const uuid = PlatformUuidSchema;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const assetRowSchema = z.object({
  ingestion_id: uuid,
  processing_batch_id: uuid,
  review_hash: sha256,
  tenant_id: uuid,
  project_id: uuid,
  asset_id: uuid,
  source_hash: sha256,
  parser_version: z.string().min(1).max(128),
});
const recordRowSchema = z.object({
  record_id: uuid,
  record_index: z.number().int().min(1).max(2_000_000),
  source_id: z.string().max(1024).nullable(),
  record_values_json: z.string(),
  source_crs: z.string().max(128).nullable(),
  geometry: z.string().nullable(),
  geometry_bytes: z.coerce.number().int().nonnegative().nullable(),
});
const relationSchema = IngestionCandidateTopicRelationPinSchema.extend({
  dependencies: z
    .array(
      z.strictObject({
        reference: IngestionCandidateReferenceSchema,
        assetId: uuid,
        recordId: uuid.optional(),
        sourceHash: sha256,
      }),
    )
    .min(1)
    .max(64),
});
const materialSql = `/* candidate.topic.material */
select batch.ingestion_id,batch.processing_batch_id,encode(batch.review_hash,'hex') as review_hash,
 batch.tenant_id,batch.project_id,batch.parser_version,asset.asset_id,encode(asset.source_hash,'hex') as source_hash,
 record.record_id,record.record_index,record.source_id,record.record_values::text as record_values_json,record.source_crs,
 octet_length(ST_AsGeoJSON(record.geom,15,0)) as geometry_bytes,
 case when octet_length(ST_AsGeoJSON(record.geom,15,0)) <= $8::integer then ST_AsGeoJSON(record.geom,15,0) end as geometry
from ingestion.candidate_batch batch
join ingestion.candidate_asset asset on asset.processing_batch_id=batch.processing_batch_id
 and asset.tenant_id=batch.tenant_id and asset.project_id=batch.project_id
join ingestion.input_asset input on input.ingestion_id=batch.ingestion_id and input.asset_id=asset.asset_id
left join ingestion.candidate_record record on record.processing_batch_id=asset.processing_batch_id
 and record.asset_id=asset.asset_id and record.tenant_id=asset.tenant_id and record.project_id=asset.project_id and record.record_id=$4::uuid
where batch.processing_batch_id=$1::uuid and batch.ingestion_id=$2::uuid and asset.asset_id=$3::uuid
 and encode(batch.review_hash,'hex')=$5 and batch.tenant_id=$6::uuid and batch.project_id=$7::uuid
 and batch.status<>'PENDING' and ($4::uuid is null or record.record_id is not null)`;
const unavailable = () => new DataCapabilityHandlerError('NOT_FOUND');
const assetKey = (pin: {
  reference: RecordPin['reference'];
  assetId: string;
}) =>
  `${candidateSavedReferenceKey(pin.reference)}:${pin.assetId.toLowerCase()}`;
const recordKey = (pin: RecordPin) =>
  `${assetKey(pin)}:${pin.recordId.toLowerCase()}`;

/** Sort keys, retain array order, and retain PostgreSQL JSON numeric tokens without
 * converting them to JavaScript doubles. Whitespace and string escape spelling
 * are insignificant; numeric token spelling from JSONB text is retained. */
function canonicalJsonText(text: string): string {
  let offset = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(text[offset] ?? '') && offset < text.length)
      offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') {
        offset += 2;
        continue;
      }
      if (text[offset++] === '"')
        return JSON.parse(text.slice(start, offset)) as string;
    }
    throw unavailable();
  };
  const value = (): string => {
    whitespace();
    if (text[offset] === '"') return JSON.stringify(string());
    if (text[offset] === '{') {
      offset++;
      whitespace();
      const entries = new Map<string, string>();
      if (text[offset] !== '}')
        for (;;) {
          whitespace();
          if (text[offset] !== '"') throw unavailable();
          const key = string();
          whitespace();
          if (text[offset++] !== ':' || entries.has(key)) throw unavailable();
          entries.set(key, value());
          whitespace();
          if (text[offset] !== ',') break;
          offset++;
        }
      if (text[offset++] !== '}') throw unavailable();
      return `{${[...entries]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => `${JSON.stringify(key)}:${child}`)
        .join(',')}}`;
    }
    if (text[offset] === '[') {
      offset++;
      whitespace();
      const entries: string[] = [];
      if (text[offset] !== ']')
        for (;;) {
          entries.push(value());
          whitespace();
          if (text[offset] !== ',') break;
          offset++;
        }
      if (text[offset++] !== ']') throw unavailable();
      return `[${entries.join(',')}]`;
    }
    const token =
      /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(offset),
      )?.[0];
    if (token === undefined) throw unavailable();
    offset += token.length;
    return token;
  };
  const result = value();
  whitespace();
  if (offset !== text.length) throw unavailable();
  return result;
}
function fingerprint(domain: string, material: object) {
  return createHash('sha256')
    .update(canonicalJsonText(JSON.stringify({ domain, ...material })))
    .digest('hex');
}
function identity(pin: RecordPin) {
  return {
    reference: {
      ...pin.reference,
      ingestionId: pin.reference.ingestionId.toLowerCase(),
      processingBatchId: pin.reference.processingBatchId.toLowerCase(),
    },
    assetId: pin.assetId.toLowerCase(),
    recordId: pin.recordId.toLowerCase(),
  };
}
/** These private fingerprints bind actual candidate content, not trust or approval. */
export function candidateTopicRecordFingerprint(
  pin: RecordPin,
  row: z.infer<typeof recordRowSchema>,
) {
  if (Buffer.byteLength(row.record_values_json, 'utf8') > RECORD_BYTES)
    throw unavailable();
  const valuesJson = canonicalJsonText(row.record_values_json);
  if (!valuesJson.startsWith('{')) throw unavailable();
  return fingerprint('wiser.candidate-topic.record.v1', {
    ...identity(pin),
    recordIndex: row.record_index,
    sourceId: row.source_id,
    valuesJson,
  });
}
export function candidateTopicGeometryFingerprint(
  pin: RecordPin,
  row: z.infer<typeof recordRowSchema>,
) {
  if (
    row.geometry === null ||
    row.geometry_bytes === null ||
    row.geometry_bytes > GEOMETRY_BYTES ||
    Buffer.byteLength(row.geometry, 'utf8') > GEOMETRY_BYTES
  )
    throw unavailable();
  return fingerprint('wiser.candidate-topic.geometry.v1', {
    ...identity(pin),
    sourceCrs: row.source_crs,
    geometry: JSON.parse(canonicalJsonText(row.geometry)) as unknown,
  });
}

export function assertCandidateTopicPinProviders(
  spec: Spec,
  authorities?: CandidateTopicPinAuthorities,
): asserts authorities is CandidateTopicPinAuthorities {
  if (
    typeof authorities?.loadRules !== 'function' ||
    (spec.relationPins.length > 0 &&
      typeof authorities.loadRelations !== 'function') ||
    (spec.topic.recordPins.some((pin) => pin.sourceObjectKey !== undefined) &&
      typeof authorities.sourceObjectKey !== 'function')
  )
    throw new DataCapabilityHandlerError('EXECUTION_FAILED');
}

/** Call only after the existing scope, manifest and page/focus anchor checks. */
export async function validateCandidateTopicMaterialPins(
  client: QueryAdapterPgClient,
  spec: Spec,
  context: DataCapabilityExecutionContext,
  authorities: CandidateTopicPinAuthorities,
  references: IngestionCandidateSavedReferences,
  assertCurrent: () => void,
): Promise<void> {
  for (const pin of spec.dependencyPins) {
    assertCurrent();
    const result = await client.query(materialSql, [
      pin.reference.processingBatchId,
      pin.reference.ingestionId,
      pin.assetId,
      pin.kind === 'asset' ? null : pin.recordId,
      pin.reference.reviewHash,
      context.authorization.tenantId,
      context.authorization.projectId,
      GEOMETRY_BYTES,
    ]);
    assertCurrent();
    if (result.rows.length !== 1) throw unavailable();
    const parsed = assetRowSchema.safeParse(result.rows[0]);
    if (!parsed.success) throw unavailable();
    const row = parsed.data;
    if (
      candidateSavedReferenceKey({
        kind: 'ingestion-candidate',
        ingestionId: row.ingestion_id,
        processingBatchId: row.processing_batch_id,
        reviewHash: row.review_hash,
      }) !== candidateSavedReferenceKey(pin.reference) ||
      row.asset_id.toLowerCase() !== pin.assetId.toLowerCase() ||
      row.tenant_id.toLowerCase() !==
        context.authorization.tenantId.toLowerCase() ||
      row.project_id.toLowerCase() !==
        context.authorization.projectId.toLowerCase() ||
      row.source_hash !== pin.sourceHash ||
      row.parser_version !== pin.parserVersion
    )
      throw unavailable();
    if (pin.kind !== 'asset') {
      const record = recordRowSchema.safeParse(result.rows[0]);
      if (
        !record.success ||
        record.data.record_id.toLowerCase() !== pin.recordId.toLowerCase()
      )
        throw unavailable();
      try {
        if (
          candidateTopicRecordFingerprint(pin, record.data) !==
            pin.recordHash ||
          (pin.kind === 'geometry' &&
            candidateTopicGeometryFingerprint(pin, record.data) !==
              pin.geometryHash)
        )
          throw unavailable();
      } catch {
        throw unavailable();
      }
    }
  }
  for (const pin of spec.topic.recordPins)
    if (pin.sourceObjectKey !== undefined) {
      assertCurrent();
      const actual = await authorities.sourceObjectKey!(
        client,
        context,
        structuredClone(pin),
      );
      assertCurrent();
      if (actual !== pin.sourceObjectKey) throw unavailable();
    }
  assertCurrent();
  const adopted = z
    .array(IngestionCandidateTopicRulePinSchema)
    .min(4)
    .max(32)
    .safeParse(
      await authorities.loadRules(
        client,
        context,
        structuredClone(spec.topic),
        structuredClone(spec.rulePins),
        structuredClone(spec.period),
      ),
    );
  assertCurrent();
  const ruleKey = (pin: Spec['rulePins'][number]) =>
    JSON.stringify([pin.kind, pin.ruleId, pin.version]);
  const expectedRules = new Set(spec.rulePins.map(ruleKey));
  if (
    !adopted.success ||
    adopted.data.length !== expectedRules.size ||
    new Set(adopted.data.map(ruleKey)).size !== adopted.data.length ||
    adopted.data.some((pin) => !expectedRules.has(ruleKey(pin)))
  )
    throw unavailable();
  if (spec.relationPins.length === 0) return;
  const actual = z
    .array(relationSchema)
    .max(100)
    .safeParse(
      await authorities.loadRelations!(
        client,
        context,
        structuredClone(spec.relationPins),
        structuredClone(references),
      ),
    );
  assertCurrent();
  const relationKey = (pin: RelationPin) =>
    `${pin.relationId.toLowerCase()}:${pin.revision}:${pin.decisionVersion}`;
  const expectedRelations = new Set(spec.relationPins.map(relationKey));
  const assetPins = new Map(
    spec.dependencyPins
      .filter((pin) => pin.kind === 'asset')
      .map((pin) => [assetKey(pin), pin]),
  );
  const records = new Set(spec.topic.recordPins.map(recordKey));
  if (
    !actual.success ||
    actual.data.length !== expectedRelations.size ||
    new Set(actual.data.map(relationKey)).size !== actual.data.length ||
    actual.data.some(
      (relation) =>
        !expectedRelations.has(relationKey(relation)) ||
        relation.dependencies.some(
          (pin) =>
            assetPins.get(assetKey(pin))?.sourceHash !== pin.sourceHash ||
            (pin.recordId !== undefined &&
              !records.has(recordKey({ ...pin, recordId: pin.recordId }))),
        ),
    )
  )
    throw unavailable();
}
