import { describe, expect, it } from 'vitest';
import {
  calculateProjectReadiness,
  classifyReadinessValue,
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
      memberRecordIds: records.map((r) => r.id),
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
      recordIds: f.records.map((r) => r.id),
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
          recordIds: [f.records[0]!.id],
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
});
