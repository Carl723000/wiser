import {
  CandidateRelationCommandSchema,
  CandidateRelationResponsibilitySchema,
  CandidateRelationReviewResponsibilitySchema,
  CandidateRelationRevisionSchema,
  CandidateRelationStateSchema,
  type CandidateRelationRevision,
  type CandidateRelationState,
} from '@wiser/data-contracts/candidate-relations';
import type { IngestionCandidateReference } from '@wiser/data-contracts';
import { canonicalIngestionUuid } from './ingestion/index.ts';
import {
  groupRelationCandidates,
  KNOWLEDGE_RELATION_RULES,
} from './knowledge-relations.ts';

function canonicalReference(
  reference: IngestionCandidateReference,
): IngestionCandidateReference {
  return {
    ...reference,
    ingestionId: canonicalIngestionUuid(reference.ingestionId)!,
    processingBatchId: canonicalIngestionUuid(reference.processingBatchId)!,
  };
}
export function candidateRelationSourceKey(
  reference: IngestionCandidateReference,
): string {
  const value = canonicalReference(reference);
  return JSON.stringify([
    value.kind,
    value.ingestionId,
    value.processingBatchId,
    value.reviewHash,
  ]);
}

/** Candidate identities never become catalog version identities. */
export function validateCandidateRelationRevision(
  value: unknown,
): CandidateRelationRevision {
  const parsed = CandidateRelationRevisionSchema.parse(value);
  const content = parsed.content;
  const context = content.qualifiers.context;
  if (
    context.timeRole === 'OBSERVATION_TIME' &&
    context.recordNature !== 'REPORTED_OBSERVATION'
  )
    throw new Error('Non-observation cannot use observation time');
  if (
    parsed.revision === 1
      ? parsed.supersedesId !== null
      : parsed.supersedesId === null
  )
    throw new Error('Content revisions require an explicit predecessor');
  const primary = candidateRelationSourceKey(parsed.reference);
  const endpointSources = new Set<string>();
  if (content.predicate === 'IDENTITY_MATCH') {
    const a = content.subject.reference,
      b = content.object.reference;
    if (
      !a ||
      !b ||
      !(
        KNOWLEDGE_RELATION_RULES.IDENTITY_MATCH.subjects as readonly string[]
      ).includes(content.subject.kind) ||
      content.subject.kind !== content.object.kind ||
      context.recordNature !== 'SOURCE_RELATION' ||
      a.entityKey !== content.subject.key ||
      b.entityKey !== content.object.key ||
      candidateRelationSourceKey(a.reference) ===
        candidateRelationSourceKey(b.reference)
    )
      throw new Error(
        'Identity match requires distinct candidate sources, source-local keys and equal endpoint kinds',
      );
    endpointSources.add(candidateRelationSourceKey(a.reference));
    endpointSources.add(candidateRelationSourceKey(b.reference));
    if (!endpointSources.has(primary))
      throw new Error('Primary source must be an identity endpoint');
  } else {
    if (content.subject.reference || content.object.reference)
      throw new Error(
        'Only identity matches may reference other candidate sources',
      );
    endpointSources.add(primary);
    // Reuse published type rules, never its source references or persistence.
    groupRelationCandidates([
      {
        ...content,
        evidence: content.evidence.map(
          ({ reference: _reference, recordId: _recordId, ...item }) => item,
        ),
        supersedesId: null,
      },
    ]);
  }
  const evidenceSources = new Set(
    content.evidence.map((item) => candidateRelationSourceKey(item.reference)),
  );
  if (
    [...evidenceSources].some((key) => !endpointSources.has(key)) ||
    [...endpointSources].some((key) => !evidenceSources.has(key))
  )
    throw new Error('Every endpoint source requires exact candidate evidence');
  const canonicalEntity = (
    entity: CandidateRelationRevision['content']['subject'],
  ) => ({
    ...entity,
    ...(entity.reference
      ? {
          reference: {
            ...entity.reference,
            reference: canonicalReference(entity.reference.reference),
          },
        }
      : {}),
  });
  return {
    ...parsed,
    revisionId: canonicalIngestionUuid(parsed.revisionId)!,
    relationId: canonicalIngestionUuid(parsed.relationId)!,
    lineageId: canonicalIngestionUuid(parsed.lineageId)!,
    supersedesId:
      parsed.supersedesId === null
        ? null
        : canonicalIngestionUuid(parsed.supersedesId)!,
    reference: canonicalReference(parsed.reference),
    content: {
      ...content,
      subject: canonicalEntity(content.subject),
      object: canonicalEntity(content.object),
      evidence: content.evidence.map((item) => ({
        ...item,
        reference: canonicalReference(item.reference),
        assetId: canonicalIngestionUuid(item.assetId)!,
        ...(item.recordId
          ? { recordId: canonicalIngestionUuid(item.recordId)! }
          : {}),
      })),
    },
  };
}

export function candidateRelationCommandIdentity(
  raw: unknown,
  trustedResponsibility: unknown,
): string {
  const command = CandidateRelationCommandSchema.parse(raw);
  const actor = CandidateRelationResponsibilitySchema.parse(
    trustedResponsibility,
  );
  const revisions = command.revisions.map(validateCandidateRelationRevision);
  if (
    new Set(revisions.map((row) => `${row.relationId}:${row.revision}`))
      .size !== revisions.length
  )
    throw new Error('Duplicate candidate relation revisions');
  return JSON.stringify({
    revisions,
    responsibility: {
      ...actor,
      actorId: canonicalIngestionUuid(actor.actorId)!,
      delegatedBy:
        actor.delegatedBy === null
          ? null
          : canonicalIngestionUuid(actor.delegatedBy)!,
    },
  });
}

/** Immutable relation and every relevant source responsibility are supplied by the host. */
export function assertIndependentCandidateRelationReviewer(
  rawReviewer: unknown,
  rawResponsibilities: readonly unknown[],
): void {
  const reviewer = CandidateRelationResponsibilitySchema.parse(rawReviewer);
  if (
    reviewer.actorType !== 'human' ||
    reviewer.delegatedBy !== null ||
    rawResponsibilities.length < 2 ||
    rawResponsibilities.length > 65
  )
    throw new Error(
      'Candidate relation decisions require complete responsibility and an independent human',
    );
  const actorId = canonicalIngestionUuid(reviewer.actorId)!;
  for (const raw of rawResponsibilities) {
    const responsibility =
      CandidateRelationReviewResponsibilitySchema.parse(raw);
    if (
      canonicalIngestionUuid(responsibility.actorId) === actorId ||
      (responsibility.delegatedBy !== null &&
        canonicalIngestionUuid(responsibility.delegatedBy) === actorId)
    )
      throw new Error('Candidate relation self-review is prohibited');
  }
}

export function assertCandidateRelationDecisionTransition(
  from: CandidateRelationState,
  to: CandidateRelationState,
  expectedDecisionVersion: number,
): void {
  CandidateRelationStateSchema.parse(from);
  CandidateRelationStateSchema.parse(to);
  if (
    !Number.isInteger(expectedDecisionVersion) ||
    expectedDecisionVersion < 0 ||
    expectedDecisionVersion >= 100 ||
    !(
      (from === 'PENDING_REVIEW' &&
        ['CONFIRMED', 'REJECTED', 'CORRECTION_REQUIRED', 'WITHDRAWN'].includes(
          to,
        )) ||
      (from === 'CONFIRMED' && to === 'REVOKED')
    )
  )
    throw new Error(
      'Invalid candidate decision transition or exhausted decision history',
    );
}

export function candidateRelationWithdrawalAllowed(
  rawActor: unknown,
  rawSubmitter: unknown,
): boolean {
  const actor = CandidateRelationResponsibilitySchema.parse(rawActor);
  const submitter = CandidateRelationResponsibilitySchema.parse(rawSubmitter);
  const id = canonicalIngestionUuid(actor.actorId)!;
  return actor.actorType === 'human' && actor.delegatedBy === null
    ? id === canonicalIngestionUuid(submitter.actorId) ||
        id === canonicalIngestionUuid(submitter.delegatedBy)
    : actor.actorType === submitter.actorType &&
        id === canonicalIngestionUuid(submitter.actorId) &&
        actor.delegatedBy !== null &&
        canonicalIngestionUuid(actor.delegatedBy) ===
          canonicalIngestionUuid(submitter.delegatedBy);
}
