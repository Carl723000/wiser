import {
  ActCandidateFollowupInputSchema,
  CreateCandidateFollowupInputSchema,
  CandidateFollowupEvidenceSchema,
  type CandidateFollowupEvidence,
  ReviewCandidateFollowupInputSchema,
  CandidateFollowupResponsibilitySchema,
  CandidateFollowupSnapshotSchema,
  type CandidateFollowupSnapshot,
  type CandidateFollowupResponsibility,
} from '@wiser/data-contracts/candidate-followups';
import { canonicalIngestionUuid } from './ingestion/index.ts';

/** Only UUID identity spelling changes; source proof and original geometry stay literal. */
export function canonicalCandidateFollowupEvidence(
  raw: unknown,
): CandidateFollowupEvidence {
  const value = CandidateFollowupEvidenceSchema.parse(raw);
  return {
    ...value,
    reference: {
      ...value.reference,
      ingestionId: canonicalIngestionUuid(value.reference.ingestionId)!,
      processingBatchId: canonicalIngestionUuid(
        value.reference.processingBatchId,
      )!,
    },
    assetId: canonicalIngestionUuid(value.assetId)!,
    ...(value.recordId === undefined
      ? {}
      : { recordId: canonicalIngestionUuid(value.recordId)! }),
  };
}
export function canonicalCandidateFollowupCommand(raw: unknown) {
  const created = CreateCandidateFollowupInputSchema.safeParse(raw);
  if (created.success) {
    const value = created.data;
    return CreateCandidateFollowupInputSchema.parse({
      ...value,
      source: canonicalCandidateFollowupEvidence(value.source),
    });
  }
  const action = ActCandidateFollowupInputSchema.safeParse(raw);
  if (!action.success) {
    const value = ReviewCandidateFollowupInputSchema.parse(raw);
    return { ...value, followupId: canonicalIngestionUuid(value.followupId)! };
  }
  const value = action.data;
  return ActCandidateFollowupInputSchema.parse({
    ...value,
    followupId: canonicalIngestionUuid(value.followupId)!,
    ...(value.action === 'HANDOFF'
      ? { targetActorId: canonicalIngestionUuid(value.targetActorId)! }
      : {}),
    ...(value.action === 'SUPPLEMENT'
      ? {
          evidence: value.evidence.map(canonicalCandidateFollowupEvidence),
          ...(value.correction
            ? {
                correction: {
                  ...value.correction,
                  old: canonicalCandidateFollowupEvidence(value.correction.old),
                  new: canonicalCandidateFollowupEvidence(value.correction.new),
                },
              }
            : {}),
        }
      : {}),
  });
}
const proofKey = (value: unknown) =>
  canonical(canonicalCandidateFollowupEvidence(value));
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') +
    '}'
  );
}
function actor(
  value: unknown,
  requirePurpose = false,
): CandidateFollowupResponsibility {
  const parsed = CandidateFollowupResponsibilitySchema.parse(value);
  if (requirePurpose && !parsed.purpose)
    throw Error('TRUSTED_PURPOSE_REQUIRED');
  return {
    ...parsed,
    actorId: canonicalIngestionUuid(parsed.actorId)!,
    delegatedBy:
      parsed.delegatedBy === null
        ? null
        : canonicalIngestionUuid(parsed.delegatedBy)!,
  };
}
function sameActor(
  a: CandidateFollowupResponsibility,
  b: CandidateFollowupResponsibility,
): boolean {
  return canonical(actor(a)) === canonical(actor(b));
}
function owns(
  who: CandidateFollowupResponsibility,
  owner: CandidateFollowupResponsibility,
): boolean {
  return (
    sameActor(who, owner) ||
    (who.actorType === 'human' &&
      who.delegatedBy === null &&
      owner.delegatedBy === who.actorId &&
      who.purpose === owner.purpose)
  );
}
export function assertIndependentCandidateFollowupReviewer(
  raw: unknown,
  responsibilities: readonly unknown[],
): void {
  const reviewer = actor(raw, true);
  if (
    reviewer.actorType !== 'human' ||
    reviewer.delegatedBy !== null ||
    responsibilities.length === 0 ||
    responsibilities.length > 1000
  )
    throw Error('INDEPENDENT_REVIEW_REQUIRED');
  for (const item of responsibilities) {
    const responsibility = actor(item);
    if (
      responsibility.actorId === reviewer.actorId ||
      responsibility.delegatedBy === reviewer.actorId
    )
      throw Error('INDEPENDENT_REVIEW_REQUIRED');
  }
}

/** Inputs contain no caller-supplied authority. Host checks current sources and target rights. */
export function planCandidateFollowupTransition(
  rawSnapshot: unknown,
  rawCommand: unknown,
  rawActor: unknown,
  rawTarget?: unknown,
): CandidateFollowupSnapshot {
  const current = CandidateFollowupSnapshotSchema.parse(rawSnapshot),
    who = actor(rawActor, true);
  const result = ActCandidateFollowupInputSchema.safeParse(rawCommand);
  const command = result.success
    ? result.data
    : ReviewCandidateFollowupInputSchema.parse(rawCommand);
  if (
    canonicalIngestionUuid(command.followupId) !==
      canonicalIngestionUuid(current.followupId) ||
    command.expectedVersion !== current.rowVersion ||
    current.rowVersion >= 200
  )
    throw Error('CONFLICT');
  const next: CandidateFollowupSnapshot = {
    ...current,
    rowVersion: current.rowVersion + 1,
    responsibilities: [...current.responsibilities],
    evidence: [...current.evidence],
  };
  if ('decision' in command) {
    if (current.state !== 'REVIEW_PENDING') throw Error('CONFLICT');
    assertIndependentCandidateFollowupReviewer(who, current.responsibilities);
    next.state = command.decision === 'CLOSE' ? 'CLOSED' : 'WORKING';
    return next;
  }
  if (command.action === 'REOPEN') {
    if (current.state !== 'CLOSED') throw Error('CONFLICT');
    if (
      !owns(who, current.createdBy) &&
      (!current.assignee || !owns(who, current.assignee))
    )
      throw Error('RESPONSIBILITY_REQUIRED');
    next.state = 'OPEN';
    next.assignee = null;
  } else if (command.action === 'CLAIM') {
    if (current.state !== 'OPEN') throw Error('CONFLICT');
    next.state = 'WORKING';
    next.assignee = who;
  } else {
    if (
      current.state !== 'WORKING' ||
      !current.assignee ||
      !sameActor(who, current.assignee)
    )
      throw Error('RESPONSIBILITY_REQUIRED');
    if (command.action === 'HANDOFF') {
      const target = actor(rawTarget, true);
      if (canonicalIngestionUuid(command.targetActorId) !== target.actorId)
        throw Error('INVALID_HANDOFF');
      if (target.purpose !== who.purpose || sameActor(target, who))
        throw Error('INVALID_HANDOFF');
      next.assignee = target;
      next.responsibilities.push(target);
    } else if (command.action === 'SUPPLEMENT') {
      if (current.evidence.length + command.evidence.length > 64)
        throw Error('EVIDENCE_LIMIT');
      const existing = new Set(
        [current.source, ...current.evidence].map(proofKey),
      );
      for (const evidence of command.evidence) {
        if (existing.has(proofKey(evidence))) throw Error('DUPLICATE_EVIDENCE');
        existing.add(proofKey(evidence));
      }
      if (current.type === 'CORRECTION') {
        if (
          !command.correction ||
          ![current.source, ...current.evidence].some(
            (item) => proofKey(item) === proofKey(command.correction!.old),
          ) ||
          !command.evidence.some(
            (item) => proofKey(item) === proofKey(command.correction!.new),
          )
        )
          throw Error('WHOLE_RECORD_CORRESPONDENCE_REQUIRED');
      } else if (command.correction) throw Error('GAP_CANNOT_IMPLY_CORRECTION');
      next.evidence.push(
        ...command.evidence.map(canonicalCandidateFollowupEvidence),
      );
    } else if (command.action === 'SUBMIT_REVIEW') {
      if (current.evidence.length === 0) throw Error('SUPPLEMENT_REQUIRED');
      next.state = 'REVIEW_PENDING';
    }
  }
  next.responsibilities.push(who);
  return CandidateFollowupSnapshotSchema.parse(next);
}
export function candidateFollowupCommandIdentity(
  command: unknown,
  responsibility: unknown,
): string {
  return canonical({
    command: canonicalCandidateFollowupCommand(command),
    responsibility: actor(responsibility, true),
  });
}
