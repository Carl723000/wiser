import {
  readinessRecordKey,
  type ProjectReadinessRecord,
  type ProjectReadinessResult,
  type ReadinessValue,
} from '@wiser/data-core/project-readiness';

export type MonthlyCoverageMode = 'raw' | 'approved' | 'hypothetical';

export interface MonthlyReadoutEntry {
  readonly recordKey: string;
  readonly record: ProjectReadinessRecord;
  readonly value: ReadinessValue;
}

export interface MonthlyReadoutCell {
  readonly month: string;
  readonly required: boolean;
  readonly state: 'PRESENT' | 'MISSING' | 'UNKNOWN';
  readonly entries: readonly MonthlyReadoutEntry[];
}

export interface MonthlyReadoutRow {
  readonly objectKeys: readonly string[];
  readonly originalNames: readonly string[];
  readonly coverageKnown: boolean;
  readonly cells: readonly MonthlyReadoutCell[];
  readonly unknownTimeEntries: readonly MonthlyReadoutEntry[];
  readonly unresolvedRecordKeys: readonly string[];
}

/**
 * Reads one freshly computed and already-authorized readiness result.
 * The core owns identity, month eligibility, raw classification and coverage.
 * This adapter neither fetches data nor infers a missing-month cause.
 */
export function buildMonthlyReadout(
  project: Pick<ProjectReadinessResult, 'monthly' | 'records' | 'values'>,
  mode: MonthlyCoverageMode = 'raw',
): readonly MonthlyReadoutRow[] {
  const records = new Map(
    project.records.map((record) => [readinessRecordKey(record), record]),
  );
  const values = new Map(
    project.values.map((value) => [value.recordId, value]),
  );
  const required = new Set(project.monthly.requiredMonths ?? []);
  const unknownTime = new Set(project.monthly.unknownTimeRecordIds);

  return project.monthly[mode].map((row) => {
    const byMonth = new Map<string, MonthlyReadoutEntry[]>();
    const observed = new Set(row.observedMonths);
    const unknownTimeEntries: MonthlyReadoutEntry[] = [];
    const unresolvedRecordKeys: string[] = [];

    for (const recordKey of row.recordIds) {
      const record = records.get(recordKey);
      const value = values.get(recordKey);
      if (record === undefined || value === undefined) {
        unresolvedRecordKeys.push(recordKey);
        continue;
      }
      const entry: MonthlyReadoutEntry = {
        recordKey,
        record,
        value: {
          raw: value.raw,
          kind: value.kind,
          numericValue: value.numericValue,
        },
      };
      if (unknownTime.has(recordKey)) {
        unknownTimeEntries.push(entry);
      } else if (
        record.time.value !== null &&
        observed.has(record.time.value)
      ) {
        const month = record.time.value;
        const entries = byMonth.get(month);
        if (entries) entries.push(entry);
        else byMonth.set(month, [entry]);
      } else {
        // An inconsistent reference cannot certify a month from date text alone.
        unresolvedRecordKeys.push(recordKey);
      }
    }

    const coverageKnown =
      row.missingMonths !== null && unresolvedRecordKeys.length === 0;
    const missing = new Set(coverageKnown ? row.missingMonths : []);
    const months = [...new Set([...required, ...observed])].sort();
    return {
      objectKeys: row.objectKeys,
      originalNames: row.originalNames,
      coverageKnown,
      cells: months.map((month): MonthlyReadoutCell => {
        const entries = byMonth.get(month) ?? [];
        return {
          month,
          required: required.has(month),
          state:
            entries.length > 0
              ? 'PRESENT'
              : missing.has(month)
                ? 'MISSING'
                : 'UNKNOWN',
          entries,
        };
      }),
      unknownTimeEntries,
      unresolvedRecordKeys,
    };
  });
}
