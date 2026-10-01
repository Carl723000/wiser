import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMonthly, processBatch } from './processor.mjs';

const cells = (values) =>
  values.map((text, i) => ({
    column: i + 1,
    columnSpan: 1,
    verticalMerge: null,
    text,
  }));
const row = (rowIndex, values, tableIndex = 1) => ({
  tableIndex,
  rowIndex,
  cells: cells(values),
});
const source = (id = 'monthly-2023-04') => ({
  sourceId: id,
  originalSha256: 'a'.repeat(64),
  dateContext: [{ text: '2023年4月河流水质状况', location: 'paragraph:1' }],
  tables: [
    row(1, ['水系', '河流（河段）', '所在区', '现状水质类别']),
    row(2, ['潮白河水系', '潮白河上段', '密云', 'Ⅲ']),
    row(3, ['', '白河', '密云', '无水']),
  ],
});

test('resolves only explicit water-system vertical merge, preserves source values and merge evidence', () => {
  const input = source();
  input.tables[1].cells[0].verticalMerge = 'restart';
  input.tables[2].cells[0].verticalMerge = 'continue';
  const result = extractMonthly(input);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[1].waterSystem, '潮白河水系');
  assert.equal(
    result.rows[1].waterSystemLocator,
    'word/document.xml#table:1/row:2/column:1',
  );
  assert.equal(result.rows[1].rawValue, '无水');
  assert.equal(result.rows[1].categoryValid, false);
  assert.equal(result.rows[0].unit, null);
  assert.equal(result.rows[0].month, '2023-04');
});

test('repeated page headings do not become records; column spans and ambiguous target merges are quarantined', () => {
  const input = source();
  input.tables.splice(
    2,
    0,
    row(3, ['水系', '河流（河段）', '所在区', '现状水质类别']),
  );
  input.tables[3].rowIndex = 4;
  input.tables[3].cells[1].columnSpan = 2;
  const result = extractMonthly(input);
  assert.equal(result.rows.length, 1);
  assert.equal(result.findings[0].code, 'MERGED_TARGET_CELL');
  assert.equal(result.excludedRows.length, 1);
});

test('conflicting title dates and unknown sentinels retain unknown, never zero or concentration', () => {
  const input = source();
  input.dateContext.push({
    text: '2023年5月湖泊水质',
    location: 'paragraph:2',
  });
  input.tables[1].cells[3].text = '-9999';
  const result = extractMonthly(input);
  assert.equal(result.rows[0].month, null);
  assert.equal(result.rows[0].rawValue, '-9999');
  assert.equal(result.rows[0].categoryValid, false);
  assert.ok(result.findings.some((f) => f.code === 'AMBIGUOUS_MONTH'));
});

test('malformed structures fail safely and do not fabricate tables', () => {
  assert.throws(
    () => extractMonthly({ ...source(), tables: null }),
    /INVALID_TABLE_INPUT/,
  );
  assert.throws(
    () => extractMonthly({ ...source(), dateContext: null }),
    /INVALID_DATE_INPUT/,
  );
});

test('interruption, resume, duplicate input and repeat runs are idempotent', () => {
  const inputs = [source('one'), source('two'), source('one')];
  const first = processBatch(
    inputs,
    {},
    { rules: { monthly: 'v1' }, stopAfter: 1 },
  );
  assert.equal(first.completed, false);
  assert.equal(Object.keys(first.journal).length, 1);
  const resumed = processBatch(inputs, first.journal, {
    rules: { monthly: 'v1' },
  });
  assert.equal(resumed.completed, true);
  assert.equal(resumed.outputs.length, 2);
  assert.equal(resumed.reused, 1);
  assert.equal(resumed.processed, 1);
  const repeated = processBatch(inputs, resumed.journal, {
    rules: { monthly: 'v1' },
  });
  assert.deepEqual(repeated.outputs, resumed.outputs);
  assert.equal(repeated.processed, 0);
});

test('source revisions and selected rule dependencies recompute only affected versions', () => {
  const inputs = [source('one'), source('two')];
  inputs[1].ruleKey = 'other';
  const first = processBatch(
    inputs,
    {},
    { rules: { monthly: 'v1', other: 'v1' } },
  );
  const changed = processBatch(inputs, first.journal, {
    rules: { monthly: 'v2', other: 'v1' },
  });
  assert.equal(changed.processed, 1);
  assert.equal(changed.reused, 1);
  assert.equal(changed.invalidated[0].reason, 'rule-changed');
  inputs[1].originalSha256 = 'b'.repeat(64);
  const revised = processBatch(inputs, changed.journal, {
    rules: { monthly: 'v2', other: 'v1' },
  });
  assert.equal(revised.processed, 1);
  assert.equal(revised.invalidated[0].reason, 'original-revised');
  assert.throws(
    () =>
      processBatch(
        [source('one'), { ...source('one'), originalSha256: 'c'.repeat(64) }],
        {},
        { rules: { monthly: 'v1' } },
      ),
    /CONFLICTING_VERSION/,
  );
});
