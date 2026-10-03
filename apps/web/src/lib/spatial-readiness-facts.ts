import {
  calculateProjectReadiness,
  readinessRecordKey,
  type ProjectReadinessInput,
  type ProjectReadinessRecord,
  type ProjectReadinessResult,
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
  facts = facts?.track === 'REAL' ? facts : null;
  const inRegion = (ids: readonly string[]) =>
    regionId === 'bth' || ids.includes(regionId);
  const readable = pack.sources.filter(
    (source) => source.rights.displayAllowed,
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
          (record) => record.reviewStatus === 'pending' && sourceFor(record),
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
    const source = canonicalMaterial(sourceFor(record)!, readable);
    const reference = materialReference(source);
    const fact =
      facts?.track === 'REAL'
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
      parsing: record.evidence.length ? 'READY' : 'NOT_PARSED',
      professionalState: 'PENDING_REVIEW',
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
    track: 'REAL',
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
      track: 'REAL',
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
