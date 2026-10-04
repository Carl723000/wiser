import type {
  RegionId,
  WorkspaceRecord,
  WorkspaceTopicPackage,
} from './spatial-workspace-contract';

export type ImpactReason =
  | 'record-corrected'
  | 'position-corrected'
  | 'original-revised'
  | 'rule-changed'
  | 'geometry-revised'
  | 'rights-withdrawn'
  | 'source-missing'
  | 'new-period';
export interface VersionChange {
  sourceId: string;
  previousVersionId: string | null;
  nextVersionId: string | null;
  reason: ImpactReason;
  previousProcessingVersion?: string;
  /** Fixed local dependent references; never an authorization or source edit. */
  scope?:
    | { kind: 'records'; recordIds: readonly string[] }
    | {
        kind: 'positions';
        recordId: string;
        positionIds: readonly string[];
      };
}
export interface VersionImpact {
  recordIds: string[];
  objectIds: string[];
  positionIds: string[];
  needIds: string[];
  regionIds: RegionId[];
  topicIds: string[];
  findings: { recordId: string; sourceId: string; reason: ImpactReason }[];
}

/** Computes dependencies without changing or deleting an existing record. */
export function versionImpact(
  records: readonly WorkspaceRecord[],
  changes: readonly VersionChange[],
  topics: readonly WorkspaceTopicPackage[],
): VersionImpact {
  const affected = new Set<string>();
  const objects = new Set<string>();
  const positions = new Set<string>();
  const needs = new Set<string>();
  const regions = new Set<RegionId>();
  const findings = new Map<string, VersionImpact['findings'][number]>();
  for (const change of changes) {
    if (change.reason === 'new-period' || change.previousVersionId === null)
      continue;
    // Exact record/position corrections are local dependency hints. Shared
    // originals, processing rules, geometry versions and access changes still
    // concern every matching fixed dependent; a hint cannot narrow them.
    const scope =
      change.reason === 'record-corrected' ||
      change.reason === 'position-corrected'
        ? change.scope
        : undefined;
    if (
      (change.reason === 'record-corrected' && scope?.kind !== 'records') ||
      (change.reason === 'position-corrected' && scope?.kind !== 'positions')
    )
      continue;
    for (const record of records) {
      if (
        (scope?.kind === 'records' && !scope.recordIds.includes(record.id)) ||
        (scope?.kind === 'positions' && scope.recordId !== record.id)
      )
        continue;
      const ownPositions =
        scope?.kind === 'positions'
          ? record.positions.filter((position) =>
              scope.positionIds.includes(position.id),
            )
          : record.positions;
      const own =
        record.sourceId === change.sourceId &&
        record.versionId === change.previousVersionId &&
        (scope?.kind !== 'positions' || ownPositions.length > 0) &&
        (change.reason !== 'rule-changed' ||
          change.previousProcessingVersion === undefined ||
          record.processingVersion === change.previousProcessingVersion);
      // A record's processing version does not identify the referenced geometry
      // rule. Notify every fixed source/version reference when that rule changes.
      const geometry = record.positions.filter(
        (position) =>
          position.geometrySourceId === change.sourceId &&
          position.geometryVersionId === change.previousVersionId &&
          (scope?.kind !== 'positions' ||
            scope.positionIds.includes(position.id)),
      );
      if (!own && !geometry.length) continue;
      affected.add(record.id);
      objects.add(record.objectId);
      (own ? ownPositions : geometry).forEach((position) =>
        positions.add(position.id),
      );
      record.needIds.forEach((id) => needs.add(id));
      record.regionIds.forEach((id) => regions.add(id));
      findings.set(`${record.id}\0${change.sourceId}\0${change.reason}`, {
        recordId: record.id,
        sourceId: change.sourceId,
        reason: change.reason,
      });
    }
  }
  return {
    recordIds: [...affected],
    objectIds: [...objects],
    positionIds: [...positions],
    needIds: [...needs],
    regionIds: [...regions],
    topicIds: topics
      .filter((topic) => topic.recordIds.some((id) => affected.has(id)))
      .map((topic) => topic.id),
    findings: [...findings.values()],
  };
}
