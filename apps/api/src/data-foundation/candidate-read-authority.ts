import {
  PlatformPrincipalSchema,
  PlatformPurposeSchema,
  ResourceAccessContextSchema,
  type PlatformRequestContext,
} from '@wiser/platform-contracts';
import { canonicalIngestionUuid } from '@wiser/data-core';
import { IngestionCandidateReferenceSchema } from '@wiser/data-contracts';
import type { ResourceScopeClient } from './resource-read-scope.js';

type Context = Pick<PlatformRequestContext, 'principal' | 'authorization'>;

/** Fresh Auth authority only; immutable submission ownership is checked by RLS. */
export function candidateReadAuthority(context: Context) {
  const parsed = PlatformPrincipalSchema.safeParse(context.principal);
  const denied = { maintainer: false, reviewer: false };
  if (
    !parsed.success ||
    !PlatformPurposeSchema.safeParse(context.authorization.purpose).success
  )
    return denied;
  const principal = parsed.data;
  if (
    principal.expiresAt !== undefined &&
    Date.parse(principal.expiresAt) <= Date.now()
  )
    return denied;
  const resource = context.authorization.resourceAccess;
  if (resource !== undefined) {
    const checked = ResourceAccessContextSchema.safeParse(resource);
    if (
      !checked.success ||
      checked.data.scope.mode !== 'managed' ||
      (checked.data.scope.validUntil !== null &&
        Date.parse(checked.data.scope.validUntil) <= Date.now())
    )
      return denied;
  }
  const validPrincipal =
    (principal.actorType === 'human' && principal.delegatedBy === undefined) ||
    ((principal.actorType === 'agent' || principal.actorType === 'service') &&
      principal.authenticationMethod === 'delegated_credential' &&
      Boolean(principal.delegatedBy));
  const scopes = context.authorization.scopes;
  return {
    maintainer:
      validPrincipal &&
      scopes.includes('data.operation.read') &&
      scopes.includes('data.ingestion.write'),
    reviewer:
      principal.actorType === 'human' &&
      principal.delegatedBy === undefined &&
      scopes.includes('data.operation.read') &&
      scopes.includes('data.publish'),
  };
}

export async function setCandidateReadAuthority(
  client: ResourceScopeClient,
  context: Context,
  references: unknown = [],
): Promise<void> {
  const { maintainer, reviewer } = candidateReadAuthority(context);
  if (!maintainer && !reviewer)
    throw Object.assign(new Error('Pending candidate access is unavailable.'), {
      code: 'FORBIDDEN',
    });
  const actorId = canonicalIngestionUuid(context.principal.actorId);
  const delegatedBy =
    context.principal.delegatedBy === undefined
      ? ''
      : canonicalIngestionUuid(context.principal.delegatedBy);
  if (actorId === null || delegatedBy === null)
    throw Object.assign(new Error('Pending candidate access is unavailable.'), {
      code: 'FORBIDDEN',
    });
  const parsed = IngestionCandidateReferenceSchema.array()
    .max(100)
    .safeParse(references);
  if (!parsed.success)
    throw Object.assign(new Error('Pending candidate access is unavailable.'), {
      code: 'FORBIDDEN',
    });
  const fixed = parsed.data.map((ref) => ({
    ...ref,
    ingestionId: canonicalIngestionUuid(ref.ingestionId)!,
    processingBatchId: canonicalIngestionUuid(ref.processingBatchId)!,
  }));
  if (new Set(fixed.map((ref) => JSON.stringify(ref))).size !== fixed.length)
    throw Object.assign(new Error('Pending candidate access is unavailable.'), {
      code: 'FORBIDDEN',
    });
  // The parsed fixed selection only narrows history; forced RLS checks actual
  // immutable rows and current authority. Omitted selections clear history.
  await client.query(
    `/* data.ingestion.candidate.scope */
select set_config('wiser.actor_id',$1,true), set_config('wiser.actor_type',$2,true),
  set_config('wiser.delegated_by',$3,true),
  set_config('wiser.candidate_maintainer',$4::text,true),
  set_config('wiser.candidate_reviewer',$5::text,true),
  set_config('wiser.candidate_purpose',$6,true),
  set_config('wiser.candidate_fixed_refs',$7,true),
  set_config('statement_timeout','10000',true)`,
    [
      actorId,
      context.principal.actorType,
      delegatedBy,
      maintainer,
      reviewer,
      context.authorization.purpose,
      JSON.stringify(fixed),
    ],
  );
}
