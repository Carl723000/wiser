import type {
  RegionId,
  WorkspaceRecord,
  WorkspaceTopicPackage,
} from './spatial-workspace-contract';

export type ImpactReason =
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
    for (const record of records) {
      const own =
        record.sourceId === change.sourceId &&
        record.versionId === change.previousVersionId &&
        (change.reason !== 'rule-changed' ||
          change.previousProcessingVersion === undefined ||
          record.processingVersion === change.previousProcessingVersion);
      const geometry = record.positions.filter(
        (position) =>
          position.geometrySourceId === change.sourceId &&
          position.geometryVersionId === change.previousVersionId &&
          change.reason !== 'rule-changed',
      );
      if (!own && !geometry.length) continue;
      affected.add(record.id);
      objects.add(record.objectId);
      (own ? record.positions : geometry).forEach((position) =>
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
