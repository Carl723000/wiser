import {
  calculateProjectReadiness,
  readinessRecordKey,
  type ProjectReadinessInput,
  type ProjectReadinessRecord,
  type ProjectReadinessResult,
  type ProjectReadinessTrack,
  type ReadinessEvidence,
  type ReadinessFactScope,
  type ReadinessSourceReference,
} from '@wiser/data-core/project-readiness';
import type {
  Material,
  RegionId,
  WorkspacePack,
  WorkspaceRecord,
} from './spatial-workspace-contract';
import { workspaceDisplayPositions } from './spatial-workspace-view';

export interface ReadinessSelection {
  track?: ProjectReadinessTrack;
  needId: string;
  window: { start: string; end: string } | null;
  dateRole: 'PUBLICATION' | 'OBSERVATION' | 'EVENT';
}

export const fixedSourceKey = (source: ReadinessSourceReference) =>
  JSON.stringify([source.workId, source.versionId, source.assetId]);

export function materialReference(source: Material): ReadinessSourceReference {
  return {
    workId: source.workId ?? source.id,
    versionId: source.versionId,
    assetId: `sha256:${source.originalSha256}`,
  };
}

function canonicalMaterial(
  source: Material,
  sources: readonly Material[],
): Material {
  const seen = new Set<string>();
  let current = source;
  while (current.duplicateOf && !seen.has(current.id)) {
    seen.add(current.id);
    const original = sources.find(
      (item) =>
        item.id === current.duplicateOf &&
        item.versionId === current.versionId &&
        item.originalSha256 === current.originalSha256 &&
        item.rights.displayAllowed,
    );
    if (!original) break;
    current = original;
  }
  return current;
}

function sourceParsingState(
  source: Material,
): ProjectReadinessRecord['parsing'] {
  switch (source.status.parsed) {
    case 'ready':
    case 'table-complete':
    case 'geometry-complete':
      return 'READY';
    case 'partial':
      return 'PARTIAL';
    case 'failed':
      return 'FAILED';
    default:
      return 'NOT_PARSED';
  }
}

/** Rebind every evidence carrier to the current display scope, never a saved permission snapshot. */
function currentReadinessFacts(
  facts: ProjectReadinessInput,
  sources: ReadonlySet<string>,
  records: ReadonlySet<string>,
): ProjectReadinessInput {
  const sourceAllowed = (source: ReadinessSourceReference) =>
    sources.has(fixedSourceKey(source));
  const evidenceAllowed = (items: readonly ReadinessEvidence[]) =>
    items.every((item) => sourceAllowed(item.source));
  const recordsAllowed = (ids: readonly string[]) =>
    ids.every((id) => records.has(id));
  const scopeAllowed = (scope: ReadinessFactScope) =>
    scope.recordIds.length + scope.sources.length > 0 &&
    recordsAllowed(scope.recordIds) &&
    scope.sources.every(sourceAllowed);
  const series = facts.series
    .filter((item) => evidenceAllowed(item.evidence))
    .map((item) => ({ ...item, sources: item.sources.filter(sourceAllowed) }))
    .filter((item) => item.sources.length > 0);
  // Existing detail consumers find the first raw correspondence by ID. A later
  // permitted duplicate must not revive that first object's withdrawn evidence.
  const firstCorrespondence = new Map<
    string,
    ProjectReadinessInput['correspondences'][number]
  >();
  for (const item of facts.correspondences) {
    if (!firstCorrespondence.has(item.id))
      firstCorrespondence.set(item.id, item);
  }
  const selectedReconciliation = facts.reconciliations?.find(
    (item) => item.id === facts.selectedReconciliationId,
  );
  const reconciliations = facts.reconciliations?.filter(
    (item) =>
      item.recordIds.length > 0 &&
      recordsAllowed(item.recordIds) &&
      evidenceAllowed(item.evidence),
  );
  return {
    ...facts,
    sources: facts.sources.filter(sourceAllowed),
    records: facts.records
      .filter(
        (item) =>
          records.has(readinessRecordKey(item)) &&
          sourceAllowed(item.source) &&
          evidenceAllowed(item.evidence) &&
          evidenceAllowed(item.object?.footnotes ?? []),
      )
      .map((item) => ({
        ...item,
        series: series.some(
          (declaration) =>
            declaration.id === item.series?.id &&
            declaration.version === item.series.version &&
            declaration.sources.some(
              (source) =>
                fixedSourceKey(source) === fixedSourceKey(item.source),
            ),
        )
          ? item.series
          : null,
      })),
    series,
    correspondences: facts.correspondences.filter(
      (item) =>
        firstCorrespondence.get(item.id) === item &&
        item.memberRecordIds.length > 0 &&
        recordsAllowed(item.memberRecordIds) &&
        evidenceAllowed(item.evidence),
    ),
    checks: facts.checks?.filter(
      (item) => scopeAllowed(item) && evidenceAllowed(item.evidence),
    ),
    fields: facts.fields?.filter(
      (item) => sourceAllowed(item.source) && evidenceAllowed(item.evidence),
    ),
    tasks: facts.tasks?.filter(
      (item) => scopeAllowed(item) && evidenceAllowed(item.evidence),
    ),
    useChecks: facts.useChecks?.filter(
      (item) =>
        item.recordIds.length > 0 &&
        recordsAllowed(item.recordIds) &&
        evidenceAllowed(item.evidence),
    ),
    reconciliations,
    selectedReconciliationId:
      selectedReconciliation &&
      reconciliations?.includes(selectedReconciliation)
        ? selectedReconciliation.id
        : undefined,
    areaDenominator:
      facts.areaDenominator &&
      recordsAllowed(facts.areaDenominator.recordIds) &&
      evidenceAllowed(facts.areaDenominator.evidence)
        ? facts.areaDenominator
        : undefined,
  };
}

/** Same-system, readonly adapter. It does not authorize or publish any record. */
export function projectReadinessFromPack(
  pack: WorkspacePack,
  regionId: RegionId,
  staleIds: readonly string[],
  facts: ProjectReadinessInput | null,
  selection: ReadinessSelection,
): {
  project: ProjectReadinessResult;
  records: WorkspaceRecord[];
  sources: Material[];
} {
  const track = selection.track ?? 'REAL';
  facts = facts?.track === track ? facts : null;
  const inRegion = (ids: readonly string[]) =>
    regionId === 'bth' || ids.includes(regionId);
  const readable = pack.sources.filter(
    (source) =>
      source.rights.displayAllowed && (source.track ?? 'REAL') === track,
  );
  const sourceFor = (record: WorkspaceRecord) =>
    readable.find(
      (source) =>
        source.id === record.sourceId && source.versionId === record.versionId,
    );
  const realRecords = [
    ...new Map(
      pack.records
        .filter(
          (record) =>
            sourceFor(record) &&
            (record.track ?? 'REAL') === track &&
            (record.reviewStatus !== 'synthetic-reviewed' ||
              (track === 'SYNTHETIC' && record.track === 'SYNTHETIC')),
        )
        .map((record) => [record.id, record]),
    ).values(),
  ];
  const sourceMap = new Map(
    readable.map((source) => {
      const canonical = canonicalMaterial(source, readable);
      return [fixedSourceKey(materialReference(canonical)), canonical] as const;
    }),
  );
  // Read permission covers the supplied pack, while the core separately owns
  // need/region calculation scope. A readable cross-scope witness may explain
  // UNKNOWN; it must not become scoped observations or a passed check.
  const currentSources = new Set(sourceMap.keys());
  const currentRecords = new Set(
    realRecords
      .map((record) => ({
        id: record.id,
        source: materialReference(
          canonicalMaterial(sourceFor(record)!, readable),
        ),
      }))
      .map(readinessRecordKey),
  );
  facts = facts
    ? currentReadinessFacts(facts, currentSources, currentRecords)
    : null;
  const stale = new Set(staleIds);
  const evidence = (
    record: WorkspaceRecord,
    reference: ReadinessSourceReference,
  ) =>
    record.evidence.map((item) => ({
      source: reference,
      locator: item.locator,
      excerpt: item.text,
    }));
  const adapted: ProjectReadinessRecord[] = realRecords.map((record) => {
    const recordSource = sourceFor(record)!;
    const source = canonicalMaterial(recordSource, readable);
    const reference = materialReference(source);
    const fact =
      facts?.track === track
        ? facts.records.find(
            (item) =>
              item.id === record.id &&
              fixedSourceKey(item.source) === fixedSourceKey(reference) &&
              item.rawValue === record.value &&
              item.object?.key === record.objectId &&
              item.object.originalName === record.objectLabel &&
              item.metric?.code === record.metric &&
              item.metric.unit === record.unit,
          )
        : undefined;
    const positions = workspaceDisplayPositions(pack, record);
    const position = positions[0];
    const spatial: ProjectReadinessRecord['spatial'] = position
      ? {
          state: 'LOCATED',
          role: position.role,
          geometryKey: JSON.stringify([
            position.geometrySourceId,
            position.geometryVersionId,
            position.locator,
          ]),
          geometryKind: position.geometry!.type.includes('Point')
            ? 'POINT'
            : position.geometry!.type.includes('Line')
              ? 'LINE'
              : position.geometry!.type.includes('Polygon')
                ? 'AREA'
                : 'MIXED',
        }
      : {
          state: record.positions.length ? 'NAMED_ONLY' : 'UNKNOWN',
          role: record.positions[0]?.role ?? null,
          geometryKey: null,
          geometryKind: null,
        };
    const raw: ProjectReadinessRecord = {
      id: record.id,
      source: reference,
      needIds: record.needIds,
      regionIds: [...new Set(['bth', ...record.regionIds])],
      object: {
        key: record.objectId,
        originalName: record.objectLabel,
        markers: [],
        footnotes: [],
      },
      series: null,
      time: {
        value: record.time.start,
        role:
          record.time.role === 'publication'
            ? 'PUBLICATION'
            : record.time.role === 'observation'
              ? 'OBSERVATION'
              : record.time.role === 'event'
                ? 'EVENT'
                : 'UNKNOWN',
        precision:
          record.time.precision === 'month'
            ? 'MONTH'
            : record.time.precision === 'day'
              ? 'DAY'
              : record.time.precision === 'year'
                ? 'YEAR'
                : 'UNKNOWN',
      },
      rawValue: record.value,
      // Undeclared measurement types are not inferred from labels or numeric values.
      metric: {
        code: record.metric,
        kind: 'OTHER',
        unit: record.unit,
        method: record.method?.code ?? null,
      },
      parsing: sourceParsingState(recordSource),
      professionalState:
        track === 'SYNTHETIC' &&
        record.track === 'SYNTHETIC' &&
        source.track === 'SYNTHETIC' &&
        record.reviewStatus === 'synthetic-reviewed' &&
        fact?.professionalState === 'APPROVED'
          ? 'APPROVED'
          : 'PENDING_REVIEW',
      evidence: evidence(record, reference),
      spatial,
    };
    const current = fact
      ? {
          ...fact,
          source: reference,
          needIds: raw.needIds,
          regionIds: raw.regionIds,
          professionalState: raw.professionalState,
          spatial,
        }
      : raw;
    return stale.has(record.id)
      ? { ...current, parsing: 'PARTIAL', series: null }
      : current;
  });
  const input: ProjectReadinessInput = {
    track,
    requirement: {
      needId: selection.needId,
      regionId,
      version:
        facts?.requirement.version ??
        `local-inspection:${pack.processingVersion}`,
      purpose: facts?.requirement.purpose ?? 'source-evidence-inspection',
      dateRole: selection.dateRole,
      window: selection.window,
    },
    sources: [...sourceMap.entries()].map(([key, source]) => ({
      ...materialReference(source),
      track,
      kind:
        facts?.sources.find((item) => fixedSourceKey(item) === key)?.kind ??
        (source.kind === 'spatial'
          ? 'VECTOR'
          : source.kind === 'raster'
            ? 'RASTER'
            : 'DOCUMENT'),
      needIds: source.needIds,
      regionIds: [...new Set(['bth', ...source.regionIds])],
    })),
    records: adapted,
    series: facts?.series ?? [],
    correspondences: facts?.correspondences ?? [],
    checks: facts?.checks ?? [],
    fields: facts?.fields ?? [],
    tasks: facts?.tasks ?? [],
    useChecks: facts?.useChecks ?? [],
    reconciliations: facts?.reconciliations ?? [],
    selectedReconciliationId: facts?.selectedReconciliationId,
    areaDenominator: facts?.areaDenominator,
  };
  const project = calculateProjectReadiness(input);
  const keys = new Set(project.records.map(readinessRecordKey));
  const records = realRecords.filter((record) => {
    const source = canonicalMaterial(sourceFor(record)!, readable);
    return keys.has(
      readinessRecordKey({
        id: record.id,
        source: materialReference(source),
      }),
    );
  });
  const referenced = new Set(
    records.map((record) =>
      fixedSourceKey(
        materialReference(canonicalMaterial(sourceFor(record)!, readable)),
      ),
    ),
  );
  const sources = [...sourceMap.values()].filter(
    (source) =>
      (inRegion(source.regionIds) &&
        source.needIds.includes(selection.needId)) ||
      referenced.has(fixedSourceKey(materialReference(source))),
  );
  return { project, records, sources };
}
