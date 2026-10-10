import { describe, expect, it } from 'vitest';
import { readinessRecordKey } from '@wiser/data-core/project-readiness';
import {
  CANDIDATE_MONTHLY_RULE_VERSION,
  CANDIDATE_MONTHLY_RULE_VERSION_V3,
} from '@wiser/data-core/candidate-monthly-projection';
import type { CandidateMonthlySemanticRead } from './candidate-monthly-semantic-reader';
import {
  buildCandidateMonthlyReadiness,
  buildCandidateMonthlyScopeMappings,
  buildCandidateMonthlyScopedReadiness,
  buildCandidateMonthlyOriginals,
  type CandidateMonthlyReadinessRequirement,
  type CandidateMonthlyReadinessMapping,
} from './candidate-monthly-readiness';

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const assetId = '10000000-0000-4000-8000-000000000003';
const requirement: CandidateMonthlyReadinessRequirement = {
  needId: 'synthetic-category-need',
  version: 'synthetic-need-v1',
  regionId: 'synthetic-explicit-region',
  purpose: 'synthetic-category-reading',
  window: { start: '2023-04', end: '2023-05' },
  track: 'SYNTHETIC',
};

function semantic(
  rawValues: readonly string[] = ['Ⅱ', 'Ⅱ～Ⅲ', '无水', '封闭无法监测', ''],
): Extract<CandidateMonthlySemanticRead, { kind: 'READY' }> {
  return {
    kind: 'READY',
    reason: null,
    batchStatus: 'PARTIAL',
    conversionEvidence: null,
    conversionMembers: [],
    candidateReference: reference,
    assetId,
    publicationMonth: null,
    reportPeriod: '2023-04',
    processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V3,
    records: rawValues.map((rawCategory, index) => ({
      candidateReference: reference,
      source: {
        sourceLocalWorkId: null,
        assetId,
        originalSha256: 'b'.repeat(64),
        preparedSha256: 'c'.repeat(64),
      },
      sourceLocalIdentity: {
        recordId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        sourceId: `table:1/row:${index + 2}`,
        index: index + 5,
      },
      objectType: 'RIVER_REACH',
      originalName: '同名原表河段',
      waterSystemOriginal: '原表水系',
      districtOriginal: '原表区名',
      rawCategory,
      time: { value: '2023-04', role: 'REPORT_PERIOD', precision: 'MONTH' },
      locators: {
        title: 'word/document.xml#paragraph:1',
        row: `word/document.xml#table:1/row:${index + 2}`,
        nameCell: `word/document.xml#table:1/row:${index + 2}/cell:2`,
        categoryCell: `word/document.xml#table:1/row:${index + 2}/cell:4`,
        districtCell: `word/document.xml#table:1/row:${index + 2}/cell:3`,
        waterSystemCell: `word/document.xml#table:1/row:${index + 2}/cell:1`,
      },
      processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V3,
    })),
  };
}

function mappings(
  read: ReturnType<typeof semantic>,
): CandidateMonthlyReadinessMapping[] {
  return read.records.map((record) => ({
    recordId: record.sourceLocalIdentity.recordId,
    needId: requirement.needId,
    regionId: requirement.regionId,
    evidence: [
      {
        locator: record.locators.row,
        excerpt: 'Explicit synthetic scope mapping.',
      },
    ],
  }));
}

describe('candidate monthly readiness adapter', () => {
  it('reads local originals without requiring or inventing a business requirement', () => {
    const read = semantic(['Ⅱ～Ⅲ', '无水']);
    const result = buildCandidateMonthlyOriginals(read);
    expect(result.originals.map((e) => e.value.raw)).toEqual(['Ⅱ～Ⅲ', '无水']);
    expect(result.selections[0].sourceLocalIdentity).toEqual(
      read.records[0].sourceLocalIdentity,
    );
    expect(result).not.toHaveProperty('readiness');
    expect(result).not.toHaveProperty('requirement');
  });
  it('reuses candidate grains and keeps raw report-period values pending and unlocated', () => {
    const read = semantic();
    const before = structuredClone(read);
    const result = buildCandidateMonthlyReadiness(
      read,
      requirement,
      mappings(read),
    );
    expect(result.readiness.counts).toMatchObject({
      works: 0,
      versions: 0,
      records: 0,
    });
    expect(result.readiness.candidateCounts).toMatchObject({
      batches: 1,
      assets: 1,
      records: 5,
      monthlyRecords: 5,
      knownGeometries: 0,
      sourceLocalWorks: null,
    });
    const { track: _track, ...required } = requirement;
    expect(result.readiness.requirement).toEqual({
      ...required,
      dateRole: 'REPORT_PERIOD',
    });
    expect(
      result.readiness.records.every(
        (r) =>
          r.professionalState === 'PENDING_REVIEW' &&
          r.parsing === 'READY' &&
          r.spatial?.state === 'NAMED_ONLY' &&
          r.spatial.geometryKey === null &&
          r.series === null &&
          r.time.role === 'REPORT_PERIOD',
      ),
    ).toBe(true);
    expect(result.originals.map((entry) => entry.value.raw)).toEqual(
      read.records.map((r) => r.rawCategory),
    );
    expect(result.originals.map((entry) => entry.value.kind)).toEqual([
      'CATEGORY',
      'CATEGORY_RANGE',
      'DRY',
      'UNMONITORED',
      'EMPTY',
    ]);
    expect(result.readiness.monthly.namedObjectCount).toBeNull();
    expect(result.readiness.monthly.undeclaredRecordIds).toHaveLength(5);
    expect(result.monthly).toEqual([]);
    expect(result.unmappedRecordIds).toEqual([]);
    expect(read).toEqual(before);
    expect(read.batchStatus).toBe('PARTIAL');
  });

  it('with no mapping retains originals without assigning any business region or coverage', () => {
    const read = semantic();
    const result = buildCandidateMonthlyReadiness(read, requirement, []);
    expect(result.readiness.records).toEqual([]);
    expect(result.monthly).toEqual([]);
    expect(result.originals).toHaveLength(5);
    expect(result.unmappedRecordIds).toEqual(
      read.records.map((r) => r.sourceLocalIdentity.recordId),
    );
    expect(result.originals[0].record.districtOriginal).toBe('原表区名');
  });

  it('requires the exact need and region mapping pair, avoiding cross-product scope', () => {
    const read = semantic(['Ⅲ']);
    const [base] = mappings(read);
    const result = buildCandidateMonthlyReadiness(read, requirement, [
      { ...base, regionId: 'another-region' },
      { ...base, needId: 'another-need' },
    ]);
    expect(result.readiness.records).toEqual([]);
    expect(result.unmappedRecordIds).toEqual([base.recordId]);
  });

  it('keeps exact native identity and locators for selection, even for repeated original names', () => {
    const read = semantic(['Ⅱ', 'Ⅳ']);
    const result = buildCandidateMonthlyReadiness(
      read,
      requirement,
      mappings(read),
    );
    expect(result.selections).toHaveLength(2);
    expect(new Set(result.selections.map((s) => s.recordKey)).size).toBe(2);
    expect(result.selections[1]).toEqual({
      recordKey: readinessRecordKey(result.readiness.records[1]),
      candidateReference: reference,
      assetId,
      sourceLocalIdentity: read.records[1].sourceLocalIdentity,
      locators: read.records[1].locators,
    });
    expect(result.readiness.records[0].source).toEqual({
      candidateReference: reference,
      assetId,
      sourceLocalWorkId: null,
    });
    expect(result.readiness.records[0].source).not.toHaveProperty('workId');
    expect(result.readiness.records[0].source).not.toHaveProperty('versionId');
    const other = {
      ...read,
      candidateReference: { ...reference, reviewHash: 'd'.repeat(64) },
      records: read.records.map((r) => ({
        ...r,
        candidateReference: { ...reference, reviewHash: 'd'.repeat(64) },
      })),
    };
    expect(
      buildCandidateMonthlyReadiness(other, requirement, mappings(other))
        .selections[0].recordKey,
    ).not.toBe(result.selections[0].recordKey);
  });

  it('retains legacy publication time without relabelling it as observation or report period', () => {
    const original = semantic(['Ⅱ']);
    const read: ReturnType<typeof semantic> = {
      ...original,
      batchStatus: 'READY' as const,
      processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
      reportPeriod: undefined,
      publicationMonth: '2023-04',
      records: original.records.map((r) => ({
        ...r,
        time: { ...r.time, role: 'PUBLICATION' as const },
        processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
      })),
    };
    const result = buildCandidateMonthlyReadiness(
      read,
      requirement,
      mappings(read),
    );
    expect(result.originals[0].record.time.role).toBe('PUBLICATION');
    expect(result.readiness.monthly.unknownTimeRecordIds).toEqual([
      result.selections[0].recordKey,
    ]);
    expect(result.monthly).toEqual([]);
  });

  it.each(['duplicate', 'unknown', 'empty-evidence'] as const)(
    'rejects %s mapping without silently broadening scope',
    (kind) => {
      const read = semantic(['Ⅱ']);
      const [base] = mappings(read);
      const invalid =
        kind === 'duplicate'
          ? [base, base]
          : kind === 'unknown'
            ? [{ ...base, recordId: '30000000-0000-4000-8000-000000000001' }]
            : [{ ...base, evidence: [] }];
      expect(() =>
        buildCandidateMonthlyReadiness(read, requirement, invalid),
      ).toThrow();
    },
  );

  it('rejects semantic rows from another fixed candidate or asset', () => {
    const read = semantic(['Ⅱ']);
    const otherCandidate = {
      ...read,
      records: [
        {
          ...read.records[0],
          candidateReference: { ...reference, reviewHash: 'd'.repeat(64) },
        },
      ],
    };
    const otherAsset = {
      ...read,
      records: [
        {
          ...read.records[0],
          source: {
            ...read.records[0].source,
            assetId: '40000000-0000-4000-8000-000000000001',
          },
        },
      ],
    };
    expect(() =>
      buildCandidateMonthlyReadiness(otherCandidate, requirement, []),
    ).toThrow();
    expect(() =>
      buildCandidateMonthlyReadiness(otherAsset, requirement, []),
    ).toThrow();
  });
});

describe('fixed K5-001 Chaobai row interpretation', () => {
  it('requires exact river water-system evidence and keeps all other original rows unmapped', () => {
    const read = semantic(Array.from({ length: 7 }, () => 'Ⅱ'));
    read.records.forEach((record) =>
      Object.assign(record, {
        waterSystemOriginal: '潮白河水系',
        locators: {
          ...record.locators,
          waterSystemCell: record.locators.waterSystemCell!.replace(
            '/cell:',
            '/column:',
          ),
        },
      }),
    );
    Object.assign(read.records[1], { objectType: 'LAKE' });
    Object.assign(read.records[2], {
      waterSystemOriginal: null,
      originalName: '潮白河',
      districtOriginal: '密云',
    });
    Object.assign(read.records[3], { waterSystemOriginal: '潮白河水系附近' });
    Object.assign(read.records[4], {
      locators: { ...read.records[4].locators, waterSystemCell: null },
    });
    Object.assign(read.records[5], {
      locators: {
        ...read.records[5].locators,
        waterSystemCell: 'word/document.xml#table:9/row:2/column:1',
      },
    });
    Object.assign(read.records[6], {
      locators: {
        ...read.records[6].locators,
        waterSystemCell: 'word/document.xml#table:1/row:999/column:1',
      },
    });
    const mappings = buildCandidateMonthlyScopeMappings(read);
    expect(mappings).toEqual([
      {
        recordId: read.records[0].sourceLocalIdentity.recordId,
        needId: 'K5-001',
        regionId: 'chaobai',
        evidence: [
          {
            locator: read.records[0].locators.waterSystemCell,
            excerpt: '潮白河水系',
          },
        ],
      },
    ]);
    const result = buildCandidateMonthlyScopedReadiness(read);
    expect(result.originals).toHaveLength(7);
    expect(result.unmappedRecordIds).toHaveLength(6);
    expect(result.readiness.candidateCounts?.records).toBe(1);
    expect(result.readiness.records[0]).toMatchObject({
      professionalState: 'PENDING_REVIEW',
      series: null,
      spatial: { geometryKey: null, role: null },
    });
    expect(result.monthly).toEqual([]);
  });
  it('does not map a record whose producer-rule differs from the current read', () => {
    const read = semantic(['Ⅱ']);
    Object.assign(read.records[0], {
      waterSystemOriginal: '潮白河水系',
      processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
    });
    expect(() => buildCandidateMonthlyScopedReadiness(read)).toThrow();
  });
});

it('retains the verified predecessor water-system cell for a merged river row', () => {
  const read = semantic(['Ⅱ', 'Ⅲ']);
  read.records.forEach((record) =>
    Object.assign(record, {
      waterSystemOriginal: '潮白河水系',
      locators: {
        ...record.locators,
        waterSystemCell: 'word/document.xml#table:1/row:2/column:1',
      },
    }),
  );
  const result = buildCandidateMonthlyScopedReadiness(read);
  expect(result.readiness.candidateCounts?.records).toBe(2);
  expect(result.readiness.records[1].evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        locator: 'word/document.xml#table:1/row:2/column:1',
        excerpt: '潮白河水系',
      }),
    ]),
  );
  expect(result.readiness.records[1].evidence[0].locator).toBe(
    'word/document.xml#table:1/row:3',
  );
});
