import { describe, expect, it } from 'vitest';
import {
  calculateProjectReadiness,
  readinessRecordKey,
  type ProjectReadinessInput,
  type ProjectReadinessSource,
} from '../src/project-readiness.ts';

const ingestionId = '10000000-0000-4000-8000-000000000001';
const batchId = '10000000-0000-4000-8000-000000000002';
const assetId = '10000000-0000-4000-8000-000000000003';
const recordId = '10000000-0000-4000-8000-000000000004';
const metadata = {
  track: 'REAL',
  kind: 'MONTHLY_REPORT',
  needIds: ['K5-001'],
  regionIds: ['chaobai'],
} as const;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    candidateReference: {
      kind: 'ingestion-candidate',
      ingestionId,
      reviewHash: 'a'.repeat(64),
      processingBatchId: batchId,
    },
    assetId,
    sourceLocalWorkId: null,
    ...metadata,
    ...overrides,
  } as unknown as ProjectReadinessSource;
}

function input(sources: ProjectReadinessSource[]): ProjectReadinessInput {
  return {
    track: 'REAL',
    requirement: {
      needId: 'K5-001',
      version: 'needs-v1',
      regionId: 'chaobai',
      purpose: 'category-reading',
      dateRole: 'PUBLICATION',
      window: { start: '2023-04', end: '2023-04' },
    },
    sources,
    records: sources.map((source) => ({
      id: recordId,
      source,
      needIds: ['K5-001'],
      regionIds: ['chaobai'],
      object: {
        key: 'row:2',
        originalName: '同名河段',
        markers: [],
        footnotes: [],
      },
      series: null,
      time: { value: '2023-04', role: 'PUBLICATION', precision: 'MONTH' },
      rawValue: 'Ⅱ',
      metric: null,
      parsing: 'READY',
      professionalState: 'PENDING_REVIEW',
      evidence: [{ source, locator: 'table:1/row:2', excerpt: '同名河段 | Ⅱ' }],
      spatial: null,
    })),
    series: [],
    correspondences: [],
  };
}

describe('candidate readiness identity and separate grains', () => {
  it('preserves the exact published reference key and legacy counts', () => {
    const source = {
      workId: ingestionId,
      versionId: batchId,
      assetId,
      ...metadata,
    };
    expect(readinessRecordKey({ source, id: recordId })).toBe(
      JSON.stringify([
        JSON.stringify([ingestionId, batchId, assetId]),
        recordId,
      ]),
    );
    expect(calculateProjectReadiness(input([source])).counts).toEqual({
      works: 1,
      versions: 1,
      assets: 1,
      sourceObjects: 1,
      records: 1,
      monthlyRecords: 1,
      nonMonthlyRecords: 0,
      knownGeometries: 0,
      independentObservations: null,
    });
  });

  it('keeps different batches, review hashes and ingestion IDs distinct without name matching', () => {
    const base = candidate();
    const original = (
      base as unknown as { candidateReference: Record<string, string> }
    ).candidateReference;
    const sources = [
      base,
      candidate({
        candidateReference: {
          ...original,
          processingBatchId: '20000000-0000-4000-8000-000000000002',
        },
      }),
      candidate({
        candidateReference: { ...original, reviewHash: 'b'.repeat(64) },
      }),
      candidate({
        candidateReference: {
          ...original,
          ingestionId: '20000000-0000-4000-8000-000000000001',
        },
      }),
    ];
    expect(
      new Set(
        sources.map((source) => readinessRecordKey({ source, id: recordId })),
      ).size,
    ).toBe(4);
    expect(calculateProjectReadiness(input(sources)).records).toHaveLength(4);
  });

  it('normalizes candidate UUID spellings but keeps source-local IDs and hashes fixed', () => {
    const base = candidate({
      candidateReference: {
        kind: 'ingestion-candidate',
        ingestionId: 'AAAAAAAA-0000-4000-8000-000000000001',
        processingBatchId: 'BBBBBBBB-0000-4000-8000-000000000002',
        reviewHash: 'a'.repeat(64),
      },
      assetId: 'CCCCCCCC-0000-4000-8000-000000000003',
    });
    const canonical = candidate({
      candidateReference: {
        kind: 'ingestion-candidate',
        ingestionId: 'aaaaaaaa-0000-4000-8000-000000000001',
        processingBatchId: 'bbbbbbbb-0000-4000-8000-000000000002',
        reviewHash: 'a'.repeat(64),
      },
      assetId: 'cccccccc-0000-4000-8000-000000000003',
    });
    expect(readinessRecordKey({ source: base, id: 'Row:A' })).toBe(
      readinessRecordKey({ source: canonical, id: 'Row:A' }),
    );
    expect(readinessRecordKey({ source: base, id: 'Row:A' })).not.toBe(
      readinessRecordKey({ source: base, id: 'row:a' }),
    );
  });

  it('never folds candidate grains into published work, version, asset or record counts', () => {
    const source = {
      workId: ingestionId,
      versionId: batchId,
      assetId,
      ...metadata,
    };
    const result = calculateProjectReadiness(input([source, candidate()]));
    expect(result.counts).toMatchObject({
      works: 1,
      versions: 1,
      assets: 1,
      records: 1,
      sourceObjects: 1,
    });
    expect(result).toHaveProperty('candidateCounts', {
      batches: 1,
      assets: 1,
      records: 1,
      sourceObjects: 1,
      monthlyRecords: 1,
      nonMonthlyRecords: 0,
      knownGeometries: 0,
      sourceLocalWorks: null,
    });
    expect(result.records).toHaveLength(2);
    expect(
      result.questions
        .find((q) => q.id === 'COUNTS')
        ?.drilldowns.some((d) => String(d.grain) === 'CANDIDATE_RECORD'),
    ).toBe(true);
    expect(result.ruleVersion).toBe('wiser.project-readiness.v3');
  });

  it.each([
    { workId: 'invented-work', versionId: 'invented-version' },
    { workId: undefined },
    {
      candidateReference: {
        kind: 'ingestion-candidate',
        ingestionId,
        processingBatchId: batchId,
        reviewHash: 'invalid',
      },
    },
    { assetId: 'not-a-uuid' },
  ])('rejects an invalid or mixed candidate reference: %j', (change) => {
    expect(() => calculateProjectReadiness(input([candidate(change)]))).toThrow(
      'Project readiness facts are inconsistent.',
    );
  });

  it('reports an unknown candidate work count when any source lacks a work declaration', () => {
    const declared = candidate({
      sourceLocalWorkId: 'declared-monthly-series',
    });
    const undeclared = candidate({
      assetId: '20000000-0000-4000-8000-000000000003',
    });
    expect(
      calculateProjectReadiness(input([declared, undeclared])),
    ).toHaveProperty('candidateCounts.sourceLocalWorks', null);
    expect(calculateProjectReadiness(input([declared]))).toHaveProperty(
      'candidateCounts.sourceLocalWorks',
      1,
    );
  });
  it('keeps source-local geometry keys distinct across candidate batches', () => {
    const original = candidate();
    const other = candidate({
      candidateReference: {
        ...(original as { candidateReference: object }).candidateReference,
        processingBatchId: '20000000-0000-4000-8000-000000000002',
      },
    });
    const facts = input([original, other]);
    const result = calculateProjectReadiness({
      ...facts,
      records: facts.records.map((record) => ({
        ...record,
        spatial: {
          state: 'LOCATED',
          role: 'study-area',
          geometryKey: 'source-local-geometry-1',
          geometryKind: 'AREA',
        },
      })),
    });
    expect(result.counts.knownGeometries).toBe(0);
    expect(result.candidateCounts?.knownGeometries).toBe(2);
  });
});
