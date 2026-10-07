import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  candidateSavedReferenceKey,
  CreateIngestionCandidateTopicInputSchema,
  CreateIngestionCandidateTopicOutputSchema,
  IngestionCandidateTopicSavedViewSchema,
  IngestionCandidateTopicSpecSchema,
  ListIngestionCandidateTopicsInputSchema,
  ListIngestionCandidateTopicsOutputSchema,
  OpenIngestionCandidateTopicInputSchema,
  OpenIngestionCandidateTopicOutputSchema,
  CreateIngestionCandidateViewInputSchema,
  CreateIngestionCandidateViewOutputSchema,
  ListIngestionCandidateViewsInputSchema,
  ListIngestionCandidateViewsOutputSchema,
  OpenIngestionCandidateViewInputSchema,
  OpenIngestionCandidateViewOutputSchema,
  RevokeIngestionCandidateViewInputSchema,
  IngestionCandidateSavedReferencesSchema,
  IngestionCandidateSavedViewSpecSchema,
  IngestionCandidateSavedViewSchema,
  type IngestionCandidateSavedReferences,
  type IngestionCandidateSavedViewSpec,
} from '@wiser/data-contracts';
import {
  CommandTransactions,
  PostgresDataCommandError,
  type PostgresDataCommandPool,
} from './postgres-command-executors.js';
import {
  candidateReadAuthority,
  setCandidateReadAuthority,
} from './candidate-read-authority.js';
import {
  canReadPendingSubmission,
  ownsPendingSubmission,
  rowSubmissionResponsibility,
} from './managed-ingestion-access.js';
import { applyResourceReadScope } from './resource-read-scope.js';
import {
  encodeCandidateContinuation,
  candidateSavedListCursor,
  candidateTopicListCursor,
} from './postgres-read-executors.js';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutor,
  type DataCapabilityExecutionContext,
} from './capability-handler.js';
import type {
  QueryAdapterPgClient,
  QueryAdapterPgPool,
} from './query-adapters.js';
import {
  assertCandidateTopicPinProviders,
  validateCandidateTopicMaterialPins,
  type CandidateTopicPinAuthorities,
} from './ingestion-candidate-topic-pins.js';

const savedSchema = z.object({
  view_id: z.uuid(),
  tenant_id: z.uuid(),
  project_id: z.uuid(),
  actor_id: z.uuid(),
  actor_type: z.enum(['human', 'agent', 'service']),
  delegated_by: z.uuid().nullable(),
  purpose: z.string(),
  title: z.string(),
  visibility: z.enum(['private', 'project']),
  candidate_refs: IngestionCandidateSavedReferencesSchema,
  view_spec: IngestionCandidateSavedViewSpecSchema,
  created_at: z.coerce.date(),
  revoked_at: z.coerce.date().nullable(),
});
type Saved = z.infer<typeof savedSchema>;
const versionedSavedSchema = savedSchema.extend({
  view_spec: z.union([
    IngestionCandidateSavedViewSpecSchema,
    IngestionCandidateTopicSpecSchema,
  ]),
});
type VersionedSaved = z.infer<typeof versionedSavedSchema>;
const scopeSql = `/* candidate.saved.scope */ select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true),set_config('wiser.purpose',$5,true),set_config('wiser.candidate_view_deadline',$6,true)`;
const referenceSql = `/* candidate.saved.references */
select batch.ingestion_id,batch.processing_batch_id,encode(batch.review_hash,'hex') as review_hash,batch.security_level,
 session.submitted_by_actor_id,session.submitted_actor_type,session.submitted_delegator_actor_id
from jsonb_array_elements($1::jsonb) ref
join ingestion.candidate_batch batch on batch.ingestion_id=(ref->>'ingestionId')::uuid
 and batch.processing_batch_id=(ref->>'processingBatchId')::uuid and encode(batch.review_hash,'hex')=ref->>'reviewHash'
join ingestion.session session on session.ingestion_id=batch.ingestion_id and session.tenant_id=batch.tenant_id and session.project_id=batch.project_id
where batch.status<>'PENDING'`;
function assertAuthority(context: DataCapabilityExecutionContext) {
  if (context.signal.aborted)
    throw new DataCapabilityHandlerError('CAPABILITY_TIMEOUT');
  const authority = candidateReadAuthority(context);
  if (!authority.maintainer && !authority.reviewer)
    throw new DataCapabilityHandlerError('FORBIDDEN');
  return authority;
}
async function scope(
  client: QueryAdapterPgClient,
  context: DataCapabilityExecutionContext,
  references: IngestionCandidateSavedReferences | readonly [] = [],
) {
  assertAuthority(context);
  const deadlines = [
    context.principal.expiresAt,
    context.authorization.resourceAccess?.scope.mode === 'managed'
      ? context.authorization.resourceAccess.scope.validUntil
      : null,
  ].filter((v): v is string => Boolean(v));
  const deadline = deadlines.length
    ? new Date(Math.min(...deadlines.map(Date.parse))).toISOString()
    : 'infinity';
  await client.query(scopeSql, [
    context.authorization.tenantId,
    context.authorization.projectId,
    context.effectiveMaxSecurityLevel,
    String(context.authorization.authzVersion),
    context.authorization.purpose,
    deadline,
  ]);
  await applyResourceReadScope(
    client,
    context.authorization,
    context.resourceReadAction,
  );
  await setCandidateReadAuthority(client, context, references);
}
function metadata(
  row: Pick<
    Saved,
    'view_id' | 'title' | 'visibility' | 'created_at' | 'revoked_at'
  >,
) {
  return IngestionCandidateSavedViewSchema.parse({
    kind: 'ingestion-candidate-view',
    viewId: row.view_id,
    title: row.title,
    visibility: row.visibility,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  });
}
function isOwner(
  row: Pick<Saved, 'actor_id' | 'actor_type' | 'delegated_by'>,
  context: DataCapabilityExecutionContext,
) {
  return ownsPendingSubmission(context, {
    actorId: row.actor_id,
    actorType: row.actor_type,
    ...(row.delegated_by ? { delegatedBy: row.delegated_by } : {}),
  });
}
async function manifest(
  client: QueryAdapterPgClient,
  refs: IngestionCandidateSavedReferences,
  context: DataCapabilityExecutionContext,
) {
  const authority = assertAuthority(context),
    expected = new Set(refs.map(candidateSavedReferenceKey));
  const result = await client.query(referenceSql, [JSON.stringify(refs)]);
  if (result.rows.length !== refs.length)
    throw new DataCapabilityHandlerError('NOT_FOUND');
  const seen = new Set<string>();
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
      !canReadPendingSubmission(
        context,
        rowSubmissionResponsibility(row),
        authority,
      )
    )
      throw new DataCapabilityHandlerError('NOT_FOUND');
    seen.add(key);
  }
}
async function anchor(
  client: QueryAdapterPgClient,
  ref: IngestionCandidateSavedReferences[number],
  assetId: string,
  recordId?: string,
  geometry = false,
) {
  const result = await client.query(
    `/* candidate.saved.anchor */ select input.ordinal,record.record_index,(record.geom is not null) as has_geometry
from ingestion.candidate_asset asset join ingestion.input_asset input on input.asset_id=asset.asset_id and input.ingestion_id=$2::uuid
left join ingestion.candidate_record record on record.processing_batch_id=asset.processing_batch_id and record.asset_id=asset.asset_id and record.record_id=$4::uuid
where asset.processing_batch_id=$1::uuid and asset.asset_id=$3::uuid and ($4::uuid is null or record.record_id is not null)
 and (not $5::boolean or record.geom is not null)`,
    [
      ref.processingBatchId,
      ref.ingestionId,
      assetId,
      recordId ?? null,
      geometry,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new DataCapabilityHandlerError('NOT_FOUND');
  return row;
}
async function validateView(
  client: QueryAdapterPgClient,
  view: IngestionCandidateSavedViewSpec,
) {
  const page = view.page;
  let position: readonly (number | string)[] | undefined;
  if (page.kind === 'assets') {
    if (page.afterAssetId) {
      const row = await anchor(client, page.reference, page.afterAssetId);
      position = [
        z.coerce.number().int().nonnegative().parse(row['ordinal']),
        page.afterAssetId.toLowerCase(),
      ];
    }
  } else {
    const row = await anchor(
      client,
      page.reference,
      page.assetId,
      page.afterRecordId,
      page.kind === 'geometry' && page.afterRecordId !== undefined,
    );
    if (page.afterRecordId)
      position = [
        z.coerce
          .number()
          .int()
          .min(1)
          .max(2_000_000)
          .parse(row['record_index']),
      ];
  }
  if (view.focus)
    await anchor(
      client,
      view.focus.reference,
      view.focus.assetId,
      view.focus.recordId,
    );
  return position;
}
/** Same-transaction authority validation for complete v2 topic saves and restores.
 * The host supplies actual rule/relation authority; no request-echo fallback exists. */
export async function validateIngestionCandidateTopicPins(
  client: QueryAdapterPgClient,
  raw: unknown,
  context: DataCapabilityExecutionContext,
  authorities?: CandidateTopicPinAuthorities,
) {
  const input = CreateIngestionCandidateTopicInputSchema.parse(raw);
  assertAuthority(context);
  assertCandidateTopicPinProviders(input.viewSpec, authorities);
  await scope(client, context, input.references);
  await manifest(client, input.references, context);
  await validateView(client, {
    page: input.viewSpec.page,
    ...(input.viewSpec.focus ? { focus: input.viewSpec.focus } : {}),
    ...(input.viewSpec.map ? { map: input.viewSpec.map } : {}),
  });
  await validateCandidateTopicMaterialPins(
    client,
    input.viewSpec,
    context,
    authorities,
    input.references,
    () => {
      assertAuthority(context);
    },
  );
  // Reapply only the parsed fixed selection before the post-provider RLS check.
  await scope(client, context, input.references);
  // Recheck every manifest member after asynchronous authority providers.
  await manifest(client, input.references, context);
  assertAuthority(context);
  return input;
}
function pageRequest(
  view: IngestionCandidateSavedViewSpec,
  context: DataCapabilityExecutionContext,
  position?: readonly (number | string)[],
) {
  const page = view.page,
    capabilityId =
      page.kind === 'assets'
        ? ('data.ingestion.candidate.get' as const)
        : page.kind === 'records'
          ? ('data.ingestion.candidate.records' as const)
          : ('data.ingestion.candidate.geometry' as const);
  const input = {
    ...page.reference,
    first: page.first,
    ...(page.kind !== 'assets' ? { assetId: page.assetId } : {}),
  };
  return {
    capabilityId,
    input: {
      ...input,
      ...(position
        ? {
            after: encodeCandidateContinuation(
              capabilityId,
              context,
              input,
              position,
            ),
          }
        : {}),
    },
  };
}
async function readSaved(
  client: QueryAdapterPgClient,
  id: string,
  context: DataCapabilityExecutionContext,
  owned = false,
  includeRevoked = false,
  legacyOnly = false,
) {
  const result = await client.query(
    '/* candidate.saved.get */ select * from service.ingestion_candidate_saved_view where view_id=$1::uuid',
    [id],
  );
  const stored = result.rows[0];
  if (!stored) throw new DataCapabilityHandlerError('NOT_FOUND');
  if (
    legacyOnly &&
    typeof stored['view_spec'] === 'object' &&
    stored['view_spec'] !== null &&
    Object.hasOwn(stored['view_spec'], 'schemaVersion')
  )
    throw new DataCapabilityHandlerError('NOT_FOUND');
  const row = savedSchema.parse(stored);
  if (
    row.tenant_id !== context.authorization.tenantId ||
    row.project_id !== context.authorization.projectId ||
    row.purpose !== context.authorization.purpose ||
    (!includeRevoked && row.revoked_at !== null) ||
    ((owned || row.visibility === 'private') && !isOwner(row, context))
  )
    throw new DataCapabilityHandlerError('NOT_FOUND');
  // Only a row already visible under saved-view RLS supplies this selection.
  // Hidden historical rows remain NOT_FOUND; this does not enumerate them.
  await scope(client, context, row.candidate_refs);
  await manifest(client, row.candidate_refs, context);
  return row;
}

function specVersion(row: VersionedSaved): 1 | 2 {
  return 'schemaVersion' in row.view_spec ? 2 : 1;
}
function topicMetadata(row: VersionedSaved) {
  return IngestionCandidateTopicSavedViewSchema.parse({
    ...metadata(row),
    specVersion: specVersion(row),
  });
}
async function readVersionedSaved(
  client: QueryAdapterPgClient,
  id: string,
  context: DataCapabilityExecutionContext,
  owned = false,
  includeRevoked = false,
): Promise<VersionedSaved> {
  // 0046 authorizes historical v2 rows from this exact saved manifest before
  // returning any columns. Neither this query nor a saved pin grants source access.
  const result = await client.query(
    '/* candidate.saved.get */ select * from service.ingestion_candidate_saved_view where view_id=$1::uuid',
    [id],
  );
  const stored = result.rows[0];
  if (!stored) throw new DataCapabilityHandlerError('NOT_FOUND');
  const row = versionedSavedSchema.parse(stored);
  if (
    row.tenant_id !== context.authorization.tenantId ||
    row.project_id !== context.authorization.projectId ||
    row.purpose !== context.authorization.purpose ||
    (!includeRevoked && row.revoked_at !== null) ||
    ((owned || row.visibility === 'private') && !isOwner(row, context))
  )
    throw new DataCapabilityHandlerError('NOT_FOUND');
  await scope(client, context, row.candidate_refs);
  await manifest(client, row.candidate_refs, context);
  return row;
}
async function validateVersionedSaved(
  client: QueryAdapterPgClient,
  row: VersionedSaved,
  context: DataCapabilityExecutionContext,
  authorities?: CandidateTopicPinAuthorities,
) {
  if ('schemaVersion' in row.view_spec) {
    await validateIngestionCandidateTopicPins(
      client,
      {
        title: row.title,
        visibility: row.visibility,
        references: row.candidate_refs,
        viewSpec: row.view_spec,
      },
      context,
      authorities,
    );
    return validateView(client, {
      page: row.view_spec.page,
      ...(row.view_spec.focus ? { focus: row.view_spec.focus } : {}),
      ...(row.view_spec.map ? { map: row.view_spec.map } : {}),
    });
  }
  return validateView(client, row.view_spec);
}
async function unavailableTopicReceipt(
  client: QueryAdapterPgClient,
  id: string,
  context: DataCapabilityExecutionContext,
) {
  assertAuthority(context);
  // Existing NOLOGIN/NOINHERIT/NOBYPASSRLS role; 0046 grants SELECT(view_id)
  // only. Its dedicated RLS admits the current original saver of a live v2 row.
  // This is the final read in this transaction; COMMIT/ROLLBACK clears LOCAL ROLE.
  await client.query(
    `/* candidate.topic.receipt.scope */ select set_config('wiser.candidate_topic_receipt_id',$1,true)`,
    [id.toLowerCase()],
  );
  await client.query('set local role wiser_data_metadata');
  const result = await client.query(
    '/* candidate.topic.receipt */ select view_id from service.ingestion_candidate_saved_view where view_id=$1::uuid',
    [id],
  );
  const receipt = z
    .strictObject({ view_id: z.uuid() })
    .safeParse(result.rows[0]);
  if (
    !receipt.success ||
    receipt.data.view_id.toLowerCase() !== id.toLowerCase()
  )
    throw new DataCapabilityHandlerError('NOT_FOUND');
  assertAuthority(context);
  return OpenIngestionCandidateTopicOutputSchema.parse({
    status: 'UNAVAILABLE',
    viewId: id,
  });
}

async function commandErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof DataCapabilityHandlerError)
      throw new PostgresDataCommandError(
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'STATE_CONFLICT'
            : 'INVALID_INPUT',
      );
    throw error;
  }
}

export function createIngestionCandidateSavedExecutors(
  pool: QueryAdapterPgPool & PostgresDataCommandPool,
  authorities?: CandidateTopicPinAuthorities,
): readonly DataCapabilityExecutor[] {
  const transactions = new CommandTransactions(
    pool,
    randomUUID,
    () => new Date(),
  );
  async function read<T>(
    context: DataCapabilityExecutionContext,
    action: (client: QueryAdapterPgClient) => Promise<T>,
  ): Promise<T> {
    assertAuthority(context);
    const client = await pool.connect();
    try {
      await client.query('begin isolation level repeatable read');
      await scope(client, context);
      const result = await action(client);
      assertAuthority(context);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (error instanceof DataCapabilityHandlerError) throw error;
      throw new DataCapabilityHandlerError('EXECUTION_FAILED');
    } finally {
      client.release();
    }
  }
  return [
    {
      id: 'data.ingestion.candidate.topic.create',
      async execute(raw, context) {
        const input = CreateIngestionCandidateTopicInputSchema.parse(raw);
        assertAuthority(context);
        assertCandidateTopicPinProviders(input.viewSpec, authorities);
        return transactions.run(
          'data.ingestion.candidate.topic.create',
          input,
          context,
          (client, timestamp) =>
            commandErrors(async () => {
              await validateIngestionCandidateTopicPins(
                client,
                input,
                context,
                authorities,
              );
              const id = randomUUID();
              const result = await client.query(
                `/* candidate.saved.insert */ insert into service.ingestion_candidate_saved_view(view_id,tenant_id,project_id,actor_id,actor_type,delegated_by,purpose,security_level,policy_version,title,visibility,candidate_refs,view_spec,created_at)
values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::timestamptz) returning *`,
                [
                  id,
                  context.authorization.tenantId,
                  context.authorization.projectId,
                  context.principal.actorId,
                  context.principal.actorType,
                  context.principal.delegatedBy ?? null,
                  context.authorization.purpose,
                  context.effectiveMaxSecurityLevel,
                  context.authorization.authzVersion,
                  input.title,
                  input.visibility,
                  JSON.stringify(input.references),
                  JSON.stringify(input.viewSpec),
                  timestamp,
                ],
              );
              const output = CreateIngestionCandidateTopicOutputSchema.parse({
                savedView: topicMetadata(
                  versionedSavedSchema.parse(result.rows[0]),
                ),
              });
              assertAuthority(context);
              return {
                output,
                replayResult: output,
                aggregateId: id,
                eventType: 'data.ingestion-candidate-topic.created',
                securityLevel: context.effectiveMaxSecurityLevel,
              };
            }),
          (client, _timestamp, ledger) =>
            commandErrors(async () => {
              await scope(client, context);
              const previous = CreateIngestionCandidateTopicOutputSchema.parse(
                ledger.result,
              );
              const row = await readVersionedSaved(
                client,
                previous.savedView.viewId,
                context,
                true,
              );
              if (specVersion(row) !== 2)
                throw new DataCapabilityHandlerError('NOT_FOUND');
              await validateVersionedSaved(client, row, context, authorities);
              assertAuthority(context);
              return CreateIngestionCandidateTopicOutputSchema.parse({
                savedView: topicMetadata(row),
              });
            }),
        );
      },
    },
    {
      id: 'data.ingestion.candidate.topic.list',
      async execute(raw, context) {
        const input = ListIngestionCandidateTopicsInputSchema.parse(raw);
        let cursor: readonly (number | string)[] | undefined;
        try {
          const decoded = candidateTopicListCursor(context, input);
          if (
            decoded !== undefined &&
            (!Array.isArray(decoded) ||
              decoded.length !== 2 ||
              typeof decoded[0] !== 'string' ||
              !Number.isFinite(Date.parse(decoded[0])) ||
              !z.uuid().safeParse(decoded[1]).success)
          )
            throw Error();
          cursor = decoded as typeof cursor;
        } catch {
          throw new DataCapabilityHandlerError('VALIDATION_FAILED');
        }
        return read(context, async (client) => {
          const result = await client.query(
            `/* candidate.topic.list */ select * from service.ingestion_candidate_saved_view where revoked_at is null and ($2::timestamptz is null or (created_at,view_id)<($2::timestamptz,$3::uuid)) order by created_at desc,view_id desc limit $1`,
            [input.first + 1, cursor?.[0] ?? null, cursor?.[1] ?? null],
          );
          const rows = result.rows
            .slice(0, input.first)
            .map((row) => versionedSavedSchema.parse(row));
          const items: ReturnType<typeof topicMetadata>[] = [];
          for (const row of rows) {
            if (
              row.revoked_at !== null ||
              row.purpose !== context.authorization.purpose ||
              row.tenant_id !== context.authorization.tenantId ||
              row.project_id !== context.authorization.projectId ||
              (row.visibility === 'private' && !isOwner(row, context))
            )
              throw new DataCapabilityHandlerError('NOT_FOUND');
            await scope(client, context, row.candidate_refs);
            await manifest(client, row.candidate_refs, context);
            await validateVersionedSaved(client, row, context, authorities);
            items.push(topicMetadata(row));
            // A late authority/pin loss rejects the whole page. A continuation
            // must never encode the ID of a row hidden by a post-query check.
          }
          const last = rows.at(-1);
          return ListIngestionCandidateTopicsOutputSchema.parse({
            items,
            nextCursor:
              result.rows.length > input.first && last
                ? candidateTopicListCursor(context, input, [
                    last.created_at.toISOString(),
                    last.view_id,
                  ])
                : null,
          });
        });
      },
    },
    {
      id: 'data.ingestion.candidate.topic.open',
      async execute(raw, context) {
        const input = OpenIngestionCandidateTopicInputSchema.parse(raw);
        return read(context, async (client) => {
          try {
            const row = await readVersionedSaved(client, input.viewId, context);
            const position = await validateVersionedSaved(
              client,
              row,
              context,
              authorities,
            );
            return OpenIngestionCandidateTopicOutputSchema.parse({
              status: 'READABLE',
              specVersion: specVersion(row),
              savedView: topicMetadata(row),
              references: row.candidate_refs,
              viewSpec: row.view_spec,
              request: pageRequest(
                { page: row.view_spec.page },
                context,
                position,
              ),
            });
          } catch (error) {
            if (
              !(error instanceof DataCapabilityHandlerError) ||
              error.code !== 'NOT_FOUND'
            )
              throw error;
            return unavailableTopicReceipt(client, input.viewId, context);
          }
        });
      },
    },
    {
      id: 'data.ingestion.candidate.view.create',
      async execute(raw, context) {
        const input = CreateIngestionCandidateViewInputSchema.parse(raw);
        assertAuthority(context);
        return transactions.run(
          'data.ingestion.candidate.view.create',
          input,
          context,
          (client, timestamp) =>
            commandErrors(async () => {
              await scope(client, context, input.references);
              await manifest(client, input.references, context);
              await validateView(client, input.viewSpec);
              const id = randomUUID();
              const result = await client.query(
                `/* candidate.saved.insert */ insert into service.ingestion_candidate_saved_view(view_id,tenant_id,project_id,actor_id,actor_type,delegated_by,purpose,security_level,policy_version,title,visibility,candidate_refs,view_spec,created_at)
values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::timestamptz) returning *`,
                [
                  id,
                  context.authorization.tenantId,
                  context.authorization.projectId,
                  context.principal.actorId,
                  context.principal.actorType,
                  context.principal.delegatedBy ?? null,
                  context.authorization.purpose,
                  context.effectiveMaxSecurityLevel,
                  context.authorization.authzVersion,
                  input.title,
                  input.visibility,
                  JSON.stringify(input.references),
                  JSON.stringify(input.viewSpec),
                  timestamp,
                ],
              );
              const output = CreateIngestionCandidateViewOutputSchema.parse({
                savedView: metadata(savedSchema.parse(result.rows[0])),
              });
              assertAuthority(context);
              return {
                output,
                replayResult: output,
                aggregateId: id,
                eventType: 'data.ingestion-candidate-view.created',
                securityLevel: context.effectiveMaxSecurityLevel,
              };
            }),
          (client, _timestamp, ledger) =>
            commandErrors(async () => {
              await scope(client, context);
              const previous = CreateIngestionCandidateViewOutputSchema.parse(
                ledger.result,
              );
              const row = await readSaved(
                client,
                previous.savedView.viewId,
                context,
                true,
              );
              await validateView(client, row.view_spec);
              assertAuthority(context);
              return { savedView: metadata(row) };
            }),
        );
      },
    },
    {
      id: 'data.ingestion.candidate.view.list',
      async execute(raw, context) {
        const input = ListIngestionCandidateViewsInputSchema.parse(raw);
        let cursor: readonly (number | string)[] | undefined;
        try {
          const decoded = candidateSavedListCursor(context, input);
          if (
            decoded !== undefined &&
            (!Array.isArray(decoded) ||
              decoded.length !== 2 ||
              typeof decoded[0] !== 'string' ||
              !Number.isFinite(Date.parse(decoded[0])) ||
              !z.uuid().safeParse(decoded[1]).success)
          )
            throw Error();
          cursor = decoded as typeof cursor;
        } catch {
          throw new DataCapabilityHandlerError('VALIDATION_FAILED');
        }
        return read(context, async (client) => {
          const result = await client.query(
            `/* candidate.saved.list */ select * from service.ingestion_candidate_saved_view where revoked_at is null and not (view_spec ? 'schemaVersion') and ($2::timestamptz is null or (created_at,view_id)<($2::timestamptz,$3::uuid)) order by created_at desc,view_id desc limit $1`,
            [input.first + 1, cursor?.[0] ?? null, cursor?.[1] ?? null],
          );
          const rows = result.rows
            .slice(0, input.first)
            .map((row) => savedSchema.parse(row));
          for (const row of rows) {
            if (
              row.revoked_at !== null ||
              row.purpose !== context.authorization.purpose ||
              row.tenant_id !== context.authorization.tenantId ||
              row.project_id !== context.authorization.projectId ||
              (row.visibility === 'private' && !isOwner(row, context))
            )
              throw new DataCapabilityHandlerError('NOT_FOUND');
            await scope(client, context, row.candidate_refs);
            await manifest(client, row.candidate_refs, context);
          }
          const last = rows.at(-1);
          return ListIngestionCandidateViewsOutputSchema.parse({
            items: rows.map(metadata),
            nextCursor:
              result.rows.length > input.first && last
                ? candidateSavedListCursor(context, input, [
                    last.created_at.toISOString(),
                    last.view_id,
                  ])
                : null,
          });
        });
      },
    },
    {
      id: 'data.ingestion.candidate.view.open',
      async execute(raw, context) {
        const input = OpenIngestionCandidateViewInputSchema.parse(raw);
        return read(context, async (client) => {
          const row = await readSaved(
            client,
            input.viewId,
            context,
            false,
            false,
            true,
          );
          const position = await validateView(client, row.view_spec);
          return OpenIngestionCandidateViewOutputSchema.parse({
            kind: 'ingestion-candidate-view',
            savedView: metadata(row),
            references: row.candidate_refs,
            viewSpec: row.view_spec,
            request: pageRequest(row.view_spec, context, position),
          });
        });
      },
    },
    {
      id: 'data.ingestion.candidate.view.revoke',
      async execute(raw, context) {
        const input = RevokeIngestionCandidateViewInputSchema.parse(raw);
        assertAuthority(context);
        const check = (client: QueryAdapterPgClient) =>
          commandErrors(async () => {
            await scope(client, context);
            const row = await readVersionedSaved(
              client,
              input.viewId,
              context,
              true,
              true,
            );
            if ('schemaVersion' in row.view_spec)
              await validateVersionedSaved(client, row, context, authorities);
            assertAuthority(context);
            return { viewId: input.viewId, revoked: true as const };
          });
        return transactions.run(
          'data.ingestion.candidate.view.revoke',
          input,
          context,
          (client, timestamp) =>
            commandErrors(async () => {
              const output = await check(client);
              const revoked = await client.query(
                '/* candidate.saved.revoke */ update service.ingestion_candidate_saved_view set revoked_at=coalesce(revoked_at,$2::timestamptz) where view_id=$1::uuid',
                [input.viewId, timestamp],
              );
              if (revoked.rowCount !== 1)
                throw new DataCapabilityHandlerError('NOT_FOUND');
              assertAuthority(context);
              return {
                output,
                replayResult: output,
                aggregateId: input.viewId,
                eventType: 'data.ingestion-candidate-view.revoked',
                securityLevel: context.effectiveMaxSecurityLevel,
              };
            }),
          check,
        );
      },
    },
  ];
}
