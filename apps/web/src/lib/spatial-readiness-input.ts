import {
  readinessRecordKey,
  type ProjectReadinessInput,
  type ReadinessEvidence,
  type ReadinessSourceReference,
  type ReadinessFactScope,
} from '@wiser/data-core/project-readiness';
import type { WorkspacePack } from './spatial-workspace-contract';
import { fixedSourceKey, materialReference } from './spatial-readiness-facts';

type Reader = (input: unknown) => unknown;
const invalid = (): never => {
  throw new Error('Invalid local readiness facts');
};
const text: Reader = (value) =>
  typeof value === 'string' && value.length <= 65536 ? value : invalid();
const id: Reader = (value) =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 2048
    ? value
    : invalid();
const number: Reader = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : invalid();
const boolean: Reader = (value) =>
  typeof value === 'boolean' ? value : invalid();
const choice =
  (...values: string[]): Reader =>
  (value) =>
    typeof value === 'string' && values.includes(value) ? value : invalid();
const nullable =
  (read: Reader): Reader =>
  (value) =>
    value === null ? null : read(value);
const optional =
  (read: Reader): Reader =>
  (value) =>
    value === undefined ? undefined : read(value);
const list =
  (read: Reader): Reader =>
  (value) =>
    Array.isArray(value) && value.length <= 20000 ? value.map(read) : invalid();
const shape =
  (fields: Record<string, Reader>): Reader =>
  (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return invalid();
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(fields).flatMap(([key, read]) => {
        const current = read(input[key]);
        return current === undefined ? [] : [[key, current]];
      }),
    );
  };
const source = shape({ workId: id, versionId: id, assetId: id });
const evidence = list(shape({ source, locator: text, excerpt: text }));
const recordIds = list(id);
const sources = list(source);
const review = choice(
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'REQUIRES_CORRECTION',
);
const factScope = { recordIds, sources };
const month: Reader = (value) =>
  typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
    ? value
    : invalid();
const window: Reader = (value) => {
  const result = shape({ start: month, end: month })(value) as {
    start: string;
    end: string;
  };
  const ordinal = (s: string) =>
    Number(s.slice(0, 4)) * 12 + Number(s.slice(5));
  if (
    result.start > result.end ||
    ordinal(result.end) - ordinal(result.start) >= 1200
  )
    return invalid();
  return result;
};
const input = shape({
  track: choice('REAL'),
  requirement: shape({
    needId: id,
    version: id,
    regionId: id,
    purpose: text,
    dateRole: choice('PUBLICATION', 'OBSERVATION', 'EVENT'),
    window: nullable(window),
  }),
  sources: list(
    shape({
      workId: id,
      versionId: id,
      assetId: id,
      track: choice('REAL'),
      kind: choice(
        'MONTHLY_REPORT',
        'TABLE',
        'DOCUMENT',
        'VECTOR',
        'RASTER',
        'DIRECTORY',
      ),
      needIds: recordIds,
      regionIds: recordIds,
    }),
  ),
  records: list(
    shape({
      id,
      source,
      needIds: recordIds,
      regionIds: recordIds,
      object: nullable(
        shape({
          key: id,
          originalName: text,
          markers: list(text),
          footnotes: evidence,
        }),
      ),
      series: nullable(shape({ id, version: id })),
      time: shape({
        value: nullable(text),
        role: choice('PUBLICATION', 'OBSERVATION', 'EVENT', 'UNKNOWN'),
        precision: choice('MONTH', 'DAY', 'YEAR', 'UNKNOWN'),
      }),
      rawValue: (value) =>
        value === null
          ? null
          : typeof value === 'number'
            ? number(value)
            : text(value),
      metric: nullable(
        shape({
          code: text,
          kind: choice('CATEGORY', 'CONCENTRATION', 'FLOW', 'OTHER'),
          unit: nullable(text),
          method: nullable(text),
        }),
      ),
      parsing: choice('READY', 'PARTIAL', 'NOT_PARSED', 'FAILED'),
      professionalState: review,
      evidence,
      spatial: nullable(
        shape({
          state: choice('LOCATED', 'NAMED_ONLY', 'UNKNOWN'),
          role: nullable(text),
          geometryKey: nullable(text),
          geometryKind: nullable(choice('POINT', 'LINE', 'AREA', 'MIXED')),
        }),
      ),
    }),
  ),
  series: list(shape({ id, version: id, sources, evidence })),
  correspondences: list(
    shape({ id, memberRecordIds: recordIds, status: review, evidence }),
  ),
  checks: optional(
    list(
      shape({
        ...factScope,
        id,
        kind: choice(
          'INTEGRITY',
          'PARSING',
          'UNITS',
          'POSITION',
          'PURPOSE',
          'DUPLICATES',
        ),
        state: choice('PASSED', 'FAILED', 'PENDING', 'UNKNOWN'),
        findings: list(text),
        evidence,
      }),
    ),
  ),
  fields: optional(
    list(
      shape({
        id,
        source,
        name: text,
        type: text,
        unit: nullable(text),
        timeRole: nullable(text),
        positionRole: nullable(text),
        primaryKey: nullable(boolean),
        formatVersion: nullable(text),
        evidence,
      }),
    ),
  ),
  tasks: optional(
    list(
      shape({
        ...factScope,
        id,
        kind: choice('CLEANING', 'QUALITY_CONTROL'),
        state: choice('OPEN', 'RUNNING', 'COMPLETED', 'FAILED'),
        processor: nullable(shape({ name: text, version: text })),
        owner: nullable(text),
        nextAction: nullable(text),
        evidence,
      }),
    ),
  ),
  useChecks: optional(
    list(
      shape({
        id,
        purpose: text,
        computation: choice(
          'CATEGORY_REVIEW',
          'CONCENTRATION_DIFFERENCE',
          'FLUX',
          'OTHER',
        ),
        state: choice('CHECKS_PASSED', 'LIMITED', 'BLOCKED', 'UNKNOWN'),
        recordIds,
        reasons: list(text),
        evidence,
      }),
    ),
  ),
  reconciliations: optional(
    list(
      shape({
        id,
        status: choice('CANDIDATE', 'VERIFIED', 'REJECTED'),
        recordIds,
        independentObservationCount: nullable(number),
        evidence,
      }),
    ),
  ),
  selectedReconciliationId: optional(id),
  areaDenominator: optional(shape({ recordIds, areaKm2: number, evidence })),
});

/** Whitelist existing internal facts; do not serialize arbitrary local JSON fields. */
export function parseLocalReadinessFacts(
  value: unknown,
): ProjectReadinessInput {
  return input(value) as ProjectReadinessInput;
}

/** Apply the already validated pack's display scope before facts reach a client. */
export function readableLocalReadinessFacts(
  pack: WorkspacePack,
  facts: ProjectReadinessInput,
): ProjectReadinessInput {
  const readable = new Set(
    pack.sources
      .filter((source) => source.rights.public && source.rights.displayAllowed)
      .map((source) => fixedSourceKey(materialReference(source))),
  );
  const sourceAllowed = (source: ReadinessSourceReference) =>
    readable.has(fixedSourceKey(source));
  const evidenceAllowed = (items: readonly ReadinessEvidence[]) =>
    items.every((item) => sourceAllowed(item.source));
  const records = facts.records.filter((fact) => {
    if (
      !sourceAllowed(fact.source) ||
      !evidenceAllowed(fact.evidence) ||
      !evidenceAllowed(fact.object?.footnotes ?? [])
    )
      return false;
    const record = pack.records.find(
      (record) =>
        record.id === fact.id &&
        pack.sources.some(
          (source) =>
            source.id === record.sourceId &&
            source.versionId === record.versionId &&
            fixedSourceKey(materialReference(source)) ===
              fixedSourceKey(fact.source),
        ),
    );
    return (
      record &&
      record.value === fact.rawValue &&
      (!fact.object ||
        (fact.object.key === record.objectId &&
          fact.object.originalName === record.objectLabel)) &&
      (!fact.metric ||
        (fact.metric.code === record.metric &&
          fact.metric.unit === record.unit))
    );
  });
  const allowedRecords = new Set(records.map(readinessRecordKey));
  const recordsAllowed = (ids: readonly string[]) =>
    ids.every((id) => allowedRecords.has(id));
  const scopeAllowed = (scope: ReadinessFactScope) =>
    scope.recordIds.length + scope.sources.length > 0 &&
    recordsAllowed(scope.recordIds) &&
    scope.sources.every(sourceAllowed);
  return {
    ...facts,
    sources: facts.sources.filter(sourceAllowed),
    records,
    series: facts.series
      .filter((series) => evidenceAllowed(series.evidence))
      .map((series) => ({
        ...series,
        sources: series.sources.filter(sourceAllowed),
      }))
      .filter((series) => series.sources.length > 0),
    correspondences: facts.correspondences.filter(
      (item) =>
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
    reconciliations: facts.reconciliations?.filter(
      (item) =>
        item.recordIds.length > 0 &&
        recordsAllowed(item.recordIds) &&
        evidenceAllowed(item.evidence),
    ),
    ...(facts.areaDenominator &&
    (!recordsAllowed(facts.areaDenominator.recordIds) ||
      !evidenceAllowed(facts.areaDenominator.evidence))
      ? { areaDenominator: undefined }
      : {}),
  };
}
