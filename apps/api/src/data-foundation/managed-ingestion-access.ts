import { IngestionSubmissionResponsibilitySchema } from '@wiser/data-contracts';
import {
  canonicalIngestionUuid,
  isIndependentIngestionReviewer,
  sameIngestionUuid,
} from '@wiser/data-core';
import {
  PlatformPrincipalSchema,
  ResourceAccessContextSchema,
  PlatformPurposeSchema,
} from '@wiser/platform-contracts';
import type { DataCapabilityExecutionContext } from './capability-handler.js';
import type { ResourceScopeClient } from './resource-read-scope.js';

export interface PendingIntakeAuthority {
  readonly maintainer: boolean;
  readonly reviewer: boolean;
}

/** Facts come from fresh Auth context, never from command input or asset metadata. */
export function pendingIntakeAuthority(
  context: DataCapabilityExecutionContext,
  now = Date.now(),
): PendingIntakeAuthority | null {
  const principal = PlatformPrincipalSchema.safeParse(context.principal);
  if (
    !principal.success ||
    !PlatformPurposeSchema.safeParse(context.authorization.purpose).success
  )
    return null;
  const actor = principal.data;
  const human = actor.actorType === 'human' && actor.delegatedBy === undefined;
  const delegated =
    (actor.actorType === 'agent' || actor.actorType === 'service') &&
    actor.authenticationMethod === 'delegated_credential' &&
    actor.delegatedBy !== undefined;
  if (!human && !delegated) return null;
  if (actor.expiresAt !== undefined && Date.parse(actor.expiresAt) <= now)
    return null;
  if (context.authorization.resourceAccess !== undefined) {
    const scope = ResourceAccessContextSchema.safeParse(
      context.authorization.resourceAccess,
    );
    if (
      !scope.success ||
      scope.data.scope.mode !== 'managed' ||
      (scope.data.scope.validUntil !== null &&
        Date.parse(scope.data.scope.validUntil) <= now)
    )
      return null;
  }
  const scopes = context.authorization.scopes;
  return {
    maintainer:
      scopes.includes('data.operation.read') &&
      scopes.includes('data.ingestion.write'),
    reviewer:
      human &&
      scopes.includes('data.operation.read') &&
      scopes.includes('data.publish'),
  };
}

export function submissionResponsibility(value: unknown) {
  const parsed = IngestionSubmissionResponsibilitySchema.safeParse(value);
  if (!parsed.success) return null;
  const actor = parsed.data;
  if (
    actor.actorType === 'human'
      ? actor.delegatedBy !== undefined
      : actor.delegatedBy === undefined
  )
    return null;
  return actor;
}

export function ownsPendingSubmission(
  context: DataCapabilityExecutionContext,
  value: unknown,
): boolean {
  const stored = submissionResponsibility(value);
  if (!stored) return false;
  const actor = context.principal;
  if (actor.actorType === 'human' && actor.delegatedBy === undefined)
    return (
      (stored.actorType === 'human' &&
        sameIngestionUuid(stored.actorId, actor.actorId)) ||
      (stored.delegatedBy !== undefined &&
        sameIngestionUuid(stored.delegatedBy, actor.actorId))
    );
  return (
    stored.actorType === actor.actorType &&
    sameIngestionUuid(stored.actorId, actor.actorId) &&
    stored.delegatedBy !== undefined &&
    sameIngestionUuid(stored.delegatedBy, actor.delegatedBy)
  );
}

export function canReadPendingSubmission(
  context: DataCapabilityExecutionContext,
  value: unknown,
  authority: PendingIntakeAuthority,
): boolean {
  const stored = submissionResponsibility(value);
  return (
    stored !== null &&
    ((authority.maintainer && ownsPendingSubmission(context, stored)) ||
      (authority.reviewer &&
        isIndependentIngestionReviewer(context.principal, stored)))
  );
}

export function rowSubmissionResponsibility(
  row: Readonly<Record<string, unknown>>,
) {
  return {
    actorId: row['submitted_by_actor_id'],
    actorType: row['submitted_actor_type'],
    ...(row['submitted_delegator_actor_id'] == null
      ? {}
      : { delegatedBy: row['submitted_delegator_actor_id'] }),
  };
}

/** Install only inside an API transaction, after current identity and scope checks. */
export async function setPendingIntakeScope(
  client: ResourceScopeClient,
  context: DataCapabilityExecutionContext,
  capabilityId: string,
  authority: PendingIntakeAuthority,
): Promise<void> {
  const actorId = canonicalIngestionUuid(context.principal.actorId);
  const delegatedBy =
    context.principal.delegatedBy === undefined
      ? ''
      : canonicalIngestionUuid(context.principal.delegatedBy);
  if (actorId === null || delegatedBy === null)
    throw new Error('Invalid pending intake identity.');
  await client.query(
    `/* data.intake.scope */ select
    set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type',$2,true),
    set_config('wiser.delegated_by',$3,true),set_config('wiser.candidate_maintainer',$4::text,true),
    set_config('wiser.candidate_reviewer',$5::text,true),set_config('wiser.candidate_purpose',$6,true),
    set_config('wiser.intake_capability',$7,true)`,
    [
      actorId,
      context.principal.actorType,
      delegatedBy,
      authority.maintainer,
      authority.reviewer,
      context.authorization.purpose,
      capabilityId,
    ],
  );
}
