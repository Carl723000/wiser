import { createHash } from 'node:crypto';

const locator = (row, column) =>
  `word/document.xml#table:${row.tableIndex}/row:${row.rowIndex}/column:${column}`;
const normalize = (text) => text.trim().replace(/\s+/g, '');
const categories = new Set(['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', '劣Ⅴ']);

/** Physical cells stay verbatim. Only explicit water-system vertical merges are resolved. */
export function extractMonthly(input) {
  if (
    !Array.isArray(input.tables) ||
    input.tables.some(
      (row) =>
        !Array.isArray(row.cells) ||
        row.cells.some((cell) => typeof cell.text !== 'string'),
    )
  )
    throw new Error('INVALID_TABLE_INPUT');
  if (
    !Array.isArray(input.dateContext) ||
    input.dateContext.some((value) => typeof value.text !== 'string')
  )
    throw new Error('INVALID_DATE_INPUT');
  const months = [
    ...new Set(
      input.dateContext.flatMap(({ text }) =>
        [...text.matchAll(/(20\d{2})年\s*(\d{1,2})月/g)]
          .filter((match) => Number(match[2]) >= 1 && Number(match[2]) <= 12)
          .map((match) => `${match[1]}-${match[2].padStart(2, '0')}`),
      ),
    ),
  ];
  const month = months.length === 1 ? months[0] : null;
  const findings =
    months.length === 1
      ? []
      : [
          {
            code: months.length ? 'AMBIGUOUS_MONTH' : 'MONTH_MISSING',
            values: months,
          },
        ];
  const rows = [];
  const excludedRows = [];
  const layouts = new Map();
  const mergedSystems = new Map();
  for (const row of input.tables) {
    const byColumn = new Map(row.cells.map((cell) => [cell.column, cell]));
    const valueHeader = row.cells.find(
      (cell) => normalize(cell.text) === '现状水质类别',
    );
    const targetHeader = row.cells.find((cell) =>
      ['河流（河段）', '湖泊', '水库'].includes(normalize(cell.text)),
    );
    const areaHeader = row.cells.find(
      (cell) => normalize(cell.text) === '所在区',
    );
    if (valueHeader && targetHeader && areaHeader) {
      layouts.set(row.tableIndex, {
        value: valueHeader.column,
        target: targetHeader.column,
        area: areaHeader.column,
        system:
          row.cells.find((cell) => normalize(cell.text) === '水系')?.column ??
          null,
        kind: normalize(targetHeader.text),
      });
      continue;
    }
    const layout = layouts.get(row.tableIndex);
    if (!layout) continue;
    const target = byColumn.get(layout.target);
    const area = byColumn.get(layout.area);
    const value = byColumn.get(layout.value);
    if (
      !target ||
      !area ||
      !value ||
      [target, area, value].some(
        (cell) => cell.columnSpan !== 1 || cell.verticalMerge !== null,
      )
    ) {
      const finding = {
        code: 'MERGED_TARGET_CELL',
        locator: locator(row, layout.target),
      };
      findings.push(finding);
      excludedRows.push({ ...row, reason: finding.code });
      continue;
    }
    if (![target.text, area.text, value.text].some((text) => text.trim()))
      continue;
    const system = layout.system === null ? null : byColumn.get(layout.system);
    let waterSystem = system?.text ?? null;
    let waterSystemLocator = system ? locator(row, layout.system) : null;
    if (system?.verticalMerge === 'restart')
      mergedSystems.set(row.tableIndex, {
        text: system.text,
        locator: waterSystemLocator,
      });
    else if (system?.verticalMerge === 'continue') {
      const origin = mergedSystems.get(row.tableIndex);
      if (!origin)
        findings.push({
          code: 'WATER_SYSTEM_ORIGIN_MISSING',
          locator: waterSystemLocator,
        });
      waterSystem = origin?.text ?? null;
      waterSystemLocator = origin?.locator ?? null;
    } else if (system) mergedSystems.delete(row.tableIndex);
    const objectKey = `${layout.kind}\0${row.tableIndex}\0${target.text}\0${area.text}\0${waterSystemLocator ?? ''}`;
    rows.push({
      id: `${input.sourceId}:t${row.tableIndex}:r${row.rowIndex}`,
      objectId: `${input.sourceId}:object:${createHash('sha256').update(objectKey).digest('hex').slice(0, 20)}`,
      tableIndex: row.tableIndex,
      rowIndex: row.rowIndex,
      objectLabel: target.text,
      area: area.text,
      waterSystem,
      waterSystemLocator,
      waterSystemRaw: system?.text ?? null,
      rawValue: value.text,
      categoryValid: categories.has(normalize(value.text)),
      unit: null,
      month,
      metric: '现状水质类别',
      valueLocator: locator(row, layout.value),
      objectLocator: locator(row, layout.target),
      areaLocator: locator(row, layout.area),
    });
  }
  return {
    sourceId: input.sourceId,
    originalSha256: input.originalSha256,
    month,
    rows,
    findings,
    excludedRows,
  };
}

/** Journal signatures bind both content and a named rule dependency. */
export function processBatch(inputs, previousJournal = {}, options = {}) {
  const unique = new Map();
  for (const input of inputs) {
    const existing = unique.get(input.sourceId);
    if (
      existing &&
      (existing.originalSha256 !== input.originalSha256 ||
        JSON.stringify(existing) !== JSON.stringify(input))
    )
      throw new Error('CONFLICTING_VERSION');
    unique.set(input.sourceId, input);
  }
  const journal = { ...previousJournal };
  const outputs = [];
  const invalidated = [];
  let processed = 0;
  let reused = 0;
  for (const input of unique.values()) {
    const ruleKey = input.ruleKey ?? 'monthly';
    const ruleVersion = options.rules?.[ruleKey];
    if (typeof ruleVersion !== 'string' || !ruleVersion)
      throw new Error('RULE_VERSION_REQUIRED');
    const inputDigest = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const old = journal[input.sourceId];
    const same =
      old &&
      old.originalSha256 === input.originalSha256 &&
      old.ruleKey === ruleKey &&
      old.ruleVersion === ruleVersion &&
      old.inputDigest === inputDigest;
    if (same) {
      outputs.push(old.output);
      reused++;
      continue;
    }
    if (processed >= (options.stopAfter ?? Infinity))
      return {
        completed: false,
        journal,
        outputs,
        processed,
        reused,
        invalidated,
      };
    if (old)
      invalidated.push({
        sourceId: input.sourceId,
        previousVersionId: old.originalSha256,
        nextVersionId: input.originalSha256,
        reason:
          old.originalSha256 !== input.originalSha256
            ? 'original-revised'
            : old.ruleVersion !== ruleVersion || old.ruleKey !== ruleKey
              ? 'rule-changed'
              : 'derived-input-revised',
      });
    const output = extractMonthly(input);
    journal[input.sourceId] = {
      originalSha256: input.originalSha256,
      ruleKey,
      ruleVersion,
      inputDigest,
      output,
    };
    outputs.push(output);
    processed++;
  }
  return { completed: true, journal, outputs, processed, reused, invalidated };
}
