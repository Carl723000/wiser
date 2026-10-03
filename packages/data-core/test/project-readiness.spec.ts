import { describe, expect, it } from 'vitest';
import {
  calculateProjectReadiness,
  classifyReadinessValue,
  readinessRecordKey,
  type ProjectReadinessInput,
  type ProjectReadinessRecord,
  type ProjectReadinessSource,
  type ReadinessEvidence,
} from '../src/project-readiness.js';

const months = [
  '2023-04',
  '2023-05',
  '2023-06',
  '2023-07',
  '2023-08',
  '2023-09',
  '2023-10',
  '2023-11',
];
function source(
  month: string,
  track: 'REAL' | 'SYNTHETIC' = 'REAL',
): ProjectReadinessSource {
  return {
    workId: `monthly-${month}`,
    versionId: `${month}-v1`,
    assetId: `${month}-raw`,
    track,
    kind: 'MONTHLY_REPORT',
    needIds: ['K5-001'],
    regionIds: ['chaobai'],
  };
}
function evidence(
  s: ProjectReadinessSource,
  locator = 'table:1/row:14',
): ReadinessEvidence {
  return {
    source: s,
    locator,
    excerpt: 'Original reported object and category.',
  };
}
function record(
  s: ProjectReadinessSource,
  object: number,
  name = `原表对象${object}`,
): ProjectReadinessRecord {
  return {
    id: `${s.versionId}:row:${object}`,
    source: s,
    needIds: ['K5-001'],
    regionIds: ['chaobai'],
    object: {
      key: `row:${object}`,
      originalName: name,
      markers: [],
      footnotes: [],
    },
    series: { id: 'beijing-monthly', version: 'declared-v1' },
    time: { value: s.workId.slice(8), role: 'PUBLICATION', precision: 'MONTH' },
    rawValue: 'Ⅱ',
    metric: {
      code: 'reported-water-quality',
      kind: 'CATEGORY',
      unit: null,
      method: 'monthly publication',
    },
    parsing: 'READY',
    professionalState: 'PENDING_REVIEW',
    evidence: [evidence(s)],
    spatial: null,
  };
}
function fixture(objects = 25): ProjectReadinessInput {
  const sources = months.map((month) => source(month));
  return {
    track: 'REAL',
    requirement: {
      needId: 'K5-001',
      version: 'confirmed-needs-v1',
      regionId: 'chaobai',
      purpose: 'category-review',
      dateRole: 'PUBLICATION',
      window: { start: months[0]!, end: months[7]! },
    },
    sources,
    records: sources.flatMap((s) =>
      Array.from({ length: objects }, (_, i) => record(s, i)),
    ),
    series: [
      {
        id: 'beijing-monthly',
        version: 'declared-v1',
        sources,
        evidence: [evidence(sources[0]!, 'publication-series')],
      },
    ],
    correspondences: [],
  };
}

describe('project readiness retains source identity, evidence grain and declared coverage', () => {
  it('counts 25 reported objects over eight issues as 200 rows and keeps three non-monthly rows separate', () => {
    const f = fixture();
    const other: ProjectReadinessSource = {
      ...f.sources[0]!,
      workId: 'policy-work',
      versionId: 'policy-v1',
      assetId: 'policy-raw',
      kind: 'DOCUMENT',
    };
    const extra = [0, 1, 2].map((i) => ({ ...record(other, i), series: null }));
    const result = calculateProjectReadiness({
      ...f,
      sources: [...f.sources, other],
      records: [...f.records, ...extra],
    });
    expect(result.counts).toMatchObject({
      works: 9,
      versions: 9,
      assets: 9,
      sourceObjects: 203,
      records: 203,
      monthlyRecords: 200,
      nonMonthlyRecords: 3,
      independentObservations: null,
    });
    expect(result.monthly.namedObjectCount).toBe(25);
    expect(result.monthly.raw).toHaveLength(25);
    expect(
      result.monthly.raw.every(
        (row) => row.recordIds.length === 8 && row.missingMonths?.length === 0,
      ),
    ).toBe(true);
    expect(result.records.map((r) => r.id)).toEqual(
      [...f.records, ...extra].map((r) => r.id),
    );
  });

  it('finds missing months per reported object using the requested window, not the regional first/last issue', () => {
    const f = fixture(2);
    const records = f.records.filter((r) => r.id !== '2023-06-v1:row:0');
    const result = calculateProjectReadiness({ ...f, records });
    expect(
      result.monthly.raw.find((row) => row.originalNames.includes('原表对象0'))
        ?.missingMonths,
    ).toEqual(['2023-06']);
    expect(
      result.monthly.raw.find((row) => row.originalNames.includes('原表对象1'))
        ?.missingMonths,
    ).toEqual([]);
    const wider = calculateProjectReadiness({
      ...f,
      records,
      requirement: {
        ...f.requirement,
        window: { start: '2023-03', end: '2023-12' },
      },
    });
    expect(
      wider.monthly.raw.find((row) => row.originalNames.includes('原表对象0'))
        ?.missingMonths,
    ).toEqual(['2023-03', '2023-06', '2023-12']);
    expect(
      wider.monthly.raw.find((row) => row.originalNames.includes('原表对象1'))
        ?.missingMonths,
    ).toEqual(['2023-03', '2023-12']);
  });

  it('keeps 肖/萧 names, star and footnote while separating a pending coverage hypothesis from approved correspondence', () => {
    const f = fixture(1);
    const footnote = {
      ...evidence(f.sources[5]!, 'paragraph:469'),
      excerpt: '注：“萧太后河”即“肖太后河”。',
    };
    const records = f.records.map((r, i) => ({
      ...r,
      object: {
        ...r.object!,
        originalName: i === 5 || i === 6 ? '萧太后河*' : '肖太后河',
        markers: i === 5 || i === 6 ? ['*'] : [],
        footnotes: i === 5 || i === 6 ? [footnote] : [],
      },
    }));
    const correspondence = {
      id: 'footnote-correspondence',
      memberRecordIds: records.map(readinessRecordKey),
      status: 'PENDING_REVIEW' as const,
      evidence: [footnote],
    };
    const before = calculateProjectReadiness({ ...f, records });
    const pending = calculateProjectReadiness({
      ...f,
      records,
      correspondences: [correspondence],
    });
    expect(before.monthly.raw).toHaveLength(2);
    expect(pending.monthly.approved).toHaveLength(2);
    expect(pending.monthly.hypothetical).toHaveLength(1);
    expect(pending.monthly.hypothetical[0]?.missingMonths).toEqual([]);
    expect(pending.monthly.appliedApprovedIds).toEqual([]);
    const approved = calculateProjectReadiness({
      ...f,
      records,
      correspondences: [{ ...correspondence, status: 'APPROVED' }],
    });
    expect(approved.monthly.approved).toHaveLength(1);
    expect(approved.monthly.namedObjectCount).toBe(2);
    expect(approved.counts.sourceObjects).toBe(8);
    expect(approved.records[5]?.object).toEqual(records[5]?.object);
  });

  it('includes approved real records and selects the explicit exercise track without mixing it into real progress', () => {
    const f = fixture(1);
    const exerciseSource = {
      ...source('2023-04', 'SYNTHETIC'),
      workId: 'exercise-work',
      versionId: 'exercise-v1',
      assetId: 'exercise-raw',
    };
    const exercise = {
      ...record(exerciseSource, 0),
      professionalState: 'APPROVED' as const,
    };
    const input = {
      ...f,
      sources: [...f.sources, exerciseSource],
      records: [
        ...f.records.map((r) => ({
          ...r,
          professionalState: 'APPROVED' as const,
        })),
        exercise,
      ],
    };
    expect(calculateProjectReadiness(input).counts.records).toBe(8);
    expect(
      calculateProjectReadiness({ ...input, track: 'SYNTHETIC' }).records.map(
        (r) => r.id,
      ),
    ).toEqual([exercise.id]);
  });

  it('distinguishes category, range, dry, unmonitored, null and zero and blocks category-based concentration differences and flux', () => {
    const raw = [
      'Ⅱ',
      'Ⅱ～Ⅲ',
      '无水',
      '封闭无法监测',
      null,
      0,
      '0',
      '',
    ] as const;
    expect(raw.map((value) => classifyReadinessValue(value).kind)).toEqual([
      'CATEGORY',
      'CATEGORY_RANGE',
      'DRY',
      'UNMONITORED',
      'NULL',
      'NUMERIC',
      'NUMERIC',
      'EMPTY',
    ]);
    expect(raw.map((value) => classifyReadinessValue(value).raw)).toEqual(raw);
    expect(classifyReadinessValue(0).numericValue).toBe(0);
    const f = fixture(1);
    const checks = ['CONCENTRATION_DIFFERENCE', 'FLUX'].map((computation) => ({
      id: computation,
      purpose: f.requirement.purpose,
      computation: computation as 'CONCENTRATION_DIFFERENCE' | 'FLUX',
      state: 'CHECKS_PASSED' as const,
      recordIds: f.records.map(readinessRecordKey),
      reasons: [],
      evidence: [evidence(f.sources[0]!)],
    }));
    const result = calculateProjectReadiness({ ...f, useChecks: checks });
    expect(result.useChecks.map((check) => check.state)).toEqual([
      'BLOCKED',
      'BLOCKED',
    ]);
    expect(
      result.useChecks.every((check) =>
        check.reasons.includes('NON_NUMERIC_INPUT'),
      ),
    ).toBe(true);
  });

  it('derives the nine drilldowns from their actual facts and keeps missing quality checks, owner and observation denominator unknown', () => {
    const f = fixture(1);
    const result = calculateProjectReadiness({
      ...f,
      fields: [
        {
          id: 'field-category',
          source: f.sources[0]!,
          name: '水质类别',
          type: 'category',
          unit: null,
          timeRole: null,
          positionRole: null,
          primaryKey: null,
          formatVersion: 'DOCX-table-v1',
          evidence: [evidence(f.sources[0]!)],
        },
      ],
      tasks: [
        {
          id: 'task-clean',
          kind: 'CLEANING',
          state: 'OPEN',
          processor: { name: 'table-extractor', version: 'v1' },
          owner: null,
          nextAction: '核查原表空白格',
          recordIds: [readinessRecordKey(f.records[0]!)],
          sources: [f.sources[0]!],
          evidence: [evidence(f.sources[0]!)],
        },
      ],
    });
    expect(result.questions.map((q) => q.id)).toEqual([
      'KINDS',
      'COUNTS',
      'QUALITY',
      'STRUCTURE',
      'DENSITY',
      'GAPS',
      'CLEANING',
      'QUALITY_CONTROL',
      'COMPUTATIONS',
    ]);
    expect(
      result.questions.find((q) => q.id === 'STRUCTURE')?.drilldowns,
    ).toContainEqual({ grain: 'FIELD', ids: ['field-category'] });
    expect(
      result.questions.find((q) => q.id === 'CLEANING')?.drilldowns,
    ).toContainEqual({ grain: 'TASK', ids: ['task-clean'] });
    expect(result.questions.find((q) => q.id === 'QUALITY')?.state).toBe(
      'UNKNOWN',
    );
    expect(
      result.questions.find((q) => q.id === 'QUALITY_CONTROL')?.state,
    ).toBe('UNKNOWN');
    expect(result.tasks[0]?.owner).toBeNull();
    expect(result.density.observationsPerKm2).toBeNull();
    expect(result.counts.independentObservations).toBeNull();
    expect(result.checks).toEqual([]);
  });

  it('keeps undeclared monthly names and an unspecified demand window unknown instead of manufacturing a denominator', () => {
    const f = fixture(1);
    const absent = calculateProjectReadiness({ ...f, series: [] });
    expect(absent.monthly.namedObjectCount).toBeNull();
    expect(absent.monthly.undeclaredRecordIds).toEqual(
      f.records.map(readinessRecordKey),
    );
    expect(absent.counts.records).toBe(8);
    const unsupported = calculateProjectReadiness({
      ...f,
      series: f.series.map((series) => ({ ...series, evidence: [] })),
    });
    expect(unsupported.monthly.namedObjectCount).toBeNull();
    const unspecified = calculateProjectReadiness({
      ...f,
      requirement: { ...f.requirement, window: null },
    });
    expect(unspecified.monthly.requiredMonths).toBeNull();
    expect(unspecified.monthly.raw[0]?.missingMonths).toBeNull();
    expect(unspecified.questions.find((q) => q.id === 'DENSITY')?.state).toBe(
      'UNKNOWN',
    );
  });

  it('does not turn a different date role, invalid month or failed extraction into known monthly coverage', () => {
    const f = fixture(1);
    const records = f.records.map((r, i) =>
      i === 1
        ? { ...r, time: { ...r.time, role: 'OBSERVATION' as const } }
        : i === 2
          ? { ...r, time: { ...r.time, value: '2023-13' } }
          : i === 3
            ? { ...r, parsing: 'FAILED' as const }
            : r,
    );
    const result = calculateProjectReadiness({ ...f, records });
    expect(result.monthly.unknownTimeRecordIds).toEqual(
      records.slice(1, 4).map(readinessRecordKey),
    );
    expect(result.monthly.raw[0]?.observedMonths).toEqual([
      '2023-04',
      '2023-08',
      '2023-09',
      '2023-10',
      '2023-11',
    ]);
    expect(result.monthly.raw[0]?.missingMonths).toBeNull();
    expect(result.records[3]?.parsing).toBe('FAILED');
  });

  it('counts the same printed name in separate declared series separately', () => {
    const f = fixture(1);
    const secondSeries = {
      ...f.series[0]!,
      id: 'another-publisher-series',
      sources: f.sources.slice(4),
    };
    const records = f.records.map((r, i) =>
      i >= 4
        ? {
            ...r,
            series: { id: secondSeries.id, version: secondSeries.version },
          }
        : r,
    );
    const result = calculateProjectReadiness({
      ...f,
      records,
      series: [...f.series, secondSeries],
      correspondences: [
        {
          id: 'same-name-is-not-identity',
          memberRecordIds: records.map(readinessRecordKey),
          status: 'APPROVED',
          evidence: [evidence(f.sources[0]!)],
        },
      ],
    });
    expect(result.monthly.namedObjectCount).toBe(2);
    expect(result.monthly.raw).toHaveLength(2);
    expect(result.monthly.approved).toHaveLength(2);
    expect(result.monthly.appliedApprovedIds).toEqual([]);
    expect(result.counts.sourceObjects).toBe(8);
  });

  it('scopes source-local record IDs and counts another asset without inventing another work', () => {
    const f = fixture(1);
    const original = f.sources[0]!;
    const copy = {
      ...original,
      assetId: 'converted-table',
      kind: 'TABLE' as const,
    };
    const first = { ...f.records[0]!, id: 'row:1' };
    const second = { ...first, source: copy, series: null };
    const result = calculateProjectReadiness({
      ...f,
      sources: [original, copy],
      records: [first, second],
    });
    expect(result.counts).toMatchObject({
      works: 1,
      versions: 1,
      assets: 2,
      sourceObjects: 2,
      records: 2,
      monthlyRecords: 1,
      nonMonthlyRecords: 1,
    });
    expect(result.records.map((r) => r.id)).toEqual(['row:1', 'row:1']);
    expect(new Set(result.values.map((value) => value.recordId)).size).toBe(2);
    expect(() =>
      calculateProjectReadiness({ ...f, records: [first, first] }),
    ).toThrow('Project readiness facts are inconsistent.');
  });

  it('does not broaden a partial, rejected or unsupported correspondence to all publication months', () => {
    const f = fixture(1);
    const records = f.records.map((r, i) => ({
      ...r,
      object: { ...r.object!, originalName: i < 4 ? '原名' : '另名*' },
    }));
    const base = {
      id: 'identity-scope',
      memberRecordIds: records.map(readinessRecordKey),
      status: 'APPROVED' as const,
      evidence: [evidence(f.sources[0]!)],
    };
    for (const correspondence of [
      {
        ...base,
        memberRecordIds: [
          readinessRecordKey(records[0]!),
          readinessRecordKey(records[4]!),
        ],
      },
      { ...base, status: 'REJECTED' as const },
      { ...base, status: 'REQUIRES_CORRECTION' as const },
      { ...base, evidence: [] },
    ]) {
      const result = calculateProjectReadiness({
        ...f,
        records,
        correspondences: [correspondence],
      });
      expect(result.monthly.approved).toHaveLength(2);
      expect(result.monthly.hypothetical).toHaveLength(2);
      expect(result.monthly.appliedApprovedIds).toEqual([]);
    }
  });

  it('keeps checks and tasks within the explicit track, demand and region and use checks within purpose', () => {
    const f = fixture(1);
    const excluded = { ...f.sources[1]!, needIds: ['another-demand'] };
    const input = {
      ...f,
      sources: f.sources.map((s, i) => (i === 1 ? excluded : s)),
      records: f.records.map((r, i) =>
        i === 2 ? { ...r, regionIds: ['outside'] } : r,
      ),
      checks: [
        {
          id: 'excluded-check',
          kind: 'INTEGRITY' as const,
          state: 'PASSED' as const,
          recordIds: [readinessRecordKey(f.records[1]!)],
          sources: [excluded],
          findings: [],
          evidence: [evidence(excluded)],
        },
      ],
      useChecks: [
        {
          id: 'another-purpose',
          computation: 'CATEGORY_REVIEW' as const,
          purpose: 'concentration-trends',
          state: 'CHECKS_PASSED' as const,
          recordIds: [readinessRecordKey(f.records[0]!)],
          reasons: [],
          evidence: [evidence(f.sources[0]!)],
        },
      ],
    };
    const result = calculateProjectReadiness(input);
    expect(result.counts.records).toBe(6);
    expect(result.checks).toEqual([]);
    expect(result.useChecks).toEqual([]);
    expect(result.records.map(readinessRecordKey)).not.toContain(
      readinessRecordKey(f.records[2]!),
    );
  });

  it('uses only an explicitly selected, evidenced reconciliation of the exact record scope for independent observations', () => {
    const f = fixture(1);
    const confirmed = {
      id: 'selected-confirmation',
      status: 'VERIFIED' as const,
      recordIds: f.records.map(readinessRecordKey),
      independentObservationCount: 0,
      evidence: [evidence(f.sources[0]!)],
    };
    const input = {
      ...f,
      reconciliations: [confirmed],
      selectedReconciliationId: confirmed.id,
      areaDenominator: {
        recordIds: confirmed.recordIds,
        areaKm2: 10,
        evidence: confirmed.evidence,
      },
    };
    const result = calculateProjectReadiness(input);
    expect(result.counts.independentObservations).toBe(0);
    expect(result.density).toEqual({
      areaKm2: 10,
      observationsPerKm2: 0,
      reason: 'KNOWN',
    });
    expect(
      calculateProjectReadiness({
        ...f,
        reconciliations: [confirmed],
        areaDenominator: input.areaDenominator,
      }).counts.independentObservations,
    ).toBeNull();
    expect(
      calculateProjectReadiness({
        ...input,
        reconciliations: [{ ...confirmed, status: 'CANDIDATE' }],
      }).counts.independentObservations,
    ).toBeNull();
    expect(
      calculateProjectReadiness({
        ...input,
        reconciliations: [
          { ...confirmed, recordIds: confirmed.recordIds.slice(1) },
        ],
      }).density.reason,
    ).toBe('SCOPE_MISMATCH');
  });

  it('rejects a density denominator from another scope and preserves its unknown state', () => {
    const f = fixture(1);
    const ids = f.records.map(readinessRecordKey);
    const result = calculateProjectReadiness({
      ...f,
      selectedReconciliationId: 'confirmed',
      reconciliations: [
        {
          id: 'confirmed',
          status: 'VERIFIED',
          recordIds: ids,
          independentObservationCount: 2,
          evidence: [evidence(f.sources[0]!)],
        },
      ],
      areaDenominator: {
        recordIds: ids.slice(1),
        areaKm2: 10,
        evidence: [evidence(f.sources[0]!)],
      },
    });
    expect(result.counts.independentObservations).toBe(2);
    expect(result.density).toEqual({
      areaKm2: null,
      observationsPerKm2: null,
      reason: 'SCOPE_MISMATCH',
    });
  });

  it('retains actual failed findings and task ownership without promoting unreferenced structure or checks', () => {
    const f = fixture(1);
    const scope = {
      recordIds: [readinessRecordKey(f.records[0]!)],
      sources: [f.sources[0]!],
    };
    const result = calculateProjectReadiness({
      ...f,
      checks: [
        {
          ...scope,
          id: 'actual-failure',
          kind: 'UNITS',
          state: 'FAILED',
          findings: ['单位缺失'],
          evidence: [evidence(f.sources[0]!)],
        },
        {
          ...scope,
          id: 'unsupported-pass',
          kind: 'POSITION',
          state: 'PASSED',
          findings: [],
          evidence: [],
        },
      ],
      fields: [
        {
          id: 'unsupported-field',
          source: f.sources[0]!,
          name: '疑似浓度',
          type: 'number',
          unit: null,
          timeRole: null,
          positionRole: null,
          primaryKey: null,
          formatVersion: null,
          evidence: [],
        },
      ],
      tasks: [
        {
          ...scope,
          id: 'actual-qc',
          kind: 'QUALITY_CONTROL',
          state: 'OPEN',
          processor: { name: 'unit-checker', version: 'v1' },
          owner: 'designated-reviewer',
          nextAction: '核对表头单位',
          evidence: [evidence(f.sources[0]!)],
        },
      ],
    });
    expect(result.checks.map((check) => check.state)).toEqual([
      'FAILED',
      'UNKNOWN',
    ]);
    expect(result.checks[0]?.findings).toEqual(['单位缺失']);
    expect(result.questions.find((q) => q.id === 'QUALITY')?.state).toBe(
      'PARTIAL',
    );
    expect(result.questions.find((q) => q.id === 'STRUCTURE')?.state).toBe(
      'PARTIAL',
    );
    expect(
      result.questions.find((q) => q.id === 'QUALITY_CONTROL'),
    ).toMatchObject({
      state: 'KNOWN',
      drilldowns: [{ grain: 'TASK', ids: ['actual-qc'] }],
    });
    expect(result.tasks[0]?.owner).toBe('designated-reviewer');
    expect(result.tasks[0]?.nextAction).toBe('核对表头单位');
  });

  it('counts supplied evidenced geometry identities once and keeps named-only or unsupported positions out of that count', () => {
    const f = fixture(1);
    const located = {
      state: 'LOCATED' as const,
      role: '研究范围',
      geometryKey: 'canonical-river-line',
      geometryKind: 'LINE' as const,
    };
    const records = f.records.map((r, i) =>
      i < 2
        ? { ...r, spatial: located }
        : i === 2
          ? { ...r, spatial: { ...located, state: 'NAMED_ONLY' as const } }
          : i === 3
            ? {
                ...r,
                spatial: {
                  ...located,
                  geometryKey: 'unsupported-area',
                  geometryKind: 'AREA' as const,
                },
                evidence: [],
              }
            : i === 4
              ? {
                  ...r,
                  spatial: {
                    ...located,
                    geometryKey: 'role-unknown',
                    role: null,
                  },
                }
              : r,
    );
    const result = calculateProjectReadiness({ ...f, records });
    expect(result.counts.knownGeometries).toBe(1);
    expect(result.records[2]?.spatial?.state).toBe('NAMED_ONLY');
    expect(result.records[3]?.spatial?.geometryKey).toBe('unsupported-area');
  });

  it('retains a supported numeric eligibility result including zero and makes incompatible concentration contexts unknown', () => {
    const f = fixture(1);
    const records = f.records.slice(0, 2).map((r, i) => ({
      ...r,
      rawValue: i === 0 ? 0 : 2,
      metric: {
        code: 'NH3-N',
        kind: 'CONCENTRATION' as const,
        unit: 'mg/L',
        method: 'matched-method',
      },
      time: { ...r.time, role: 'OBSERVATION' as const },
    }));
    const check = {
      id: 'numeric-eligibility',
      purpose: f.requirement.purpose,
      computation: 'CONCENTRATION_DIFFERENCE' as const,
      state: 'CHECKS_PASSED' as const,
      recordIds: records.map(readinessRecordKey),
      reasons: [],
      evidence: [evidence(f.sources[0]!)],
    };
    const input = { ...f, records, useChecks: [check] };
    expect(calculateProjectReadiness(input).useChecks[0]?.state).toBe(
      'CHECKS_PASSED',
    );
    const incompatible = calculateProjectReadiness({
      ...input,
      records: [
        records[0]!,
        { ...records[1]!, metric: { ...records[1]!.metric, unit: 'μg/L' } },
      ],
    });
    expect(incompatible.useChecks[0]?.state).toBe('UNKNOWN');
    expect(incompatible.useChecks[0]?.reasons).toContain(
      'NUMERIC_CONTEXT_MISMATCH',
    );
    const absent = calculateProjectReadiness({
      ...input,
      records: records.map((r) => ({
        ...r,
        metric: { ...r.metric, method: null },
      })),
    });
    expect(absent.useChecks[0]?.reasons).toContain('NUMERIC_CONTEXT_UNKNOWN');
  });

  it('classifies finite numeric text without inventing values for symbols, placeholders or non-finite numbers', () => {
    expect(classifyReadinessValue(' +1.5e-3 ')).toEqual({
      raw: ' +1.5e-3 ',
      kind: 'NUMERIC',
      numericValue: 0.0015,
    });
    expect(classifyReadinessValue('—').kind).toBe('TEXT');
    expect(classifyReadinessValue('1.0 mg/L').numericValue).toBeNull();
    expect(classifyReadinessValue(Number.NaN).kind).toBe('TEXT');
    expect(classifyReadinessValue(Infinity).numericValue).toBeNull();
    expect(classifyReadinessValue('劣Ⅴ类').kind).toBe('CATEGORY');
  });

  it('is reproducible, leaves input facts untouched and rejects ambiguous scopes or invalid target windows', () => {
    const f = fixture(1);
    const before = structuredClone(f);
    expect(calculateProjectReadiness(f)).toEqual(calculateProjectReadiness(f));
    expect(f).toEqual(before);
    expect(() =>
      calculateProjectReadiness({
        ...f,
        sources: [...f.sources, f.sources[0]!],
      }),
    ).toThrow();
    expect(() =>
      calculateProjectReadiness({ ...f, sources: f.sources.slice(1) }),
    ).toThrow();
    expect(() =>
      calculateProjectReadiness({
        ...f,
        requirement: {
          ...f.requirement,
          window: { start: '2023-12', end: '2023-03' },
        },
      }),
    ).toThrow();
  });
});
