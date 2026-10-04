import type { ProjectReadinessInput } from '@wiser/data-core/project-readiness';
import {
  buildReadiness,
  NEED_IDS,
  type ReadinessResult,
} from './spatial-readiness';
import type { ReadinessSelection } from './spatial-readiness-facts';
import type {
  Material,
  RegionId,
  WorkspacePack,
} from './spatial-workspace-contract';
import { validWorkspaceTimeFilter } from './spatial-workspace-view';

export const MATRIX_REGIONS: readonly RegionId[] = [
  'bth',
  'yongding',
  'chaobai',
  'beiyun',
  'daqing-baiyangdian',
  'bohai',
];
export type MatrixAxis = 'obtained' | 'parsed' | 'professional' | 'authorized';
export type MatrixAxisState =
  'KNOWN' | 'PARTIAL' | 'UNKNOWN' | 'PENDING_REVIEW';
export interface ReadinessMatrixCell {
  regionId: RegionId;
  needId: string;
  counts: ReadinessResult['counts'];
  sourceIds: readonly string[];
  recordIds: readonly string[];
  windowRecordIds: readonly string[];
  unknownTimeRecordIds: readonly string[];
  axes: Record<MatrixAxis, { state: MatrixAxisState; count: number | null }>;
  uses: ReadinessResult['uses'];
  missingReasons: readonly string[];
  ruleVersion: string;
}
export interface ReadinessMatrix {
  cells: readonly ReadinessMatrixCell[];
  totals: Pick<ReadinessResult['counts'], 'sources' | 'records'>;
  track: 'REAL' | 'SYNTHETIC';
}

/** A readonly overview. Each cell reuses the same scoped core rules as its drilldown. */
export function buildReadinessMatrix(
  pack: WorkspacePack,
  staleIds: readonly string[] = [],
  facts: ProjectReadinessInput | null = null,
  selection: Omit<ReadinessSelection, 'needId'> = {
    window: null,
    dateRole: 'PUBLICATION',
  },
): ReadinessMatrix {
  const track = selection.track ?? 'REAL';
  const visible = pack.sources.filter(
    (source) =>
      source.rights.displayAllowed && (source.track ?? 'REAL') === track,
  );
  const sourceKeys = new Set(
    visible.map((source) => JSON.stringify([source.id, source.versionId])),
  );
  const visibleRecords = pack.records.filter(
    (record) =>
      sourceKeys.has(JSON.stringify([record.sourceId, record.versionId])) &&
      (record.track ?? 'REAL') === track &&
      (record.reviewStatus !== 'synthetic-reviewed' || track === 'SYNTHETIC'),
  );
  const readablePack = { ...pack, sources: visible, records: visibleRecords };
  const resultFor = (regionId: RegionId, needId: string) => {
    const matching = (ids: readonly string[]) =>
      regionId === 'bth' || ids.includes(regionId);
    const sources = visible.filter(
      (source) => source.needIds.includes(needId) && matching(source.regionIds),
    );
    const keys = new Set(
      sources.map((source) => JSON.stringify([source.id, source.versionId])),
    );
    const records = visibleRecords.filter(
      (record) =>
        record.needIds.includes(needId) &&
        matching(record.regionIds) &&
        keys.has(JSON.stringify([record.sourceId, record.versionId])),
    );
    return buildReadiness(
      { ...readablePack, sources, records },
      regionId,
      staleIds,
      facts,
      { ...selection, needId },
    );
  };
  const cells = MATRIX_REGIONS.flatMap((regionId) =>
    NEED_IDS.map((needId): ReadinessMatrixCell => {
      const result = resultFor(regionId, needId);
      // Inspect source-level facts even when the selected month has no parsed row.
      const uniqueSources = result.sources;
      const known = (predicate: (source: Material) => boolean) =>
        uniqueSources.filter(predicate).length;
      const axis = (
        count: number,
        total: number,
        pending = false,
      ): ReadinessMatrixCell['axes'][MatrixAxis] =>
        total === 0
          ? { state: 'UNKNOWN', count: null }
          : {
              state:
                count === total
                  ? 'KNOWN'
                  : pending
                    ? 'PENDING_REVIEW'
                    : count > 0
                      ? 'PARTIAL'
                      : 'UNKNOWN',
              count,
            };
      const obtained = known((source) => source.status.original === 'obtained');
      const completeParsed = known((source) =>
        ['table-complete', 'geometry-complete', 'ready'].includes(
          source.status.parsed,
        ),
      );
      const partialParsed = known(
        (source) => source.status.parsed === 'partial',
      );
      const professional = result.counts.professionallyReviewed;
      return {
        regionId,
        needId,
        counts: result.counts,
        sourceIds: uniqueSources.map((source) => source.id),
        recordIds: result.records.map((record) => record.id),
        windowRecordIds: result.project.records
          .filter((record) => {
            if (
              record.time.role !== selection.dateRole ||
              record.time.value === null
            )
              return false;
            const form =
              record.time.precision === 'MONTH'
                ? /^\d{4}-\d{2}$/
                : record.time.precision === 'DAY'
                  ? /^\d{4}-\d{2}-\d{2}$/
                  : null;
            if (
              !form?.test(record.time.value) ||
              !validWorkspaceTimeFilter(record.time.value, record.time.value)
            )
              return false;
            const month = record.time.value.slice(0, 7);
            return (
              !selection.window ||
              (month >= selection.window.start && month <= selection.window.end)
            );
          })
          .map((record) => record.id),
        unknownTimeRecordIds: result.project.records
          .filter(
            (record) =>
              record.time.role === 'UNKNOWN' ||
              record.time.value === null ||
              record.time.precision === 'UNKNOWN',
          )
          .map((record) => record.id),
        axes: {
          obtained: axis(obtained, uniqueSources.length),
          parsed:
            partialParsed > 0 && completeParsed < uniqueSources.length
              ? { state: 'PARTIAL', count: completeParsed }
              : axis(completeParsed, uniqueSources.length),
          professional: axis(
            professional,
            uniqueSources.length,
            uniqueSources.some(
              (source) => source.status.professionalReview === 'pending',
            ) ||
              result.project.records.some(
                (record) => record.professionalState === 'PENDING_REVIEW',
              ),
          ),
          authorized: axis(uniqueSources.length, uniqueSources.length),
        },
        uses: result.uses,
        missingReasons:
          result.needs.find((need) => need.id === needId)?.missingReasons ?? [],
        ruleVersion: result.project.ruleVersion,
      };
    }),
  );
  // Global records are a set, not the sum of overlapping regional cells.
  const visibleKeys = new Set(cells.flatMap((cell) => cell.recordIds));
  const represented = visibleRecords.filter((record) =>
    visibleKeys.has(record.id),
  );
  const representedSources = new Set(cells.flatMap((cell) => cell.sourceIds));
  const unionSources = new Set(
    visible
      .filter((source) => representedSources.has(source.id))
      .map((source) => source.workId ?? source.id),
  );
  return {
    cells,
    track,
    totals: {
      records: represented.length,
      sources: unionSources.size,
    },
  };
}
