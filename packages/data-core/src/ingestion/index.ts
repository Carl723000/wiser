import {
  IngestionReviewGovernanceContextSchema,
  IngestionReviewPolicySchema,
  IngestionSubmissionResponsibilitySchema,
  type IngestionReviewPolicy,
  type IngestionState,
} from '@wiser/data-contracts';

import { DataFoundationDomainError } from '../domain-error.js';

export function isIndependentIngestionReviewer(
  reviewer: { readonly actorId: string; readonly actorType: string },
  responsibility: unknown,
): boolean {
  if (reviewer.actorType !== 'human') return false;
  const parsed =
    IngestionSubmissionResponsibilitySchema.safeParse(responsibility);
  if (!parsed.success) return false;
  const submitter = parsed.data;
  if (submitter.actorType !== 'human' && submitter.delegatedBy === undefined)
    return false;
  return (
    submitter.actorId !== reviewer.actorId &&
    submitter.delegatedBy !== reviewer.actorId
  );
}

export function resolveIngestionReviewGovernance(
  value: unknown,
):
  | { readonly kind: 'LEGACY' }
  | { readonly kind: 'REQUIRES_REVIEW'; readonly policy: IngestionReviewPolicy }
  | { readonly kind: 'CONFLICT' } {
  if (value === undefined) return { kind: 'LEGACY' };
  const parsed = IngestionReviewGovernanceContextSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.frozen.revision !== parsed.data.current.revision
  ) {
    return { kind: 'CONFLICT' };
  }
  return { kind: 'REQUIRES_REVIEW', policy: Object.freeze(parsed.data.frozen) };
}

export function matchesFrozenIngestionReviewPolicy(
  policy: IngestionReviewPolicy,
  value: unknown,
): boolean {
  const parsed = IngestionReviewPolicySchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.mode === policy.mode &&
    parsed.data.revision === policy.revision
  );
}

type IngestionTransitionPolicy = Readonly<
  Record<IngestionState, readonly IngestionState[]>
>;

export const INGESTION_TRANSITION_POLICY = Object.freeze({
  RECEIVED: Object.freeze(['QUARANTINED', 'FAILED', 'CANCELLED']),
  QUARANTINED: Object.freeze(['SECURITY_SCANNED', 'FAILED', 'CANCELLED']),
  SECURITY_SCANNED: Object.freeze([
    'FINGERPRINTED',
    'REJECTED',
    'FAILED',
    'CANCELLED',
  ]),
  FINGERPRINTED: Object.freeze(['PROFILED', 'FAILED', 'CANCELLED']),
  PROFILED: Object.freeze(['CLASSIFIED', 'FAILED', 'CANCELLED']),
  CLASSIFIED: Object.freeze(['SCHEMA_MAPPED', 'FAILED', 'CANCELLED']),
  SCHEMA_MAPPED: Object.freeze(['SEMANTIC_MAPPED', 'FAILED', 'CANCELLED']),
  SEMANTIC_MAPPED: Object.freeze(['VALIDATED', 'FAILED', 'CANCELLED']),
  VALIDATED: Object.freeze([
    'SPATIOTEMPORAL_ALIGNED',
    'REJECTED',
    'FAILED',
    'CANCELLED',
  ]),
  SPATIOTEMPORAL_ALIGNED: Object.freeze([
    'REVIEW_REQUIRED',
    'APPROVED',
    'FAILED',
    'CANCELLED',
  ]),
  REVIEW_REQUIRED: Object.freeze([
    'APPROVED',
    'REJECTED',
    'FAILED',
    'CANCELLED',
  ]),
  APPROVED: Object.freeze(['COMMITTED', 'FAILED', 'CANCELLED']),
  REJECTED: Object.freeze([]),
  COMMITTED: Object.freeze(['PROJECTING', 'FAILED']),
  PROJECTING: Object.freeze(['PUBLISHED', 'FAILED']),
  PUBLISHED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
} satisfies IngestionTransitionPolicy);

export class InvalidIngestionTransitionError extends DataFoundationDomainError {
  constructor(
    readonly from: IngestionState,
    readonly to: IngestionState,
  ) {
    super(
      'INVALID_INGESTION_TRANSITION',
      `Ingestion cannot transition from ${from} to ${to}.`,
    );
    this.name = 'InvalidIngestionTransitionError';
  }
}

export function canTransitionIngestionState(
  from: IngestionState,
  to: IngestionState,
): boolean {
  const destinations: readonly IngestionState[] =
    INGESTION_TRANSITION_POLICY[from];
  return destinations.includes(to);
}

export function transitionIngestionState(
  from: IngestionState,
  to: IngestionState,
): IngestionState {
  if (!canTransitionIngestionState(from, to)) {
    throw new InvalidIngestionTransitionError(from, to);
  }

  return to;
}
