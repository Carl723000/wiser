import {
  IngestionCandidateBatchSchema,
  IngestionCandidateRecordPageSchema,
  jsonUtf8Bytes,
  type IngestionCandidateRecord,
  type IngestionCandidateBatch,
  type IngestionCandidateRecordPage,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';

export const CANDIDATE_MONTHLY_RULE_VERSION = 'beijing-monthly-docx-c3/1.0.0';

export interface CandidateMonthlyProjectionInput {
  readonly batch: IngestionCandidateBatch;
  readonly pages: readonly IngestionCandidateRecordPage[];
  readonly fixed: {
    readonly workId: string;
    readonly assetId: string;
    readonly sourceHash: string;
  };
}

export interface CandidateMonthlyProjectedRecord {
  readonly candidateReference: IngestionCandidateReference;
  readonly source: {
    readonly workId: string;
    readonly assetId: string;
    readonly originalSha256: string;
  };
  readonly sourceLocalIdentity: {
    readonly recordId: string;
    readonly sourceId: string | null;
    readonly index: number;
  };
  readonly objectType: 'RIVER_REACH' | 'LAKE' | 'RESERVOIR';
  readonly originalName: string;
  readonly waterSystemOriginal: string | null;
  readonly districtOriginal: string;
  readonly rawCategory: string;
  readonly time: {
    readonly value: string;
    readonly role: 'PUBLICATION';
    readonly precision: 'MONTH';
  };
  readonly locators: {
    readonly title: string;
    readonly row: string;
    readonly nameCell: string;
    readonly categoryCell: string;
    readonly districtCell: string;
    readonly waterSystemCell: string | null;
  };
  readonly processingRuleVersion: typeof CANDIDATE_MONTHLY_RULE_VERSION;
}

export type CandidateMonthlyUnparsedReason =
  | 'INVALID_INPUT'
  | 'INCOMPLETE_RECORD_PAGES'
  | 'SOURCE_NOT_READY'
  | 'SOURCE_CHANGED'
  | 'UNKNOWN_LAYOUT';

export type CandidateMonthlyProjection =
  | {
      readonly kind: 'READY';
      readonly reason: null;
      readonly ruleVersion: typeof CANDIDATE_MONTHLY_RULE_VERSION;
      readonly publicationMonth: string;
      readonly records: readonly CandidateMonthlyProjectedRecord[];
    }
  | {
      readonly kind: 'NOT_PARSED';
      readonly reason: CandidateMonthlyUnparsedReason;
      readonly ruleVersion: typeof CANDIDATE_MONTHLY_RULE_VERSION;
      readonly publicationMonth: null;
      readonly records: readonly [];
    };

interface WordCell {
  readonly column: number;
  readonly columnSpan: 1;
  readonly verticalMerge: 'restart' | 'continue' | null;
  readonly text: string;
}

interface WordTableRow {
  readonly kind: 'word_table_row';
  readonly sourcePart: 'word/document.xml';
  readonly tableIndex: number;
  readonly rowIndex: number;
  readonly cells: readonly WordCell[];
}

interface LocatedTableRow {
  readonly record: IngestionCandidateRecord;
  readonly structure: WordTableRow;
  readonly locator: string;
}

const tableHeaders: Readonly<Record<number, readonly string[]>> = {
  1: ['水系', '河流（河段）', '所在区', '现状水质类别'],
  2: ['湖泊', '所在区', '现状水质类别'],
  3: ['水库', '所在区', '现状水质类别'],
  4: ['水质类别', '适用范围'],
};
const titleSuffixes: Readonly<Record<number, string>> = {
  1: '河流水质状况',
  2: '重点湖泊水质状况',
  3: '大中型水库水质状况',
};
const MAX_PAGES = 100;
const MAX_RECORDS = 10_000;
const MAX_PAGE_SET_BYTES = 16 * 1024 * 1024;

function unparsed(
  reason: CandidateMonthlyUnparsedReason,
): CandidateMonthlyProjection {
  return {
    kind: 'NOT_PARSED',
    reason,
    ruleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
    publicationMonth: null,
    records: [],
  };
}

function sameReference(
  left: IngestionCandidateReference,
  right: IngestionCandidateReference,
): boolean {
  return (
    left.kind === right.kind &&
    left.ingestionId.toLowerCase() === right.ingestionId.toLowerCase() &&
    left.reviewHash === right.reviewHash &&
    left.processingBatchId.toLowerCase() ===
      right.processingBatchId.toLowerCase()
  );
}

function wordRow(value: unknown): WordTableRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const row = value as Record<string, unknown>;
  if (
    row.kind !== 'word_table_row' ||
    row.sourcePart !== 'word/document.xml' ||
    !Number.isSafeInteger(row.tableIndex) ||
    !Number.isSafeInteger(row.rowIndex) ||
    (row.tableIndex as number) < 1 ||
    (row.tableIndex as number) > 4 ||
    (row.rowIndex as number) < 1 ||
    !Array.isArray(row.cells)
  )
    return null;
  const width = tableHeaders[row.tableIndex as number]?.length;
  if (row.cells.length !== width) return null;
  for (const [index, value] of row.cells.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return null;
    const current = value as Record<string, unknown>;
    if (
      current.column !== index + 1 ||
      current.columnSpan !== 1 ||
      ![null, 'restart', 'continue'].includes(current.verticalMerge as null) ||
      typeof current.text !== 'string'
    )
      return null;
  }
  return row as unknown as WordTableRow;
}

function title(value: string): { table: number; month: string } | null {
  const normalized = value.replace(/[ \t\u3000]+/gu, '');
  const match = /^表([123])((?:19|20)\d{2})年(1[0-2]|[1-9])月(.+)$/u.exec(
    normalized,
  );
  if (!match) return null;
  const table = Number(match[1]);
  if (match[4] !== titleSuffixes[table]) return null;
  return {
    table,
    month: `${match[2]}-${String(Number(match[3])).padStart(2, '0')}`,
  };
}

function cellLocator(row: LocatedTableRow, column: number): string {
  return `${row.locator}/column:${column}`;
}

/** Pure projection only: the candidate authority and current read permission live upstream. */
export function projectCandidateMonthlyReport(
  input: CandidateMonthlyProjectionInput,
): CandidateMonthlyProjection {
  if (input.batch.status !== 'READY') return unparsed('SOURCE_NOT_READY');
  if (
    !input.fixed.workId.trim() ||
    input.fixed.workId.length > 256 ||
    !/^[a-f0-9]{64}$/u.test(input.fixed.sourceHash)
  )
    return unparsed('INVALID_INPUT');
  const batch = IngestionCandidateBatchSchema.safeParse(input.batch);
  if (!batch.success) return unparsed('INVALID_INPUT');
  const original = batch.data.assets.find(
    (asset) =>
      asset.assetId.toLowerCase() === input.fixed.assetId.toLowerCase(),
  );
  if (!original || original.sourceHash !== input.fixed.sourceHash)
    return unparsed('SOURCE_CHANGED');
  if (original.status !== 'READY' || original.recordCount === null)
    return unparsed('SOURCE_NOT_READY');
  if (
    original.recordCount < 1 ||
    original.recordCount > MAX_RECORDS ||
    input.pages.length < 1 ||
    input.pages.length > MAX_PAGES
  )
    return unparsed('INCOMPLETE_RECORD_PAGES');

  const records: IngestionCandidateRecord[] = [];
  let expectedIndex = 1;
  let columns: string | null = null;
  let totalPageBytes = 0;
  const seenIds = new Set<string>();
  for (const [pageIndex, inputPage] of input.pages.entries()) {
    const parsedPage = IngestionCandidateRecordPageSchema.safeParse(inputPage);
    if (!parsedPage.success) return unparsed('INVALID_INPUT');
    const page = parsedPage.data;
    totalPageBytes += jsonUtf8Bytes(page);
    if (totalPageBytes > MAX_PAGE_SET_BYTES) return unparsed('INVALID_INPUT');
    if (
      !sameReference(page.reference, batch.data.reference) ||
      page.assetId.toLowerCase() !== original.assetId.toLowerCase()
    )
      return unparsed('SOURCE_CHANGED');
    if (
      page.records.length === 0 ||
      pageIndex < input.pages.length - 1 !== (page.nextCursor !== null)
    )
      return unparsed('INCOMPLETE_RECORD_PAGES');
    const pageColumns = JSON.stringify(page.columns);
    if (columns !== null && pageColumns !== columns)
      return unparsed('UNKNOWN_LAYOUT');
    columns = pageColumns;
    for (const [key, label] of [
      ['c1', 'Text'],
      ['c2', 'Source location'],
      ['c3', 'Source table structure'],
    ]) {
      if (
        !page.columns.some(
          (column) => column.key === key && column.label === label,
        )
      )
        return unparsed('UNKNOWN_LAYOUT');
    }
    for (const record of page.records) {
      if (
        record.index !== expectedIndex++ ||
        seenIds.has(record.recordId.toLowerCase()) ||
        record.hasGeometry
      )
        return unparsed('INCOMPLETE_RECORD_PAGES');
      seenIds.add(record.recordId.toLowerCase());
      records.push(record);
    }
  }
  if (records.length !== original.recordCount)
    return unparsed('INCOMPLETE_RECORD_PAGES');

  const titles = new Map<number, { month: string; locator: string }>();
  const tables = new Map<number, LocatedTableRow[]>();
  let lastTable = 0;
  for (const record of records) {
    const { c1, c2, c3 } = record.values;
    if (typeof c1 !== 'string' || typeof c2 !== 'string')
      return unparsed('UNKNOWN_LAYOUT');
    if (/^word\/document\.xml#paragraph:[1-9]\d*$/u.test(c2)) {
      if (lastTable !== 0 || c3 !== undefined)
        return unparsed('UNKNOWN_LAYOUT');
      const normalized = c1.replace(/[ \t\u3000]+/gu, '');
      if (!/^表[123]\d{4}年\d{1,2}月/u.test(normalized)) continue;
      const parsed = title(c1);
      if (!parsed || titles.has(parsed.table))
        return unparsed('UNKNOWN_LAYOUT');
      titles.set(parsed.table, { month: parsed.month, locator: c2 });
      continue;
    }
    const structure = wordRow(c3);
    if (
      !structure ||
      c2 !==
        `word/document.xml#table:${structure.tableIndex}/row:${structure.rowIndex}` ||
      c1 !== structure.cells.map((cell) => cell.text).join(' | ') ||
      structure.tableIndex < lastTable
    )
      return unparsed('UNKNOWN_LAYOUT');
    lastTable = structure.tableIndex;
    const table = tables.get(structure.tableIndex) ?? [];
    if (structure.rowIndex !== table.length + 1)
      return unparsed('UNKNOWN_LAYOUT');
    table.push({ record, structure, locator: c2 });
    tables.set(structure.tableIndex, table);
  }
  if (titles.size !== 3 || tables.size !== 4) return unparsed('UNKNOWN_LAYOUT');
  const publicationMonth = titles.get(1)?.month;
  if (
    !publicationMonth ||
    [2, 3].some((number) => titles.get(number)?.month !== publicationMonth)
  )
    return unparsed('UNKNOWN_LAYOUT');
  for (let number = 1; number <= 4; number++) {
    const table = tables.get(number);
    const expected = tableHeaders[number];
    if (!table || table.length < 2 || !expected)
      return unparsed('UNKNOWN_LAYOUT');
    const header = table[0]?.structure.cells;
    if (
      !header ||
      header.some(
        (cell, index) =>
          cell.text !== expected[index] || cell.verticalMerge !== null,
      )
    )
      return unparsed('UNKNOWN_LAYOUT');
  }

  const projected: CandidateMonthlyProjectedRecord[] = [];
  let waterSystem: { text: string; locator: string } | null = null;
  for (let tableNumber = 1; tableNumber <= 4; tableNumber++) {
    const table = tables.get(tableNumber)!;
    const titleLocator = titles.get(tableNumber)?.locator;
    for (const row of table.slice(1)) {
      const cells = row.structure.cells;
      if (tableNumber === 4) {
        if (cells.some((cell) => cell.verticalMerge !== null))
          return unparsed('UNKNOWN_LAYOUT');
        continue;
      }
      const isRiver = tableNumber === 1;
      const nameColumn = isRiver ? 2 : 1;
      const districtColumn = isRiver ? 3 : 2;
      const categoryColumn = isRiver ? 4 : 3;
      const name = cells[nameColumn - 1];
      const district = cells[districtColumn - 1];
      const category = cells[categoryColumn - 1];
      if (
        !name ||
        !district ||
        !category ||
        !name.text.trim() ||
        [name, district, category].some((cell) => cell.verticalMerge !== null)
      )
        return unparsed('UNKNOWN_LAYOUT');
      if (isRiver) {
        const first = cells[0]!;
        if (first.verticalMerge === 'restart' && first.text.trim()) {
          waterSystem = { text: first.text, locator: cellLocator(row, 1) };
        } else if (
          first.verticalMerge !== 'continue' ||
          first.text !== '' ||
          !waterSystem
        ) {
          return unparsed('UNKNOWN_LAYOUT');
        }
      } else if (cells.some((cell) => cell.verticalMerge !== null)) {
        return unparsed('UNKNOWN_LAYOUT');
      }
      projected.push({
        candidateReference: batch.data.reference,
        source: {
          workId: input.fixed.workId,
          assetId: original.assetId,
          originalSha256: original.sourceHash,
        },
        sourceLocalIdentity: {
          recordId: row.record.recordId,
          sourceId: row.record.sourceId,
          index: row.record.index,
        },
        objectType: isRiver
          ? 'RIVER_REACH'
          : tableNumber === 2
            ? 'LAKE'
            : 'RESERVOIR',
        originalName: name.text,
        waterSystemOriginal: isRiver ? waterSystem!.text : null,
        districtOriginal: district.text,
        rawCategory: category.text,
        time: {
          value: publicationMonth,
          role: 'PUBLICATION',
          precision: 'MONTH',
        },
        locators: {
          title: titleLocator!,
          row: row.locator,
          nameCell: cellLocator(row, nameColumn),
          categoryCell: cellLocator(row, categoryColumn),
          districtCell: cellLocator(row, districtColumn),
          waterSystemCell: isRiver ? waterSystem!.locator : null,
        },
        processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
      });
    }
  }
  return {
    kind: 'READY',
    reason: null,
    ruleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
    publicationMonth,
    records: projected,
  };
}
