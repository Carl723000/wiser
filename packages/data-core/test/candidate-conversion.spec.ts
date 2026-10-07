import { describe, expect, it } from 'vitest';
import {
  compareCandidateConversionStructure,
  candidateConversionEligibility,
} from '../src/candidate-conversion.ts';

const id = (suffix: number) =>
  `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
const structure = {
  tables: [
    {
      locator: 'word/document.xml#table:1',
      width: { type: 'dxa', value: '9600' },
      gridWidths: ['4800', '4800'],
      rows: [
        {
          locator: 'word/document.xml#table:1/row:1',
          cells: [
            {
              locator: 'word/document.xml#table:1/row:1/cell:1',
              column: 1,
              columnSpan: 1,
              verticalMerge: 'restart',
              width: { type: 'dxa', value: '4800' },
              text: ' 潮白河 ',
            },
            {
              locator: 'word/document.xml#table:1/row:1/cell:2',
              column: 2,
              columnSpan: 1,
              verticalMerge: null,
              width: { type: 'dxa', value: '4800' },
              text: '',
            },
          ],
        },
      ],
    },
  ],
  paragraphs: [{ locator: 'word/document.xml#paragraph:1', text: '2023年4月' }],
  monthTitles: [
    { locator: 'word/document.xml#paragraph:1', text: '2023年4月' },
  ],
};
const check = {
  schemaVersion: 1,
  resultId: id(6),
  reference,
  kind: 'HISTORICAL_EQUIVALENCE',
  state: 'VERIFIED_EQUIVALENT',
  original: { assetId: id(3), sha256: 'b'.repeat(64), byteSize: 12 },
  prepared: { assetId: id(4), sha256: 'c'.repeat(64), byteSize: 18 },
  manifest: { assetId: id(5), sha256: 'd'.repeat(64) },
  sourceLocalWorkId: 'monthly-local-2023-04',
  historicalToolVersion: null,
  rule: { id: 'candidate-word-equivalence', version: '1.0.0' },
  tool: {
    name: 'trusted-converter',
    version: 'synthetic-test',
    digest: 'e'.repeat(64),
  },
  reconvertedSha256: 'f'.repeat(64),
  comparisonDigest: '1'.repeat(64),
  comparison: {
    tableCount: 1,
    physicalCellCount: 2,
    emptyCellCount: 1,
    paragraphCount: 1,
    monthTitleCount: 1,
    differenceCount: 0,
    differences: [],
  },
  failureReason: null,
};
const batch = {
  reference,
  parserVersion: 'synthetic',
  status: 'PARTIAL',
  createdAt: '2026-10-06T12:00:00Z',
  assets: [
    {
      assetId: id(3),
      sourceHash: 'b'.repeat(64),
      status: 'UNSUPPORTED',
      reason: 'FORMAT_COMPANION',
      recordCount: null,
      featureCount: null,
    },
    {
      assetId: id(4),
      sourceHash: 'c'.repeat(64),
      status: 'READY',
      reason: null,
      recordCount: 2,
      featureCount: 0,
    },
    {
      assetId: id(5),
      sourceHash: 'd'.repeat(64),
      status: 'UNSUPPORTED',
      reason: 'SOURCE_MANIFEST',
      recordCount: null,
      featureCount: null,
    },
  ],
};

describe('complete Word conversion comparison', () => {
  it('preserves all physical fields, whitespace, empty cells and source locators', () => {
    expect(
      compareCandidateConversionStructure(
        structure,
        structuredClone(structure),
      ),
    ).toMatchObject({
      kind: 'EQUIVALENT',
      summary: {
        tableCount: 1,
        physicalCellCount: 2,
        emptyCellCount: 1,
        paragraphCount: 1,
        monthTitleCount: 1,
        differenceCount: 0,
        differences: [],
      },
    });
  });
  it.each([
    'grid',
    'width',
    'span',
    'merge',
    'empty',
    'locator',
    'month',
    'paragraph',
  ])(
    'refuses a %s change that equal normalized text cannot explain',
    (change) => {
      const other = structuredClone(structure);
      const table = other.tables[0]!,
        cell = table.rows[0]!.cells[1]!;
      if (change === 'grid') table.gridWidths[0] = '4799';
      if (change === 'width') cell.width.value = '4799';
      if (change === 'span') cell.columnSpan = 2;
      if (change === 'merge') cell.verticalMerge = 'continue' as never;
      if (change === 'empty') cell.text = ' ';
      if (change === 'locator')
        cell.locator = 'word/document.xml#table:1/row:2/cell:2';
      if (change === 'month') other.monthTitles[0]!.text = '2023年5月';
      if (change === 'paragraph') other.paragraphs[0]!.text = '2023 年4月';
      expect(compareCandidateConversionStructure(structure, other).kind).toBe(
        'DIFFERENT',
      );
    },
  );
  it('does not compare malformed, cyclic or unavailable structures', () => {
    expect(compareCandidateConversionStructure(null, structure).kind).toBe(
      'UNVERIFIABLE',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(compareCandidateConversionStructure(cyclic, structure).kind).toBe(
      'UNVERIFIABLE',
    );
    let read = false;
    const accessor = Object.defineProperty({}, 'tables', {
      get() {
        read = true;
        return [];
      },
    });
    expect(compareCandidateConversionStructure(accessor, structure).kind).toBe(
      'UNVERIFIABLE',
    );
    expect(read).toBe(false);
    expect(
      compareCandidateConversionStructure(
        { ...structure, unexpected: 'not-physical-structure' },
        structure,
      ).kind,
    ).toBe('UNVERIFIABLE');
  });
});
describe('narrow PARTIAL eligibility', () => {
  it('consumes only the server-verified P while preserving the real partial batch and O states', () => {
    const before = structuredClone(batch);
    expect(candidateConversionEligibility(batch, check, check.rule)).toEqual({
      eligible: true,
      preparedAssetId: id(4),
    });
    expect(batch).toEqual(before);
  });
  it.each(['hash', 'batch', 'state', 'rule', 'prepared', 'manifest', 'extra'])(
    'rejects %s mismatch or an unexplained non-ready member',
    (change) => {
      const alteredBatch = structuredClone(batch),
        alteredCheck = structuredClone(check);
      if (change === 'hash') alteredCheck.original.sha256 = '2'.repeat(64);
      if (change === 'batch') alteredCheck.reference.processingBatchId = id(90);
      if (change === 'state') alteredCheck.state = 'NOT_EQUIVALENT';
      if (change === 'rule') alteredCheck.rule.version = '2.0.0';
      if (change === 'prepared') alteredBatch.assets[1]!.status = 'PARTIAL';
      if (change === 'manifest')
        alteredBatch.assets[2]!.reason = 'UNSUPPORTED_FORMAT';
      if (change === 'extra')
        alteredBatch.assets.push({
          ...alteredBatch.assets[0]!,
          assetId: id(91),
        });
      expect(
        candidateConversionEligibility(alteredBatch, alteredCheck, check.rule)
          .eligible,
      ).toBe(false);
    },
  );
});

it.each(['UNSUPPORTED', 'INVALID', 'PARTIAL', 'READY'])(
  'retains actual DOC status %s while verified P is eligible',
  (status) => {
    const actual = structuredClone(batch);
    actual.assets[0]!.status = status;
    actual.assets[0]!.reason =
      status === 'UNSUPPORTED'
        ? 'PARSER_NOT_CONFIGURED'
        : status === 'READY'
          ? (null as never)
          : 'PARSING_FAILED';
    if (status === 'PARTIAL' || status === 'READY') {
      actual.assets[0]!.recordCount = 1;
      actual.assets[0]!.featureCount = 0;
    }
    const before = structuredClone(actual);
    expect(candidateConversionEligibility(actual, check, check.rule)).toEqual({
      eligible: true,
      preparedAssetId: id(4),
    });
    expect(actual).toEqual(before);
  },
);
