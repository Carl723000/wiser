import type {
  Material,
  RegionId,
  WorkspacePack,
  WorkspacePosition,
  WorkspaceRecord,
} from './spatial-workspace-contract';

export const NEED_IDS = Array.from(
  { length: 19 },
  (_, index) => `K5-${String(index + 1).padStart(3, '0')}`,
);
export type NeedState = 'not-obtained' | 'partial' | 'restricted' | 'stale';
export type ReadinessQuestionId =
  | 'inventory'
  | 'quantity'
  | 'quality'
  | 'structure'
  | 'density'
  | 'gaps'
  | 'cleaning'
  | 'quality-control'
  | 'computations';
export type UseId =
  | 'archive'
  | 'monthly-category'
  | 'report-summary'
  | 'reference-map'
  | 'concentration-trend'
  | 'pollution-load';
export interface ReadinessCounts {
  sources: number;
  versions: number;
  records: number;
  sourceObjects: number;
  geometryRecords: number;
  samplingSites: number | null;
  validObservations: number | null;
  professionallyReviewed: number;
}
export interface ReadinessNeed {
  id: string;
  state: NeedState;
  sourceIds: string[];
  recordIds: string[];
  missingReasons: string[];
}
export interface ReadinessResult {
  regionId: RegionId;
  counts: ReadinessCounts;
  needs: ReadinessNeed[];
  questions: {
    id: ReadinessQuestionId;
    sourceIds: string[];
    recordIds: string[];
    detailCodes: string[];
  }[];
  density: {
    spatial: null;
    reportWindows: string[];
    missingReportWindows: string[];
    frequency: 'monthly-publication' | 'mixed-or-unknown';
  };
  uses: {
    id: UseId;
    eligible: boolean;
    recordIds: string[];
    reasons: string[];
  }[];
  staleRecordIds: string[];
  fields: string[];
  statuses: { sourceId: string; status: Material['status'] }[];
}

function inRegion(ids: readonly RegionId[], regionId: RegionId) {
  return regionId === 'bth' || ids.includes(regionId);
}
function mapped(position: WorkspacePosition) {
  return (
    position.role !== 'institution-address' &&
    position.role !== 'mention' &&
    position.match === 'bound' &&
    position.geometry !== null &&
    position.crs === 'EPSG:4326' &&
    position.geometrySourceId !== null &&
    position.geometryVersionId !== null &&
    position.locator !== null
  );
}
function windows(records: WorkspaceRecord[]) {
  const reportWindows = [
    ...new Set(
      records
        .filter(
          (record) =>
            record.time.role === 'observation' &&
            record.time.precision === 'month' &&
            /^\d{4}-(0[1-9]|1[0-2])$/.test(record.time.start ?? ''),
        )
        .map((record) => record.time.start!),
    ),
  ].sort();
  const missingReportWindows: string[] = [];
  if (reportWindows.length > 1) {
    const index = (value: string) =>
      Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
    const first = index(reportWindows[0]);
    const last = index(reportWindows.at(-1)!);
    const present = new Set(reportWindows);
    // Bound malformed or unexpectedly long windows; never expand an unbounded time series.
    if (last - first <= 1200)
      for (let month = first + 1; month < last; month++) {
        const label = `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}`;
        if (!present.has(label)) missingReportWindows.push(label);
      }
  }
  return {
    spatial: null,
    reportWindows,
    missingReportWindows,
    frequency: reportWindows.length
      ? ('monthly-publication' as const)
      : ('mixed-or-unknown' as const),
  };
}

/** Six scopes share one union; record quantities are never observation density. */
export function buildReadiness(
  pack: WorkspacePack,
  regionId: RegionId,
  staleIds: readonly string[] = [],
): ReadinessResult {
  const records = [
    ...new Map(
      pack.records
        .filter(
          (record) =>
            record.reviewStatus === 'pending' &&
            inRegion(record.regionIds, regionId),
        )
        .map((record) => [record.id, record]),
    ).values(),
  ];
  const referenced = new Set(records.map((record) => record.sourceId));
  const sources = pack.sources.filter(
    (source) =>
      inRegion(source.regionIds, regionId) || referenced.has(source.id),
  );
  const byId = new Map(pack.sources.map((source) => [source.id, source]));
  const canonical = (source: Material) => {
    const visited = new Set<string>();
    let current = source;
    while (
      current.duplicateOf &&
      byId.has(current.duplicateOf) &&
      !visited.has(current.id)
    ) {
      visited.add(current.id);
      current = byId.get(current.duplicateOf)!;
    }
    return current;
  };
  const originals = [
    ...new Map(
      sources.map((source) => {
        const original = canonical(source);
        return [`${original.id}\0${original.versionId}`, original] as const;
      }),
    ).values(),
  ];
  const stale = new Set(
    staleIds.filter((id) => records.some((record) => record.id === id)),
  );
  const usable = records.filter(
    (record) =>
      !stale.has(record.id) &&
      byId.get(record.sourceId)?.rights.displayAllowed === true,
  );
  const geometry = new Set(
    records.flatMap((record) =>
      record.positions
        .filter(mapped)
        .map(
          (position) =>
            `${position.geometrySourceId}\0${position.geometryVersionId}\0${position.locator}`,
        ),
    ),
  );
  const counts: ReadinessCounts = {
    sources: new Set(originals.map((source) => source.workId ?? source.id))
      .size,
    versions: originals.length,
    records: records.length,
    sourceObjects: new Set(
      records.map((record) => `${record.sourceId}\0${record.objectId}`),
    ).size,
    geometryRecords: geometry.size,
    samplingSites: null,
    validObservations: null,
    professionallyReviewed: originals.filter(
      (source) => source.status.professionalReview === 'approved',
    ).length,
  };
  const needs = NEED_IDS.map((id): ReadinessNeed => {
    const matchingSources = sources.filter((source) =>
      source.needIds.includes(id),
    );
    const matchingRecords = records.filter((record) =>
      record.needIds.includes(id),
    );
    return {
      id,
      state: matchingRecords.some((record) => stale.has(record.id))
        ? 'stale'
        : matchingSources.length &&
            matchingSources.every((source) => !source.rights.displayAllowed)
          ? 'restricted'
          : matchingSources.length || matchingRecords.length
            ? 'partial'
            : 'not-obtained',
      sourceIds: [
        ...new Set(matchingSources.map((source) => canonical(source).id)),
      ],
      recordIds: matchingRecords.map((record) => record.id),
      missingReasons: [
        ...new Set(matchingRecords.flatMap((record) => record.missingReasons)),
      ].concat(
        matchingSources.length || matchingRecords.length
          ? []
          : ['material-not-obtained'],
      ),
    };
  });
  const category = usable.filter(
    (record) =>
      record.time.role === 'observation' &&
      record.time.precision === 'month' &&
      record.value !== null &&
      /水质类别/.test(record.metric) &&
      ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', '劣Ⅴ'].includes(
        record.value.replace(/\s+/g, ''),
      ),
  );
  const report = usable.filter(
    (record) => byId.get(record.sourceId)?.kind === 'report',
  );
  const mapRecords = usable.filter((record) => record.positions.some(mapped));
  const uses: ReadinessResult['uses'] = [
    {
      id: 'archive',
      eligible: usable.length > 0,
      recordIds: usable.map((record) => record.id),
      reasons: ['source-and-version-required'],
    },
    {
      id: 'monthly-category',
      eligible: category.length > 0,
      recordIds: category.map((record) => record.id),
      reasons: ['published-category-only', 'sampling-frequency-unknown'],
    },
    {
      id: 'report-summary',
      eligible: report.length > 0,
      recordIds: report.map((record) => record.id),
      reasons: ['reported-scope-only', 'publication-year-distinct'],
    },
    {
      id: 'reference-map',
      eligible: mapRecords.length > 0,
      recordIds: mapRecords.map((record) => record.id),
      reasons: ['reference-not-sampling', 'native-scale-retained'],
    },
    {
      id: 'concentration-trend',
      eligible: false,
      recordIds: [],
      reasons: ['concentration-method-time-series-missing'],
    },
    {
      id: 'pollution-load',
      eligible: false,
      recordIds: [],
      reasons: ['concentration-flow-window-missing'],
    },
  ];
  if (stale.size) uses.forEach((use) => use.reasons.push('some-records-stale'));
  const allSources = originals.map((source) => source.id);
  const allRecords = records.map((record) => record.id);
  const questionCodes: Record<ReadinessQuestionId, string[]> = {
    inventory: ['actual-materials-only'],
    quantity: ['source-object-record-separated', 'valid-observations-unknown'],
    quality: ['status-dimensions-separate', 'professional-review-pending'],
    structure: ['native-field-names'],
    density: [
      'reporting-not-sampling-frequency',
      'spatial-denominator-unknown',
    ],
    gaps: ['need-slots-not-datasets'],
    cleaning: ['local-deterministic-processing'],
    'quality-control': ['hash-cell-check', 'professional-review-not-performed'],
    computations: ['use-conditions-required'],
  };
  return {
    regionId,
    counts,
    needs,
    questions: (Object.keys(questionCodes) as ReadinessQuestionId[]).map(
      (id) => ({
        id,
        sourceIds: allSources,
        recordIds: allRecords,
        detailCodes: questionCodes[id],
      }),
    ),
    density: windows(records),
    uses,
    staleRecordIds: [...stale],
    fields: [...new Set(sources.flatMap((source) => source.fieldNames ?? []))],
    statuses: originals.map((source) => ({
      sourceId: source.id,
      status: { ...source.status },
    })),
  };
}
