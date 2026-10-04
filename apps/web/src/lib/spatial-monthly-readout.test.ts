import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import {
  calculateProjectReadiness,
  readinessRecordKey,
  type ProjectReadinessInput,
  type ProjectReadinessRecord,
  type ProjectReadinessSource,
} from '@wiser/data-core/project-readiness';
import { buildMonthlyReadout } from './spatial-monthly-readout';

// Synthetic ordinary-UI fixtures; the computation is the actual frozen core.
function source(id: string): ProjectReadinessSource {
  return {
    workId: `synthetic-work-${id}`,
    versionId: `fixed-version-${id}`,
    assetId: `original-asset-${id}`,
    track: 'SYNTHETIC',
    kind: 'MONTHLY_REPORT',
    needIds: ['K5-001'],
    regionIds: ['chaobai'],
  };
}

function record(
  s: ProjectReadinessSource,
  month: string | null,
  rawValue: string | number | null,
  id = 'table:1/row:5',
): ProjectReadinessRecord {
  return {
    id,
    source: s,
    needIds: s.needIds,
    regionIds: s.regionIds,
    object: {
      key: 'river-reach',
      originalName: '原表河段',
      markers: [],
      footnotes: [],
    },
    series: { id: 'declared-series', version: 'fixed-series-v1' },
    time: { value: month, role: 'PUBLICATION', precision: 'MONTH' },
    rawValue,
    metric: null,
    parsing: 'READY',
    professionalState: 'PENDING_REVIEW',
    evidence: [{ source: s, locator: id, excerpt: 'Synthetic source row.' }],
    spatial: null,
  };
}

function input(
  records: readonly ProjectReadinessRecord[],
): ProjectReadinessInput {
  const sources = Array.from(
    new Map(records.map((r) => [JSON.stringify(r.source), r.source])).values(),
  ) as ProjectReadinessSource[];
  return {
    track: 'SYNTHETIC',
    requirement: {
      needId: 'K5-001',
      version: 'fixture-need-v1',
      regionId: 'chaobai',
      purpose: 'category-reading',
      dateRole: 'PUBLICATION',
      window: { start: '2023-01', end: '2023-09' },
    },
    sources,
    records,
    series: sources.length
      ? [
          {
            id: 'declared-series',
            version: 'fixed-series-v1',
            sources,
            evidence: [
              {
                source: sources[0],
                locator: 'series/title',
                excerpt: 'Explicit synthetic series declaration.',
              },
            ],
          },
        ]
      : [],
    correspondences: [],
  };
}

test('monthly cells retain all original value kinds, typed zero and evidence keys', () => {
  const rawValues = ['Ⅱ', 'Ⅱ～Ⅲ', '无水', '封闭无法监测', null, '', 0, '0'];
  const expectedKinds = [
    'CATEGORY',
    'CATEGORY_RANGE',
    'DRY',
    'UNMONITORED',
    'NULL',
    'EMPTY',
    'NUMERIC',
    'NUMERIC',
  ];
  const records = rawValues.map((raw, i) =>
    record(source(String(i)), `2023-0${i + 1}`, raw),
  );
  const project = calculateProjectReadiness(input(records));
  const rows = buildMonthlyReadout(project);
  assert.equal(rows.length, 1);
  const actual = rows[0].cells.slice(0, 8).map((cell) => cell.entries[0]);
  assert.deepEqual(
    actual.map((entry) => entry.value.raw),
    rawValues,
  );
  assert.deepEqual(
    actual.map((entry) => entry.value.kind),
    expectedKinds,
  );
  assert.deepEqual(
    actual.map((entry) => entry.recordKey),
    records.map(readinessRecordKey),
  );
  assert.equal(rows[0].cells[8].state, 'MISSING');
  assert.ok(
    rows[0].cells.slice(0, 8).every((cell) => cell.state === 'PRESENT'),
  );
});

test('same-month values with a repeated source-local ID keep both fixed sources', () => {
  const records = [
    record(source('a'), '2023-01', 'Ⅱ'),
    record(source('b'), '2023-01', 'Ⅳ'),
  ];
  const project = calculateProjectReadiness(input(records));
  const cells = buildMonthlyReadout(project)[0].cells;
  assert.equal(cells[0].entries.length, 2);
  assert.deepEqual(
    cells[0].entries.map((entry) => entry.value.raw),
    ['Ⅱ', 'Ⅳ'],
  );
  assert.deepEqual(
    cells[0].entries.map((entry) => entry.recordKey),
    records.map(readinessRecordKey),
  );
  assert.equal(cells[0].entries[0].record.source.versionId, 'fixed-version-a');
  assert.equal(cells[0].entries[1].record.source.versionId, 'fixed-version-b');
});

test('a different time role stays outside monthly cells and does not certify missing months', () => {
  const records = [
    record(source('a'), '2023-01', 'Ⅱ'),
    {
      ...record(source('b'), '2023-02', 'Ⅲ'),
      time: {
        value: '2023-02',
        role: 'OBSERVATION' as const,
        precision: 'MONTH' as const,
      },
    },
  ];
  const project = calculateProjectReadiness(input(records));
  const row = buildMonthlyReadout(project)[0];
  assert.equal(row.coverageKnown, false);
  assert.equal(row.cells[1].state, 'UNKNOWN');
  assert.deepEqual(row.cells[1].entries, []);
  assert.equal(row.unknownTimeEntries[0].value.raw, 'Ⅲ');
  assert.equal(
    row.unknownTimeEntries[0].recordKey,
    readinessRecordKey(records[1]),
  );
});

test('no declared window creates no artificial empty months', () => {
  const f = input([record(source('a'), '2023-02', 'Ⅱ')]);
  const project = calculateProjectReadiness({
    ...f,
    requirement: { ...f.requirement, window: null },
  });
  const row = buildMonthlyReadout(project)[0];
  assert.equal(row.coverageKnown, false);
  assert.deepEqual(
    row.cells.map((cell) => cell.month),
    ['2023-02'],
  );
  assert.equal(row.cells[0].required, false);
});

test('same names in unrelated declared series remain separate until an explicit correspondence', () => {
  const a = record(source('a'), '2023-01', 'Ⅱ');
  const b = {
    ...record(source('b'), '2023-02', 'Ⅲ'),
    series: { id: 'another-series', version: 'fixed-series-v1' },
  };
  const f = input([a, b]);
  const series = [...f.series, { ...f.series[0], id: 'another-series' }];
  const project = calculateProjectReadiness({ ...f, series });
  const rows = buildMonthlyReadout(project);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.objectKeys),
    project.monthly.raw.map((row) => row.objectKeys),
  );
  assert.deepEqual(
    rows.flatMap((row) =>
      row.cells.flatMap((cell) => cell.entries.map((entry) => entry.recordKey)),
    ),
    [readinessRecordKey(a), readinessRecordKey(b)],
  );
});

test('hypothesis mode follows the existing correspondence without changing raw membership', () => {
  const a = record(source('a'), '2023-01', 'Ⅱ');
  const b = {
    ...record(source('b'), '2023-02', 'Ⅲ'),
    object: { ...a.object!, originalName: '另一个原名' },
  };
  const f = input([a, b]);
  const project = calculateProjectReadiness({
    ...f,
    correspondences: [
      {
        id: 'pending-correspondence',
        memberRecordIds: [readinessRecordKey(a), readinessRecordKey(b)],
        status: 'PENDING_REVIEW',
        evidence: a.evidence,
      },
    ],
  });
  assert.equal(buildMonthlyReadout(project).length, 2);
  assert.equal(buildMonthlyReadout(project, 'approved').length, 2);
  const hypothesis = buildMonthlyReadout(project, 'hypothetical');
  assert.equal(hypothesis.length, 1);
  assert.deepEqual(
    hypothesis[0].objectKeys,
    project.monthly.hypothetical[0].objectKeys,
  );
  assert.deepEqual(hypothesis[0].originalNames, ['原表河段', '另一个原名']);
  assert.equal(project.records[0].professionalState, 'PENDING_REVIEW');
});

test('year precision and unparsed rows are unknown-month entries rather than inferred month observations', () => {
  const records = [
    {
      ...record(source('a'), '2023', 'Ⅲ'),
      time: {
        value: '2023',
        role: 'PUBLICATION' as const,
        precision: 'YEAR' as const,
      },
    },
    { ...record(source('b'), '2023-02', '无水'), parsing: 'PARTIAL' as const },
  ];
  const row = buildMonthlyReadout(calculateProjectReadiness(input(records)))[0];
  assert.ok(
    row.cells.every(
      (cell) => cell.state === 'UNKNOWN' && cell.entries.length === 0,
    ),
  );
  assert.deepEqual(
    row.unknownTimeEntries.map((entry) => entry.value.raw),
    ['Ⅲ', '无水'],
  );
});

test('a document value in the same result never enters monthly coverage', () => {
  const a = record(source('a'), '2023-01', 'Ⅱ');
  const otherSource = { ...source('doc'), kind: 'DOCUMENT' as const };
  const b = record(otherSource, '2023-01', 'private-non-monthly-value');
  const row = buildMonthlyReadout(calculateProjectReadiness(input([a, b])))[0];
  assert.deepEqual(
    row.cells[0].entries.map((entry) => entry.value.raw),
    ['Ⅱ'],
  );
  assert.ok(!JSON.stringify(row).includes('private-non-monthly-value'));
});

test('a newly recomputed empty permission scope retains no old row names or values', () => {
  const f = input([record(source('a'), '2023-01', 'Ⅱ')]);
  assert.equal(buildMonthlyReadout(calculateProjectReadiness(f)).length, 1);
  const noCurrentMembers = calculateProjectReadiness({
    ...f,
    sources: [],
    records: [],
    series: [],
  });
  assert.deepEqual(buildMonthlyReadout(noCurrentMembers), []);
});

test('opposite-track records do not become visible monthly cells', () => {
  const f = input([record(source('a'), '2023-01', 'Ⅱ')]);
  const project = calculateProjectReadiness({ ...f, track: 'REAL' });
  assert.equal(project.counts.records, 0);
  assert.deepEqual(buildMonthlyReadout(project), []);
});

test('orphan values never create a readout entry or match only a local record ID', () => {
  const project = calculateProjectReadiness(
    input([record(source('a'), '2023-01', 'Ⅱ')]),
  );
  const withoutFixedValue = {
    ...project,
    values: [
      { ...project.values[0], recordId: 'table:1/row:5', raw: 'wrong-value' },
    ],
  };
  const row = buildMonthlyReadout(withoutFixedValue)[0];
  assert.deepEqual(row.cells[0].entries, []);
  assert.equal(row.cells[0].state, 'UNKNOWN');
  assert.deepEqual(row.unresolvedRecordKeys, project.monthly.raw[0].recordIds);
  assert.ok(!JSON.stringify(row).includes('wrong-value'));
});
