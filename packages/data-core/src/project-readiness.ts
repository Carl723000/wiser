import { DataFoundationDomainError } from './domain-error.js';

export type ProjectReadinessTrack = 'REAL' | 'SYNTHETIC';
export interface ReadinessSourceReference {
  readonly workId: string;
  readonly versionId: string;
  readonly assetId: string;
}
export interface ReadinessEvidence {
  readonly source: ReadinessSourceReference;
  readonly locator: string;
  readonly excerpt: string;
}
export interface ProjectReadinessSource extends ReadinessSourceReference {
  readonly track: ProjectReadinessTrack;
  readonly kind:
    'MONTHLY_REPORT' | 'TABLE' | 'DOCUMENT' | 'VECTOR' | 'RASTER' | 'DIRECTORY';
  readonly needIds: readonly string[];
  readonly regionIds: readonly string[];
}
export type ReadinessReviewState =
  'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'REQUIRES_CORRECTION';
export interface ProjectReadinessRecord {
  readonly id: string;
  readonly source: ReadinessSourceReference;
  readonly needIds: readonly string[];
  readonly regionIds: readonly string[];
  readonly object: {
    readonly key: string;
    readonly originalName: string;
    readonly markers: readonly string[];
    readonly footnotes: readonly ReadinessEvidence[];
  } | null;
  readonly series: { readonly id: string; readonly version: string } | null;
  readonly time: {
    readonly value: string | null;
    readonly role: 'PUBLICATION' | 'OBSERVATION' | 'EVENT' | 'UNKNOWN';
    readonly precision: 'MONTH' | 'DAY' | 'YEAR' | 'UNKNOWN';
  };
  readonly rawValue: string | number | null;
  readonly metric: {
    readonly code: string;
    readonly kind: 'CATEGORY' | 'CONCENTRATION' | 'FLOW' | 'OTHER';
    readonly unit: string | null;
    readonly method: string | null;
  } | null;
  readonly parsing: 'READY' | 'PARTIAL' | 'NOT_PARSED' | 'FAILED';
  readonly professionalState: ReadinessReviewState;
  readonly evidence: readonly ReadinessEvidence[];
  readonly spatial: {
    readonly state: 'LOCATED' | 'NAMED_ONLY' | 'UNKNOWN';
    readonly role: string | null;
    readonly geometryKey: string | null;
    readonly geometryKind: 'POINT' | 'LINE' | 'AREA' | 'MIXED' | null;
  } | null;
}
export interface ReadinessPublicationSeries {
  readonly id: string;
  readonly version: string;
  readonly sources: readonly ReadinessSourceReference[];
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessCorrespondence {
  readonly id: string;
  readonly memberRecordIds: readonly string[];
  readonly status: ReadinessReviewState;
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessFactScope {
  readonly recordIds: readonly string[];
  readonly sources: readonly ReadinessSourceReference[];
}
export interface ReadinessCheck extends ReadinessFactScope {
  readonly id: string;
  readonly kind:
    'INTEGRITY' | 'PARSING' | 'UNITS' | 'POSITION' | 'PURPOSE' | 'DUPLICATES';
  readonly state: 'PASSED' | 'FAILED' | 'PENDING' | 'UNKNOWN';
  readonly findings: readonly string[];
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessField {
  readonly id: string;
  readonly source: ReadinessSourceReference;
  readonly name: string;
  readonly type: string;
  readonly unit: string | null;
  readonly timeRole: string | null;
  readonly positionRole: string | null;
  readonly primaryKey: boolean | null;
  readonly formatVersion: string | null;
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessProcessingTask extends ReadinessFactScope {
  readonly id: string;
  readonly kind: 'CLEANING' | 'QUALITY_CONTROL';
  readonly state: 'OPEN' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly processor: {
    readonly name: string;
    readonly version: string;
  } | null;
  readonly owner: string | null;
  readonly nextAction: string | null;
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessUseCheck {
  readonly id: string;
  readonly purpose: string;
  readonly computation:
    'CATEGORY_REVIEW' | 'CONCENTRATION_DIFFERENCE' | 'FLUX' | 'OTHER';
  readonly state: 'CHECKS_PASSED' | 'LIMITED' | 'BLOCKED' | 'UNKNOWN';
  readonly recordIds: readonly string[];
  readonly reasons: readonly string[];
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessReconciliation {
  readonly id: string;
  readonly status: 'CANDIDATE' | 'VERIFIED' | 'REJECTED';
  readonly recordIds: readonly string[];
  readonly independentObservationCount: number | null;
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ProjectReadinessInput {
  readonly track: ProjectReadinessTrack;
  readonly requirement: {
    readonly needId: string;
    readonly version: string;
    readonly regionId: string;
    readonly purpose: string;
    readonly dateRole: 'PUBLICATION' | 'OBSERVATION' | 'EVENT';
    readonly window: { readonly start: string; readonly end: string } | null;
  };
  readonly sources: readonly ProjectReadinessSource[];
  readonly records: readonly ProjectReadinessRecord[];
  readonly series: readonly ReadinessPublicationSeries[];
  readonly correspondences: readonly ReadinessCorrespondence[];
  readonly checks?: readonly ReadinessCheck[];
  readonly fields?: readonly ReadinessField[];
  readonly tasks?: readonly ReadinessProcessingTask[];
  readonly useChecks?: readonly ReadinessUseCheck[];
  readonly reconciliations?: readonly ReadinessReconciliation[];
  readonly selectedReconciliationId?: string;
  readonly areaDenominator?: {
    readonly recordIds: readonly string[];
    readonly areaKm2: number;
    readonly evidence: readonly ReadinessEvidence[];
  };
}
export type ReadinessValueKind =
  | 'CATEGORY'
  | 'CATEGORY_RANGE'
  | 'DRY'
  | 'UNMONITORED'
  | 'NULL'
  | 'EMPTY'
  | 'NUMERIC'
  | 'TEXT';
export interface ReadinessValue {
  readonly raw: string | number | null;
  readonly kind: ReadinessValueKind;
  readonly numericValue: number | null;
}
export interface ReadinessCoverageRow {
  readonly objectKeys: readonly string[];
  readonly originalNames: readonly string[];
  readonly recordIds: readonly string[];
  readonly observedMonths: readonly string[];
  readonly missingMonths: readonly string[] | null;
}
export interface ReadinessQuestion {
  readonly id:
    | 'KINDS'
    | 'COUNTS'
    | 'QUALITY'
    | 'STRUCTURE'
    | 'DENSITY'
    | 'GAPS'
    | 'CLEANING'
    | 'QUALITY_CONTROL'
    | 'COMPUTATIONS';
  readonly state: 'KNOWN' | 'PARTIAL' | 'UNKNOWN';
  readonly drilldowns: readonly {
    readonly grain:
      | 'WORK'
      | 'VERSION'
      | 'ASSET'
      | 'SOURCE_OBJECT'
      | 'RECORD'
      | 'CHECK'
      | 'FIELD'
      | 'COVERAGE_CELL'
      | 'TASK'
      | 'USE_CHECK'
      | 'CORRESPONDENCE';
    readonly ids: readonly string[];
  }[];
}
export interface ProjectReadinessResult {
  readonly ruleVersion: string;
  readonly track: ProjectReadinessTrack;
  readonly requirement: ProjectReadinessInput['requirement'];
  readonly counts: {
    readonly works: number;
    readonly versions: number;
    readonly assets: number;
    readonly sourceObjects: number;
    readonly records: number;
    readonly monthlyRecords: number;
    readonly nonMonthlyRecords: number;
    readonly knownGeometries: number;
    readonly independentObservations: number | null;
  };
  readonly monthly: {
    readonly namedObjectCount: number | null;
    readonly undeclaredRecordIds: readonly string[];
    readonly unknownTimeRecordIds: readonly string[];
    readonly requiredMonths: readonly string[] | null;
    readonly raw: readonly ReadinessCoverageRow[];
    readonly approved: readonly ReadinessCoverageRow[];
    readonly hypothetical: readonly ReadinessCoverageRow[];
    readonly appliedApprovedIds: readonly string[];
    readonly appliedHypothesisIds: readonly string[];
  };
  readonly density: {
    readonly areaKm2: number | null;
    readonly observationsPerKm2: number | null;
    readonly reason:
      'KNOWN' | 'NOT_CONFIRMED' | 'SCOPE_MISMATCH' | 'DENOMINATOR_UNKNOWN';
  };
  readonly records: readonly ProjectReadinessRecord[];
  readonly values: readonly (ReadinessValue & { readonly recordId: string })[];
  readonly checks: readonly ReadinessCheck[];
  readonly fields: readonly ReadinessField[];
  readonly tasks: readonly ReadinessProcessingTask[];
  readonly useChecks: readonly ReadinessUseCheck[];
  readonly questions: readonly ReadinessQuestion[];
}

const RULE_VERSION = 'wiser.project-readiness.v1';
const CATEGORY = '(?:Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ|Ⅵ|I|II|III|IV|V|VI|劣Ⅴ|劣V)';
const CATEGORY_VALUE = new RegExp(`^${CATEGORY}(?:类)?$`);
const CATEGORY_RANGE = new RegExp(
  `^${CATEGORY}(?:类)?[～~—–-]${CATEGORY}(?:类)?$`,
);
const NUMERIC_VALUE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function invalid(): never {
  throw new DataFoundationDomainError(
    'PROJECT_READINESS_INVALID_INPUT',
    'Project readiness facts are inconsistent.',
  );
}
function sourceKey(source: ReadinessSourceReference): string {
  return JSON.stringify([source.workId, source.versionId, source.assetId]);
}
/** Internal fact references retain the original source-local record ID. */
export function readinessRecordKey(
  record: Pick<ProjectReadinessRecord, 'source' | 'id'>,
): string {
  return JSON.stringify([sourceKey(record.source), record.id]);
}
function objectKey(record: ProjectReadinessRecord): string | null {
  return record.object === null
    ? null
    : JSON.stringify([sourceKey(record.source), record.object.key]);
}
function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = unique(left);
  const b = unique(right);
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function monthOrdinal(value: string): number | null {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return null;
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
}
function requiredMonths(
  window: ProjectReadinessInput['requirement']['window'],
): string[] | null {
  if (window === null) return null;
  const start = monthOrdinal(window.start);
  const end = monthOrdinal(window.end);
  if (start === null || end === null || start > end || end - start >= 1200)
    invalid();
  return Array.from({ length: end - start + 1 }, (_, i) => {
    const value = start + i;
    return `${String(Math.floor(value / 12)).padStart(4, '0')}-${String((value % 12) + 1).padStart(2, '0')}`;
  });
}
export function classifyReadinessValue(
  raw: string | number | null,
): ReadinessValue {
  if (raw === null) return { raw, kind: 'NULL', numericValue: null };
  const text = String(raw).trim();
  const kind: ReadinessValueKind = !text
    ? 'EMPTY'
    : CATEGORY_VALUE.test(text)
      ? 'CATEGORY'
      : CATEGORY_RANGE.test(text)
        ? 'CATEGORY_RANGE'
        : text === '无水'
          ? 'DRY'
          : ['无法监测', '封闭无法监测', '未监测', '无法采样'].includes(text)
            ? 'UNMONITORED'
            : NUMERIC_VALUE.test(text) && Number.isFinite(Number(text))
              ? 'NUMERIC'
              : 'TEXT';
  return { raw, kind, numericValue: kind === 'NUMERIC' ? Number(text) : null };
}
interface NamedGroup {
  readonly key: string;
  readonly seriesKey: string;
  readonly name: string;
  readonly records: readonly ProjectReadinessRecord[];
}

function coverageRows(
  groups: readonly NamedGroup[],
  roots: ReadonlyMap<string, string>,
  months: readonly string[] | null,
  monthByRecord: ReadonlyMap<string, string | null>,
): ReadinessCoverageRow[] {
  const clusters = new Map<string, NamedGroup[]>();
  for (const group of groups) {
    const root = roots.get(group.key) ?? group.key;
    clusters.set(root, [...(clusters.get(root) ?? []), group]);
  }
  return [...clusters.values()].map((members) => {
    const records = members.flatMap((group) => group.records);
    const ids = records.map(readinessRecordKey);
    const observedMonths = unique(
      ids.flatMap((id) => {
        const month = monthByRecord.get(id);
        return month == null ? [] : [month];
      }),
    );
    const timeKnown = ids.every((id) => monthByRecord.get(id) != null);
    return {
      objectKeys: members.map((group) => group.key),
      originalNames: unique(members.map((group) => group.name)),
      recordIds: ids,
      observedMonths,
      missingMonths:
        months !== null && timeKnown
          ? months.filter((month) => !observedMonths.includes(month))
          : null,
    };
  });
}

function associatedGroups(
  groups: readonly NamedGroup[],
  correspondences: readonly ReadinessCorrespondence[],
  statuses: readonly ReadinessReviewState[],
): { roots: ReadonlyMap<string, string>; applied: readonly string[] } {
  const parents = new Map(groups.map((group) => [group.key, group.key]));
  const find = (key: string): string => {
    let current = key;
    while (parents.get(current) !== current) current = parents.get(current)!;
    return current;
  };
  const applied: string[] = [];
  for (const correspondence of correspondences) {
    if (
      !statuses.includes(correspondence.status) ||
      !correspondence.evidence.length
    )
      continue;
    const memberIds = new Set(correspondence.memberRecordIds);
    const members = groups.filter((group) =>
      group.records.some((record) => memberIds.has(readinessRecordKey(record))),
    );
    // A partial identity assertion must not join every month or another series.
    if (
      members.length < 2 ||
      new Set(members.map((group) => group.seriesKey)).size !== 1 ||
      members.some((group) =>
        group.records.some(
          (record) => !memberIds.has(readinessRecordKey(record)),
        ),
      )
    )
      continue;
    const root = find(members[0]!.key);
    for (const member of members.slice(1)) parents.set(find(member.key), root);
    applied.push(correspondence.id);
  }
  return {
    roots: new Map(groups.map((group) => [group.key, find(group.key)])),
    applied,
  };
}

export function calculateProjectReadiness(
  input: ProjectReadinessInput,
): ProjectReadinessResult {
  if (
    ![
      input.requirement.needId,
      input.requirement.version,
      input.requirement.regionId,
      input.requirement.purpose,
    ].every((value) => value.trim().length > 0)
  )
    invalid();
  const allSources = new Map(
    input.sources.map((source) => [sourceKey(source), source]),
  );
  const allRecords = new Map(
    input.records.map((record) => [readinessRecordKey(record), record]),
  );
  if (
    allSources.size !== input.sources.length ||
    allRecords.size !== input.records.length ||
    input.records.some((record) => !allSources.has(sourceKey(record.source)))
  )
    invalid();
  const sources = input.sources.filter(
    (source) =>
      source.track === input.track &&
      source.needIds.includes(input.requirement.needId) &&
      source.regionIds.includes(input.requirement.regionId),
  );
  const sourceKeys = new Set(sources.map(sourceKey));
  const records = input.records.filter(
    (record) =>
      sourceKeys.has(sourceKey(record.source)) &&
      record.needIds.includes(input.requirement.needId) &&
      record.regionIds.includes(input.requirement.regionId),
  );
  const recordMap = new Map(
    records.map((record) => [readinessRecordKey(record), record]),
  );
  const recordIds = records.map(readinessRecordKey);
  const hasEvidence = (evidence: readonly ReadinessEvidence[]) =>
    evidence.length > 0 &&
    evidence.every(
      (item) =>
        sourceKeys.has(sourceKey(item.source)) &&
        item.locator.trim().length > 0 &&
        item.excerpt.trim().length > 0,
    );
  const applies = (scope: ReadinessFactScope) =>
    scope.recordIds.length + scope.sources.length > 0 &&
    scope.recordIds.every((id) => recordMap.has(id)) &&
    scope.sources.every((source) => sourceKeys.has(sourceKey(source)));
  const checks = (input.checks ?? [])
    .filter(applies)
    .map((check) =>
      hasEvidence(check.evidence)
        ? check
        : { ...check, state: 'UNKNOWN' as const },
    );
  const fields = (input.fields ?? []).filter((field) =>
    sourceKeys.has(sourceKey(field.source)),
  );
  const tasks = (input.tasks ?? []).filter(applies);
  const correspondences = input.correspondences.filter(
    (correspondence) =>
      correspondence.memberRecordIds.length > 0 &&
      correspondence.memberRecordIds.every((id) => recordMap.has(id)) &&
      hasEvidence(correspondence.evidence),
  );
  const values = records.map((record) => ({
    recordId: readinessRecordKey(record),
    ...classifyReadinessValue(record.rawValue),
  }));
  const monthlyRecords = records.filter(
    (record) =>
      allSources.get(sourceKey(record.source))!.kind === 'MONTHLY_REPORT',
  );
  const undeclaredRecordIds: string[] = [];
  const groups = new Map<string, NamedGroup>();
  const months = requiredMonths(input.requirement.window);
  const monthByRecord = new Map<string, string | null>();
  for (const record of monthlyRecords) {
    const id = readinessRecordKey(record);
    monthByRecord.set(
      id,
      record.time.role === input.requirement.dateRole &&
        record.time.precision === 'MONTH' &&
        record.time.value !== null &&
        monthOrdinal(record.time.value) !== null &&
        record.parsing === 'READY' &&
        hasEvidence(record.evidence)
        ? record.time.value
        : null,
    );
    const declaration = input.series.find(
      (series) =>
        series.id === record.series?.id &&
        series.version === record.series.version &&
        series.sources.some(
          (source) => sourceKey(source) === sourceKey(record.source),
        ) &&
        hasEvidence(series.evidence),
    );
    if (declaration === undefined || record.object === null) {
      undeclaredRecordIds.push(id);
      continue;
    }
    const seriesKey = JSON.stringify([declaration.id, declaration.version]);
    const key = JSON.stringify([seriesKey, record.object.originalName]);
    const previous = groups.get(key);
    groups.set(key, {
      key,
      seriesKey,
      name: record.object.originalName,
      records: [...(previous?.records ?? []), record],
    });
  }
  const namedGroups = [...groups.values()];
  const approved = associatedGroups(namedGroups, correspondences, ['APPROVED']);
  const hypothetical = associatedGroups(namedGroups, correspondences, [
    'APPROVED',
    'PENDING_REVIEW',
  ]);
  const rawRows = coverageRows(namedGroups, new Map(), months, monthByRecord);
  const approvedRows = coverageRows(
    namedGroups,
    approved.roots,
    months,
    monthByRecord,
  );
  const hypotheticalRows = coverageRows(
    namedGroups,
    hypothetical.roots,
    months,
    monthByRecord,
  );
  const unknownTimeRecordIds = monthlyRecords
    .map(readinessRecordKey)
    .filter((id) => monthByRecord.get(id) === null);
  const useChecks = (input.useChecks ?? [])
    .filter(
      (check) =>
        check.purpose === input.requirement.purpose &&
        check.recordIds.length > 0 &&
        check.recordIds.every((id) => recordMap.has(id)),
    )
    .map((check): ReadinessUseCheck => {
      if (!hasEvidence(check.evidence))
        return {
          ...check,
          state: 'UNKNOWN',
          reasons: unique([...check.reasons, 'EVIDENCE_UNKNOWN']),
        };
      if (!['CONCENTRATION_DIFFERENCE', 'FLUX'].includes(check.computation))
        return check;
      const selected = check.recordIds.map((id) => recordMap.get(id)!);
      const reasons = [...check.reasons];
      if (
        selected.some(
          (record) =>
            classifyReadinessValue(record.rawValue).kind !== 'NUMERIC',
        )
      )
        reasons.push('NON_NUMERIC_INPUT');
      if (
        check.computation === 'CONCENTRATION_DIFFERENCE' &&
        selected.some((record) => record.metric?.kind !== 'CONCENTRATION')
      )
        reasons.push('CONCENTRATION_REQUIRED');
      if (
        check.computation === 'FLUX' &&
        (!selected.some((record) => record.metric?.kind === 'CONCENTRATION') ||
          !selected.some((record) => record.metric?.kind === 'FLOW'))
      )
        reasons.push('CONCENTRATION_AND_FLOW_REQUIRED');
      if (reasons.length > check.reasons.length)
        return { ...check, state: 'BLOCKED', reasons: unique(reasons) };
      if (
        selected.some(
          (record) =>
            !record.metric?.unit ||
            !record.metric.method ||
            record.time.role !== 'OBSERVATION' ||
            record.time.value === null ||
            record.time.precision === 'UNKNOWN',
        )
      )
        return {
          ...check,
          state: 'UNKNOWN',
          reasons: unique([...reasons, 'NUMERIC_CONTEXT_UNKNOWN']),
        };
      if (
        check.computation === 'CONCENTRATION_DIFFERENCE' &&
        new Set(
          selected.map((record) =>
            JSON.stringify([
              record.metric!.code,
              record.metric!.unit,
              record.metric!.method,
            ]),
          ),
        ).size !== 1
      )
        return {
          ...check,
          state: 'UNKNOWN',
          reasons: unique([...reasons, 'NUMERIC_CONTEXT_MISMATCH']),
        };
      return check;
    });
  const reconciliation = (input.reconciliations ?? []).find(
    (item) => item.id === input.selectedReconciliationId,
  );
  if (
    reconciliation?.independentObservationCount != null &&
    (!Number.isSafeInteger(reconciliation.independentObservationCount) ||
      reconciliation.independentObservationCount < 0)
  )
    invalid();
  const reconciledScope =
    reconciliation?.status === 'VERIFIED' &&
    hasEvidence(reconciliation.evidence) &&
    sameSet(reconciliation.recordIds, recordIds);
  const independentObservations = reconciledScope
    ? reconciliation.independentObservationCount
    : null;
  const denominator = input.areaDenominator;
  if (
    denominator !== undefined &&
    (!Number.isFinite(denominator.areaKm2) || denominator.areaKm2 <= 0)
  )
    invalid();
  const areaKnown =
    denominator !== undefined &&
    hasEvidence(denominator.evidence) &&
    sameSet(denominator.recordIds, recordIds);
  const areaKm2 = areaKnown ? denominator.areaKm2 : null;
  const density: ProjectReadinessResult['density'] = {
    areaKm2,
    observationsPerKm2:
      independentObservations !== null && areaKm2 !== null
        ? independentObservations / areaKm2
        : null,
    reason:
      independentObservations !== null && areaKm2 !== null
        ? 'KNOWN'
        : (reconciliation !== undefined &&
              !sameSet(reconciliation.recordIds, recordIds)) ||
            (denominator !== undefined &&
              !sameSet(denominator.recordIds, recordIds))
          ? 'SCOPE_MISMATCH'
          : independentObservations === null
            ? 'NOT_CONFIRMED'
            : 'DENOMINATOR_UNKNOWN',
  };
  const sourceObjects = unique(
    records.flatMap((record) => {
      const key = objectKey(record);
      return key === null ? [] : [key];
    }),
  );
  const geometries = unique(
    records.flatMap((record) =>
      record.spatial?.state === 'LOCATED' &&
      record.spatial.geometryKey !== null &&
      record.spatial.geometryKind !== null &&
      record.spatial.role !== null &&
      record.spatial.role.trim().length > 0 &&
      hasEvidence(record.evidence)
        ? [record.spatial.geometryKey]
        : [],
    ),
  );
  const works = unique(sources.map((source) => source.workId));
  const versions = unique(
    sources.map((source) => JSON.stringify([source.workId, source.versionId])),
  );
  const assets = unique(sources.map(sourceKey));
  const cleaning = tasks.filter((task) => task.kind === 'CLEANING');
  const qualityControl = tasks.filter(
    (task) => task.kind === 'QUALITY_CONTROL',
  );
  const taskState = (
    items: readonly ReadinessProcessingTask[],
  ): ReadinessQuestion['state'] =>
    items.length === 0
      ? 'UNKNOWN'
      : items.some(
            (task) =>
              task.owner === null ||
              task.processor === null ||
              !hasEvidence(task.evidence),
          )
        ? 'PARTIAL'
        : 'KNOWN';
  const question = (
    id: ReadinessQuestion['id'],
    state: ReadinessQuestion['state'],
    drilldowns: ReadinessQuestion['drilldowns'],
  ): ReadinessQuestion => ({ id, state, drilldowns });
  const gaps = rawRows.flatMap((row) =>
    (row.missingMonths ?? []).map((month) =>
      JSON.stringify([row.objectKeys, month]),
    ),
  );
  const questions = [
    question('KINDS', sources.length ? 'KNOWN' : 'UNKNOWN', [
      { grain: 'ASSET', ids: assets },
    ]),
    question('COUNTS', independentObservations === null ? 'PARTIAL' : 'KNOWN', [
      { grain: 'WORK', ids: works },
      { grain: 'VERSION', ids: versions },
      { grain: 'SOURCE_OBJECT', ids: sourceObjects },
      { grain: 'RECORD', ids: recordIds },
    ]),
    question(
      'QUALITY',
      checks.length === 0
        ? 'UNKNOWN'
        : checks.some((check) => check.state === 'UNKNOWN')
          ? 'PARTIAL'
          : 'KNOWN',
      [
        { grain: 'CHECK', ids: checks.map((check) => check.id) },
        {
          grain: 'RECORD',
          ids: records
            .filter(
              (record) =>
                record.parsing !== 'READY' ||
                record.professionalState !== 'APPROVED',
            )
            .map(readinessRecordKey),
        },
      ],
    ),
    question(
      'STRUCTURE',
      fields.length === 0
        ? 'UNKNOWN'
        : fields.some((field) => !hasEvidence(field.evidence))
          ? 'PARTIAL'
          : 'KNOWN',
      [
        { grain: 'FIELD', ids: fields.map((field) => field.id) },
        {
          grain: 'CORRESPONDENCE',
          ids: correspondences.map((item) => item.id),
        },
      ],
    ),
    question(
      'DENSITY',
      months === null || undeclaredRecordIds.length
        ? 'UNKNOWN'
        : density.reason === 'KNOWN' && !unknownTimeRecordIds.length
          ? 'KNOWN'
          : 'PARTIAL',
      [
        {
          grain: 'COVERAGE_CELL',
          ids: rawRows.flatMap((row) =>
            row.observedMonths.map((month) =>
              JSON.stringify([row.objectKeys, month]),
            ),
          ),
        },
        { grain: 'RECORD', ids: recordIds },
      ],
    ),
    question(
      'GAPS',
      months === null ||
        undeclaredRecordIds.length ||
        unknownTimeRecordIds.length
        ? 'PARTIAL'
        : 'KNOWN',
      [
        { grain: 'COVERAGE_CELL', ids: gaps },
        {
          grain: 'CHECK',
          ids: checks
            .filter((check) => check.state !== 'PASSED')
            .map((check) => check.id),
        },
        {
          grain: 'USE_CHECK',
          ids: useChecks
            .filter((check) => check.state !== 'CHECKS_PASSED')
            .map((check) => check.id),
        },
      ],
    ),
    question('CLEANING', taskState(cleaning), [
      { grain: 'TASK', ids: cleaning.map((task) => task.id) },
    ]),
    question('QUALITY_CONTROL', taskState(qualityControl), [
      { grain: 'TASK', ids: qualityControl.map((task) => task.id) },
    ]),
    question(
      'COMPUTATIONS',
      useChecks.length === 0
        ? 'UNKNOWN'
        : useChecks.some((check) => check.state === 'UNKNOWN')
          ? 'PARTIAL'
          : 'KNOWN',
      [{ grain: 'USE_CHECK', ids: useChecks.map((check) => check.id) }],
    ),
  ];
  return {
    ruleVersion: RULE_VERSION,
    track: input.track,
    requirement: input.requirement,
    counts: {
      works: works.length,
      versions: versions.length,
      assets: assets.length,
      sourceObjects: sourceObjects.length,
      records: records.length,
      monthlyRecords: monthlyRecords.length,
      nonMonthlyRecords: records.length - monthlyRecords.length,
      knownGeometries: geometries.length,
      independentObservations,
    },
    monthly: {
      namedObjectCount: undeclaredRecordIds.length ? null : namedGroups.length,
      undeclaredRecordIds,
      unknownTimeRecordIds,
      requiredMonths: months,
      raw: rawRows,
      approved: approvedRows,
      hypothetical: hypotheticalRows,
      appliedApprovedIds: approved.applied,
      appliedHypothesisIds: hypothetical.applied,
    },
    density,
    records,
    values,
    checks,
    fields,
    tasks,
    useChecks,
    questions,
  };
}
