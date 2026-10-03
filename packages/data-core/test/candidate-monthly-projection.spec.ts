import { describe, expect, it } from 'vitest';
import type {
  IngestionCandidateBatch,
  IngestionCandidateRecord,
  IngestionCandidateRecordPage,
  IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  projectCandidateMonthlyReport,
  type CandidateMonthlyProjectionInput,
  type CandidateMonthlyUnparsedReason,
} from '../src/candidate-monthly-projection.js';

const reference: IngestionCandidateReference = {
  kind: 'ingestion-candidate',
  ingestionId: '10000000-0000-4000-8000-000000000001',
  reviewHash: 'a'.repeat(64),
  processingBatchId: '10000000-0000-4000-8000-000000000002',
};
const assetId = '10000000-0000-4000-8000-000000000003';
const sourceHash = 'b'.repeat(64);
const fixed = { workId: 'monthly-original-2024-label', assetId, sourceHash };
const columns = [
  { key: 'c1', label: 'Text' },
  { key: 'c2', label: 'Source location' },
  { key: 'c3', label: 'Source table structure' },
];

function paragraph(index: number, text: string): IngestionCandidateRecord {
  return {
    recordId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    assetId,
    index,
    sourceId: null,
    values: { c1: text, c2: `word/document.xml#paragraph:${index}` },
    hasGeometry: false,
  };
}

function cell(
  column: number,
  text: string,
  verticalMerge: 'restart' | 'continue' | null = null,
) {
  return { column, columnSpan: 1, verticalMerge, text };
}

function tableRow(
  index: number,
  tableIndex: number,
  rowIndex: number,
  cells: ReturnType<typeof cell>[],
): IngestionCandidateRecord {
  return {
    recordId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    assetId,
    index,
    sourceId: null,
    values: {
      c1: cells.map((entry) => entry.text).join(' | '),
      c2: `word/document.xml#table:${tableIndex}/row:${rowIndex}`,
      c3: {
        kind: 'word_table_row',
        sourcePart: 'word/document.xml',
        tableIndex,
        rowIndex,
        cells,
      },
    },
    hasGeometry: false,
  };
}

function fixture() {
  const records: IngestionCandidateRecord[] = [
    paragraph(1, '表1     2023年4月河流水质状况'),
    paragraph(2, '表2        2023年4月重点湖泊水质状况'),
    paragraph(3, '表3      2023年4月大中型水库水质状况'),
    tableRow(4, 1, 1, [
      cell(1, '水系'),
      cell(2, '河流（河段）'),
      cell(3, '所在区'),
      cell(4, '现状水质类别'),
    ]),
    tableRow(5, 1, 2, [
      cell(1, '永定河水系', 'restart'),
      cell(2, '永定河山峡段\n（官厅坝下-三家店）'),
      cell(3, '门头沟'),
      cell(4, 'Ⅱ'),
    ]),
    tableRow(6, 1, 3, [
      cell(1, '', 'continue'),
      cell(2, '清水涧'),
      cell(3, '门头沟'),
      cell(4, '无水'),
    ]),
    tableRow(7, 2, 1, [
      cell(1, '湖泊'),
      cell(2, '所在区'),
      cell(3, '现状水质类别'),
    ]),
    tableRow(8, 2, 2, [cell(1, '团城湖'), cell(2, '海淀'), cell(3, 'Ⅱ')]),
    tableRow(9, 3, 1, [
      cell(1, '水库'),
      cell(2, '所在区'),
      cell(3, '现状水质类别'),
    ]),
    tableRow(10, 3, 2, [
      cell(1, '密云水库'),
      cell(2, '密云'),
      cell(3, '封闭无法监测'),
    ]),
    tableRow(11, 4, 1, [cell(1, '水质类别'), cell(2, '适用范围')]),
    tableRow(12, 4, 2, [cell(1, 'I类'), cell(2, '主要适用于源头水')]),
  ];
  const batch: IngestionCandidateBatch = {
    reference,
    parserVersion: 'docx-1',
    status: 'READY',
    assets: [
      {
        assetId,
        sourceHash,
        status: 'READY',
        recordCount: records.length,
        featureCount: 0,
        reason: null,
      },
    ],
    createdAt: '2026-10-03T10:00:00Z',
  };
  const pages: IngestionCandidateRecordPage[] = [
    { reference, assetId, columns, records: records.slice(0, 6), nextCursor: 'next' },
    { reference, assetId, columns, records: records.slice(6), nextCursor: null },
  ];
  return { batch, pages, fixed };
}

function changedRecord(
  pages: readonly IngestionCandidateRecordPage[],
  index: number,
  change: (record: IngestionCandidateRecord) => IngestionCandidateRecord,
): IngestionCandidateRecordPage[] {
  return pages.map((page) => ({
    ...page,
    records: page.records.map((record) =>
      record.index === index ? change(record) : record,
    ),
  }));
}

function withCells(
  record: IngestionCandidateRecord,
  cells: ReturnType<typeof cell>[],
): IngestionCandidateRecord {
  const c3 = record.values.c3 as {
    kind: string;
    sourcePart: string;
    tableIndex: number;
    rowIndex: number;
  };
  return {
    ...record,
    values: {
      ...record.values,
      c1: cells.map((entry) => entry.text).join(' | '),
      c3: { ...c3, cells },
    },
  };
}

describe('fixed candidate monthly semantic projection', () => {
  it('derives publication month only from matching document titles and keeps exact raw categories and provenance', () => {
    const result = projectCandidateMonthlyReport(fixture());
    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') return;
    expect(result.publicationMonth).toBe('2023-04');
    expect(result.records).toHaveLength(4);
    expect(result.records[0]).toMatchObject({
      candidateReference: reference,
      source: { workId: fixed.workId, assetId, originalSha256: sourceHash },
      sourceLocalIdentity: { recordId: '10000000-0000-4000-8000-000000000005', index: 5 },
      objectType: 'RIVER_REACH',
      originalName: '永定河山峡段\n（官厅坝下-三家店）',
      waterSystemOriginal: '永定河水系',
      districtOriginal: '门头沟',
      rawCategory: 'Ⅱ',
      time: { value: '2023-04', role: 'PUBLICATION', precision: 'MONTH' },
      locators: {
        title: 'word/document.xml#paragraph:1',
        row: 'word/document.xml#table:1/row:2',
        nameCell: 'word/document.xml#table:1/row:2/cell:2',
        categoryCell: 'word/document.xml#table:1/row:2/cell:4',
      },
    });
    expect(result.records[1]).toMatchObject({
      originalName: '清水涧',
      waterSystemOriginal: '永定河水系',
      rawCategory: '无水',
      locators: {
        waterSystemCell: 'word/document.xml#table:1/row:2/cell:1',
        row: 'word/document.xml#table:1/row:3',
      },
    });
    expect(result.records[2]).toMatchObject({ objectType: 'LAKE', originalName: '团城湖' });
    expect(result.records[3]).toMatchObject({ objectType: 'RESERVOIR', rawCategory: '封闭无法监测' });
    expect(JSON.stringify(result)).not.toMatch(/versionId|geometryKey|observationDate/);
  });

  it('rejects partial, incomplete, mismatched or changed-original pages without partial projected rows', () => {
    const original = fixture();
    const cases: [CandidateMonthlyProjectionInput, CandidateMonthlyUnparsedReason][] = [
      [{ ...original, pages: original.pages.slice(0, 1) }, 'INCOMPLETE_RECORD_PAGES'],
      [{ ...original, pages: [{ ...original.pages[0]!, nextCursor: null }, original.pages[1]!] }, 'INCOMPLETE_RECORD_PAGES'],
      [{ ...original, batch: { ...original.batch, status: 'PARTIAL' } }, 'SOURCE_NOT_READY'],
      [{ ...original, fixed: { ...fixed, sourceHash: 'c'.repeat(64) } }, 'SOURCE_CHANGED'],
      [{ ...original, pages: [{ ...original.pages[0]!, reference: { ...reference, reviewHash: 'c'.repeat(64) } }, original.pages[1]!] }, 'SOURCE_CHANGED'],
    ];
    for (const [input, reason] of cases) {
      const result = projectCandidateMonthlyReport(input);
      expect(result.kind).toBe('NOT_PARSED');
      expect(result.records).toEqual([]);
      expect(result.reason).toBe(reason);
    }
  });

  it('refuses conflicting titles, an unrecognized header and missing physical structure', () => {
    const original = fixture();
    const cases = [
      changedRecord(original.pages, 2, (record) => ({ ...record, values: { ...record.values, c1: '表2 2023年5月重点湖泊水质状况' } })),
      changedRecord(original.pages, 4, (record) => withCells(record, [cell(1, '水系'), cell(2, '河流'), cell(3, '所在区'), cell(4, '现状水质类别')])),
      changedRecord(original.pages, 6, (record) => {
        const values = { ...record.values };
        delete values.c3;
        return { ...record, values };
      }),
    ];
    for (const pages of cases) {
      const result = projectCandidateMonthlyReport({ ...original, pages });
      expect(result.kind).toBe('NOT_PARSED');
      expect(result.records).toEqual([]);
      expect(result.reason).toBe('UNKNOWN_LAYOUT');
    }
  });

  it('fails closed on a malformed vertical continuation or unrecognized merged column', () => {
    const original = fixture();
    for (const mutation of [
      (cells: ReturnType<typeof cell>[]) => [{ ...cells[0]!, verticalMerge: 'continue' as const }, ...cells.slice(1)],
      (cells: ReturnType<typeof cell>[]) => [cells[0]!, { ...cells[1]!, columnSpan: 2 }, ...cells.slice(2)],
    ]) {
      const pages = changedRecord(original.pages, 5, (record) => {
        const c3 = record.values.c3 as { cells: ReturnType<typeof cell>[] };
        return withCells(record, mutation(c3.cells));
      });
      expect(projectCandidateMonthlyReport({ ...original, pages })).toMatchObject({ kind: 'NOT_PARSED', reason: 'UNKNOWN_LAYOUT', records: [] });
    }
  });
});
