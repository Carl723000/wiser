import {
  readinessRecordKey,
  type ProjectReadinessInput,
  type ProjectReadinessResult,
  type ReadinessQuestion,
  type ReadinessSourceReference,
} from '@wiser/data-core/project-readiness';
import type {
  Material,
  RegionId,
  WorkspacePack,
  WorkspaceRecord,
} from './spatial-workspace-contract';
import {
  fixedSourceKey,
  materialReference,
  projectReadinessFromPack,
  type ReadinessSelection,
} from './spatial-readiness-facts';
import { workspaceDisplayPositions } from './spatial-workspace-view';

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
export type ReadinessGrain = ReadinessQuestion['drilldowns'][number]['grain'];
export interface ReadinessCounts {
  sources: number;
  versions: number;
  records: number;
  sourceObjects: number;
  geometryRecords: number;
  samplingSites: number | null;
  validObservations: number | null;
  professionallyReviewed: number;
  assets: number;
  monthlyRecords: number;
  nonMonthlyRecords: number;
  namedObjects: number | null;
}
export interface ReadinessNeed {
  id: string;
  state: NeedState;
  sourceIds: string[];
  recordIds: string[];
  missingReasons: string[];
}
export interface ReadinessDetail {
  key: string;
  grain: ReadinessGrain;
  title: string;
  sourceIds: string[];
  recordIds: string[];
  sourceRefs: ReadinessSourceReference[];
  factId?: string;
  month?: string;
  missing?: boolean;
}
export interface ReadinessResult {
  regionId: RegionId;
  counts: ReadinessCounts;
  needs: ReadinessNeed[];
  questions: {
    id: ReadinessQuestionId;
    state: ReadinessQuestion['state'];
    sourceIds: string[];
    recordIds: string[];
    detailCodes: string[];
    details: ReadinessDetail[];
  }[];
  density: {
    spatial: number | null;
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
  statuses: {
    sourceId: string;
    versionId: string;
    title: string;
    status: Material['status'];
  }[];
  project: ProjectReadinessResult;
  records: WorkspaceRecord[];
  sources: Material[];
}

const questionIds: Record<ReadinessQuestion['id'], ReadinessQuestionId> = {
  KINDS: 'inventory',
  COUNTS: 'quantity',
  QUALITY: 'quality',
  STRUCTURE: 'structure',
  DENSITY: 'density',
  GAPS: 'gaps',
  CLEANING: 'cleaning',
  QUALITY_CONTROL: 'quality-control',
  COMPUTATIONS: 'computations',
};
const unique = <T>(values: readonly T[]) => [...new Set(values)];

/** Pure local adapter; each question delegates to the same governed core rule. */
export function buildReadiness(
  pack: WorkspacePack,
  regionId: RegionId,
  staleIds: readonly string[] = [],
  facts: ProjectReadinessInput | null = null,
  selection: ReadinessSelection = {
    needId: 'K5-001',
    window: facts?.requirement.window ?? null,
    dateRole: facts?.requirement.dateRole ?? 'PUBLICATION',
  },
): ReadinessResult {
  const { project, records, sources } = projectReadinessFromPack(
    pack,
    regionId,
    staleIds,
    facts,
    selection,
  );
  const currentKeys = new Set(project.records.map(readinessRecordKey));
  const localRecord = new Map(
    project.records.map((record) => [
      readinessRecordKey(record),
      records.find((item) => item.id === record.id)!,
    ]),
  );
  const projectRecord = new Map(
    project.records.map((record) => [readinessRecordKey(record), record]),
  );
  const stale = new Set(
    staleIds.filter((id) => records.some((record) => record.id === id)),
  );
  const sourceIdsFor = (keys: readonly string[]) =>
    unique(keys.flatMap((key) => localRecord.get(key)?.sourceId ?? []));
  const localIdsFor = (keys: readonly string[]) =>
    unique(keys.flatMap((key) => localRecord.get(key)?.id ?? []));
  const detailsFor = (question: ReadinessQuestion): ReadinessDetail[] =>
    question.drilldowns.flatMap(({ grain, ids }) =>
      ids.map((key): ReadinessDetail => {
        let title = '',
          keys: readonly string[] = [],
          matchingSources: Material[] = [],
          factId: string | undefined,
          month: string | undefined,
          missing: boolean | undefined;
        if (['WORK', 'VERSION', 'ASSET'].includes(grain)) {
          matchingSources = sources.filter((source) => {
            const ref = materialReference(source);
            return grain === 'WORK'
              ? ref.workId === key
              : grain === 'VERSION'
                ? JSON.stringify([ref.workId, ref.versionId]) === key
                : fixedSourceKey(ref) === key;
          });
          title = unique(matchingSources.map((source) => source.title)).join(
            ' · ',
          );
          const refs = new Set(
            matchingSources.map((source) =>
              fixedSourceKey(materialReference(source)),
            ),
          );
          keys = project.records
            .filter((record) => refs.has(fixedSourceKey(record.source)))
            .map(readinessRecordKey);
        } else if (grain === 'RECORD') {
          title = localRecord.get(key)?.objectLabel ?? '';
          keys = currentKeys.has(key) ? [key] : [];
        } else if (grain === 'SOURCE_OBJECT') {
          keys = project.records
            .filter(
              (record) =>
                record.object &&
                JSON.stringify([
                  fixedSourceKey(record.source),
                  record.object.key,
                ]) === key,
            )
            .map(readinessRecordKey);
          title = projectRecord.get(keys[0])?.object?.originalName ?? '';
        } else if (grain === 'COVERAGE_CELL') {
          const cell = JSON.parse(key) as [string[], string];
          const row = project.monthly.raw.find(
            (item) =>
              JSON.stringify(item.objectKeys) === JSON.stringify(cell[0]),
          );
          month = cell[1];
          missing = row?.missingMonths?.includes(month) ?? false;
          title = row?.originalNames.join(' · ') ?? '';
          keys = missing
            ? (row?.recordIds ?? [])
            : (row?.recordIds.filter(
                (id) => projectRecord.get(id)?.time.value === month,
              ) ?? []);
        } else if (grain === 'FIELD') {
          const field = project.fields.find((item) => item.id === key);
          title = field?.name ?? '';
          factId = field?.id;
          keys = project.records
            .filter(
              (record) =>
                field &&
                fixedSourceKey(record.source) === fixedSourceKey(field.source),
            )
            .map(readinessRecordKey);
        } else if (
          grain === 'CHECK' ||
          grain === 'TASK' ||
          grain === 'USE_CHECK'
        ) {
          const fact =
            grain === 'CHECK'
              ? project.checks.find((item) => item.id === key)
              : grain === 'TASK'
                ? project.tasks.find((item) => item.id === key)
                : project.useChecks.find((item) => item.id === key);
          factId = fact?.id;
          if (fact) {
            keys = fact.recordIds.filter((id) => currentKeys.has(id));
            if ('sources' in fact) {
              const refs = new Set(fact.sources.map(fixedSourceKey));
              keys = unique([
                ...keys,
                ...project.records
                  .filter((record) => refs.has(fixedSourceKey(record.source)))
                  .map(readinessRecordKey),
              ]);
            }
          }
        } else if (grain === 'CORRESPONDENCE') {
          const correspondence = facts?.correspondences.find(
            (item) => item.id === key,
          );
          keys =
            correspondence?.memberRecordIds.filter((id) =>
              currentKeys.has(id),
            ) ?? [];
          title = unique(
            keys.flatMap(
              (id) => projectRecord.get(id)?.object?.originalName ?? [],
            ),
          ).join(' ↔ ');
          factId = correspondence?.id;
        }
        return {
          key,
          grain,
          title,
          recordIds: localIdsFor(keys),
          sourceIds: unique([
            ...matchingSources.map((source) => source.id),
            ...sourceIdsFor(keys),
          ]),
          sourceRefs: [
            ...new Map(
              [
                ...matchingSources.map(materialReference),
                ...keys.flatMap((id) => projectRecord.get(id)?.source ?? []),
              ].map((ref) => [fixedSourceKey(ref), ref]),
            ).values(),
          ],
          factId,
          month,
          missing,
        };
      }),
    );
  const codes: Record<ReadinessQuestionId, string[]> = {
    inventory: ['actual-materials-only'],
    quantity: ['source-object-record-separated', 'valid-observations-unknown'],
    quality: ['status-dimensions-separate'],
    structure: ['native-field-names'],
    density: [
      'reporting-not-sampling-frequency',
      'spatial-denominator-unknown',
    ],
    gaps: ['need-slots-not-datasets'],
    cleaning: project.tasks.some((task) => task.kind === 'CLEANING')
      ? []
      : ['task-record-not-present'],
    'quality-control': project.tasks.some(
      (task) => task.kind === 'QUALITY_CONTROL',
    )
      ? []
      : ['task-record-not-present'],
    computations: project.useChecks.length
      ? ['use-conditions-required']
      : ['use-check-not-present'],
  };
  const questions = project.questions.map((question) => {
    const id = questionIds[question.id],
      details = detailsFor(question);
    return {
      id,
      state: question.state,
      details,
      sourceIds: unique(details.flatMap((detail) => detail.sourceIds)),
      recordIds: unique(details.flatMap((detail) => detail.recordIds)),
      detailCodes: codes[id],
    };
  });
  const inRegion = (ids: readonly RegionId[]) =>
    regionId === 'bth' || ids.includes(regionId);
  const readableRecords = pack.records.filter(
    (record) =>
      record.reviewStatus === 'pending' &&
      inRegion(record.regionIds) &&
      pack.sources.some(
        (source) =>
          source.id === record.sourceId &&
          source.versionId === record.versionId &&
          source.rights.displayAllowed,
      ),
  );
  const needs = NEED_IDS.map((id): ReadinessNeed => {
    const matchingSources = pack.sources.filter(
      (source) => inRegion(source.regionIds) && source.needIds.includes(id),
    );
    const matchingRecords = readableRecords.filter((record) =>
      record.needIds.includes(id),
    );
    return {
      id,
      state: matchingRecords.some((record) => staleIds.includes(record.id))
        ? 'stale'
        : matchingSources.length &&
            matchingSources.every((source) => !source.rights.displayAllowed)
          ? 'restricted'
          : matchingSources.length || matchingRecords.length
            ? 'partial'
            : 'not-obtained',
      sourceIds: unique(matchingSources.map((source) => source.id)),
      recordIds: matchingRecords.map((record) => record.id),
      missingReasons: unique(
        matchingRecords.flatMap((record) => record.missingReasons),
      ).concat(
        matchingSources.length || matchingRecords.length
          ? []
          : ['material-not-obtained'],
      ),
    };
  });
  const usable = records.filter((record) => !stale.has(record.id));
  const factById = new Map(
    project.records.map((record) => [record.id, record]),
  );
  const category = usable.filter((record) => {
    const fact = factById.get(record.id);
    return (
      fact?.metric?.kind === 'CATEGORY' &&
      fact.time.role === 'PUBLICATION' &&
      fact.time.precision === 'MONTH'
    );
  });
  const report = usable.filter((record) =>
    sources.some(
      (source) =>
        source.id === record.sourceId &&
        source.versionId === record.versionId &&
        source.kind === 'report',
    ),
  );
  const mapRecords = usable.filter(
    (record) => factById.get(record.id)?.spatial?.state === 'LOCATED',
  );
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
  return {
    regionId,
    project,
    records,
    sources,
    needs,
    questions,
    uses,
    counts: {
      sources: project.counts.works,
      versions: project.counts.versions,
      records: project.counts.records,
      sourceObjects: project.counts.sourceObjects,
      geometryRecords: unique(
        records.flatMap((record) =>
          workspaceDisplayPositions(pack, record).map((position) =>
            JSON.stringify([
              position.geometrySourceId,
              position.geometryVersionId,
              position.locator,
            ]),
          ),
        ),
      ).length,
      samplingSites: null,
      validObservations: project.counts.independentObservations,
      professionallyReviewed: sources.filter(
        (source) => source.status.professionalReview === 'approved',
      ).length,
      assets: project.counts.assets,
      monthlyRecords: project.counts.monthlyRecords,
      nonMonthlyRecords: project.counts.nonMonthlyRecords,
      namedObjects: project.monthly.namedObjectCount,
    },
    density: {
      spatial: project.density.observationsPerKm2,
      reportWindows: unique(
        project.monthly.raw.flatMap((row) => row.observedMonths),
      ).sort(),
      missingReportWindows: unique(
        project.monthly.raw.flatMap((row) => row.missingMonths ?? []),
      ).sort(),
      frequency:
        project.monthly.raw.length && selection.dateRole === 'PUBLICATION'
          ? 'monthly-publication'
          : 'mixed-or-unknown',
    },
    staleRecordIds: [...stale],
    fields: unique(sources.flatMap((source) => source.fieldNames ?? [])),
    statuses: sources.map((source) => ({
      sourceId: source.id,
      versionId: source.versionId,
      title: source.title,
      status: { ...source.status },
    })),
  };
}
