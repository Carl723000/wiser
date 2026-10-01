import type { WorkspaceRecord } from './spatial-workspace-contract';

export type CandidateAction = 'accept' | 'exclude' | 'pending';
export interface CandidateDecision {
  sourceId: string;
  versionId: string;
  recordId: string;
  positionId: string;
  action: CandidateAction;
  reason: string;
  decisionVersion: string;
  synthetic: true;
}
export type CandidateDecisionInput = Pick<
  CandidateDecision,
  'positionId' | 'action' | 'reason' | 'decisionVersion'
>;

/** The exercise never changes a real pending record or a source identity. */
export function decideCandidate(
  record: WorkspaceRecord,
  history: readonly CandidateDecision[],
  input: CandidateDecisionInput,
): CandidateDecision {
  if (record.reviewStatus !== 'synthetic-reviewed')
    throw new Error('REAL_CANDIDATE_READ_ONLY');
  if (!record.positions.some((position) => position.id === input.positionId))
    throw new Error('POSITION_NOT_FOUND');
  if (!input.reason.trim()) throw new Error('REASON_REQUIRED');
  if (!input.decisionVersion.trim())
    throw new Error('DECISION_VERSION_REQUIRED');
  if (!['accept', 'exclude', 'pending'].includes(input.action))
    throw new Error('INVALID_ACTION');
  if (
    history.some(
      (decision) => decision.decisionVersion === input.decisionVersion,
    )
  )
    throw new Error('DECISION_VERSION_EXISTS');
  return {
    sourceId: record.sourceId,
    versionId: record.versionId,
    recordId: record.id,
    positionId: input.positionId,
    action: input.action,
    reason: input.reason.trim(),
    decisionVersion: input.decisionVersion.trim(),
    synthetic: true,
  };
}

export function regenerateCandidates(
  record: WorkspaceRecord,
  decisions: readonly CandidateDecision[],
): WorkspaceRecord {
  if (record.reviewStatus !== 'synthetic-reviewed')
    throw new Error('REAL_CANDIDATE_READ_ONLY');
  const bound = decisions.filter(
    (decision) =>
      decision.synthetic === true &&
      decision.sourceId === record.sourceId &&
      decision.versionId === record.versionId &&
      decision.recordId === record.id &&
      record.positions.some((position) => position.id === decision.positionId),
  );
  const latest = new Map(
    bound.map((decision) => [decision.positionId, decision]),
  );
  return {
    ...record,
    processingVersion: bound.length
      ? `${record.processingVersion}:decision:${bound.at(-1)!.decisionVersion}`
      : record.processingVersion,
    positions: record.positions.flatMap((position) => {
      const decision = latest.get(position.id);
      if (!decision) return [{ ...position }];
      if (decision.action === 'exclude') return [];
      return [
        {
          ...position,
          match:
            decision.action === 'accept'
              ? ('bound' as const)
              : ('candidate' as const),
        },
      ];
    }),
    evidence: record.evidence.map((evidence) => ({ ...evidence })),
    missingReasons: [...record.missingReasons],
    reviewStatus: 'synthetic-reviewed',
  };
}

/** Explicitly synthetic fixture: never inserted into the real pack. */
export function syntheticReviewRecord(): WorkspaceRecord {
  return {
    id: 'synthetic-candidate-record',
    sourceId: 'synthetic-exercise-source',
    versionId: 'synthetic-v1',
    objectId: 'synthetic-exercise-source:object:1',
    objectLabel: 'Synthetic district reference exercise',
    kind: 'spatial',
    regionIds: ['chaobai'],
    needIds: ['K5-004'],
    time: { start: null, end: null, precision: 'unknown', role: 'unknown' },
    metric: 'synthetic-reference',
    value: null,
    unit: null,
    positions: [
      {
        id: 'synthetic-position-1',
        expression: 'Synthetic study area',
        role: 'reference',
        match: 'candidate',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [116, 40],
              [116.1, 40],
              [116.1, 40.1],
              [116, 40.1],
              [116, 40],
            ],
          ],
        },
        crs: 'EPSG:4326',
        nativeCrs: 'EPSG:4326',
        geometrySourceId: 'synthetic-geometry-source',
        geometryVersionId: 'synthetic-g1',
        locator: 'synthetic:paragraph:1',
        scaleNote: 'Synthetic reference; no real location claim',
        evidence: {
          locator: 'synthetic:paragraph:1',
          text: 'Synthetic study area',
        },
      },
    ],
    evidence: [
      {
        locator: 'synthetic:paragraph:1',
        text: 'Synthetic exercise only',
        url: null,
      },
    ],
    processingVersion: 'synthetic-rule-v1',
    reviewStatus: 'synthetic-reviewed',
    missingReasons: ['synthetic-exercise-only'],
  };
}
