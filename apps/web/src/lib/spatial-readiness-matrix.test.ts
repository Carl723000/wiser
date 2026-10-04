import { describe, expect, it } from 'vitest';
import {
  buildReadinessMatrix,
  MATRIX_REGIONS,
} from './spatial-readiness-matrix';
import type {
  Material,
  WorkspacePack,
  WorkspaceRecord,
} from './spatial-workspace-contract';
import { parseWorkspacePack } from './spatial-workspace-pack';

const source: Material = {
  id: 'original',
  versionId: 'v1',
  title: 'Visible source',
  provider: 'Provider',
  kind: 'report',
  originalSha256: 'a'.repeat(64),
  evidenceUrl: null,
  rights: {
    public: true,
    displayAllowed: true,
    redistributionAllowed: false,
    note: 'Read only',
  },
  regionIds: ['chaobai', 'beiyun'],
  needIds: ['K5-001'],
  processingVersion: 'rule1',
  duplicateOf: null,
  status: {
    original: 'obtained',
    parsed: 'partial',
    checked: 'cells-verified',
    professionalReview: 'pending',
    space: 'text-only',
    use: 'inspect',
  },
};
const row: WorkspaceRecord = {
  id: 'physical-row',
  sourceId: 'original',
  versionId: 'v1',
  objectId: 'source-local-name',
  objectLabel: 'Original reach',
  kind: 'observation',
  regionIds: ['chaobai', 'beiyun'],
  needIds: ['K5-001'],
  time: {
    start: '2023-04',
    end: '2023-04',
    precision: 'month',
    role: 'publication',
  },
  metric: '现状水质类别',
  value: 'Ⅲ～Ⅳ',
  unit: null,
  positions: [],
  evidence: [{ locator: 'table:1/row:2', text: 'Ⅲ～Ⅳ', url: null }],
  processingVersion: 'rule1',
  reviewStatus: 'pending',
  missingReasons: ['exact-position-unknown'],
};
const pack = (sources = [source], records = [row]): WorkspacePack => ({
  schemaVersion: 1,
  generatedAt: '2026-10-04',
  processingVersion: 'rule1',
  sources,
  records,
  regions: [],
  topicPackages: [],
  rasterReports: [],
});

describe('six-range demand matrix', () => {
  it('keeps explicitly unknown time precision out of a positive monthly window', () => {
    const record = {
      ...row,
      time: { ...row.time, precision: 'unknown' as const },
    };
    const input = parseWorkspacePack(pack([source], [record]));
    const before = JSON.stringify(input);
    const matrix = buildReadinessMatrix(input, [], null, {
      window: { start: '2023-04', end: '2023-04' },
      dateRole: 'PUBLICATION',
    });
    const cell = matrix.cells.find(
      (value) => value.regionId === 'chaobai' && value.needId === 'K5-001',
    );
    expect(cell?.windowRecordIds).toEqual([]);
    expect(cell?.unknownTimeRecordIds).toEqual([record.id]);
    expect(cell?.recordIds).toEqual([record.id]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([
    { precision: 'day', value: '2023-02-29' },
    { precision: 'day', value: '2023-04' },
    { precision: 'month', value: '2023-04-01' },
  ] as const)(
    'does not infer a valid window date from an invalid or incomplete %j native value',
    ({ precision, value }) => {
      const input = pack(
        [source],
        [
          {
            ...row,
            time: { ...row.time, precision, start: value, end: value },
          },
        ],
      );
      const matrix = buildReadinessMatrix(input, [], null, {
        window: { start: '2023-02', end: '2023-04' },
        dateRole: 'PUBLICATION',
      });
      const cell = matrix.cells.find(
        (item) => item.regionId === 'chaobai' && item.needId === 'K5-001',
      );
      expect(cell?.windowRecordIds).toEqual([]);
      expect(cell?.recordIds).toEqual([row.id]);
    },
  );
  it('admits valid declared day and month values only in their chosen date role', () => {
    const daily = {
      ...row,
      id: 'daily',
      time: {
        ...row.time,
        precision: 'day' as const,
        start: '2024-02-29',
        end: '2024-02-29',
      },
    };
    const monthly = {
      ...row,
      time: { ...row.time, start: '2024-02', end: '2024-02' },
    };
    const input = parseWorkspacePack(pack([source], [daily, monthly]));
    const matrix = buildReadinessMatrix(input, [], null, {
      window: { start: '2024-02', end: '2024-02' },
      dateRole: 'PUBLICATION',
    });
    expect(
      matrix.cells.find(
        (cell) => cell.regionId === 'chaobai' && cell.needId === 'K5-001',
      )?.windowRecordIds,
    ).toEqual(['daily', row.id]);
    const otherRole = buildReadinessMatrix(input, [], null, {
      window: { start: '2024-02', end: '2024-02' },
      dateRole: 'OBSERVATION',
    });
    expect(
      otherRole.cells.find(
        (cell) => cell.regionId === 'chaobai' && cell.needId === 'K5-001',
      )?.windowRecordIds,
    ).toEqual([]);
  });
  it('keeps a validated multilevel fixed-copy chain in one source and asset grain', () => {
    const original = { ...source, id: 'A' };
    const input = parseWorkspacePack(
      pack(
        [
          original,
          { ...original, id: 'B', duplicateOf: 'A' },
          { ...original, id: 'C', duplicateOf: 'B' },
        ],
        [{ ...row, sourceId: 'C' }],
      ),
    );
    const matrix = buildReadinessMatrix(input);
    const cell = matrix.cells.find(
      (value) => value.regionId === 'chaobai' && value.needId === 'K5-001',
    );
    expect(cell?.counts.sources).toBe(1);
    expect(cell?.counts.assets).toBe(1);
    expect(cell?.sourceIds).toEqual(['A']);
    expect(cell?.axes.obtained.count).toBe(1);
    expect(matrix.totals.sources).toBe(1);
    expect(matrix.totals.records).toBe(1);
  });
  it('keeps 114 scoped cells, overlap and exact row identity without summing regions', () => {
    const matrix = buildReadinessMatrix(pack());
    expect(matrix.cells).toHaveLength(114);
    expect(MATRIX_REGIONS).toHaveLength(6);
    for (const region of ['bth', 'chaobai', 'beiyun']) {
      const cell = matrix.cells.find(
        (value) => value.regionId === region && value.needId === 'K5-001',
      )!;
      expect(cell.recordIds).toEqual(['physical-row']);
      expect(cell.counts.records).toBe(1);
      expect(cell.axes.obtained.state).toBe('KNOWN');
      expect(cell.axes.parsed.state).toBe('PARTIAL');
      expect(cell.axes.professional.state).toBe('PENDING_REVIEW');
      expect(cell.axes.authorized.state).toBe('KNOWN');
      expect(cell.uses.find((use) => use.id === 'pollution-load')?.state).toBe(
        'UNKNOWN',
      );
    }
    expect(matrix.totals.records).toBe(1);
    expect(matrix.totals.sources).toBe(1);
  });
  it('keeps empty cells unknown and does not leak withdrawn names, IDs or counts', () => {
    const hidden = {
      ...source,
      id: 'hidden-source',
      title: 'Private source title',
      rights: { ...source.rights, displayAllowed: false },
    };
    const input = pack(
      [source, hidden],
      [
        row,
        { ...row, id: 'private-row', sourceId: hidden.id, needIds: ['K5-019'] },
      ],
    );
    const matrix = buildReadinessMatrix(input);
    const serialized = JSON.stringify(matrix);
    expect(serialized).not.toContain('Private source title');
    expect(serialized).not.toContain('hidden-source');
    expect(serialized).not.toContain('private-row');
    const empty = matrix.cells.find(
      (value) => value.regionId === 'bohai' && value.needId === 'K5-019',
    )!;
    expect(
      Object.values(empty.axes).every(
        (axis) => axis.state === 'UNKNOWN' && axis.count === null,
      ),
    ).toBe(true);
    expect(empty.counts.records).toBe(0);
    expect(empty.sourceIds).toEqual([]);
  });
  it('uses the selected date role and month window without altering raw categorical values', () => {
    const input = pack();
    const before = JSON.stringify(input);
    const april = buildReadinessMatrix(input, [], null, {
      window: { start: '2023-04', end: '2023-04' },
      dateRole: 'PUBLICATION',
    });
    const may = buildReadinessMatrix(input, [], null, {
      window: { start: '2023-05', end: '2023-05' },
      dateRole: 'PUBLICATION',
    });
    expect(
      april.cells.find(
        (value) => value.regionId === 'chaobai' && value.needId === 'K5-001',
      )?.windowRecordIds,
    ).toEqual(['physical-row']);
    expect(
      may.cells.find(
        (value) => value.regionId === 'chaobai' && value.needId === 'K5-001',
      )?.windowRecordIds,
    ).toEqual([]);
    expect(
      may.cells.find(
        (value) => value.regionId === 'chaobai' && value.needId === 'K5-001',
      )?.recordIds,
    ).toEqual(['physical-row']);
    expect(JSON.stringify(input)).toBe(before);
  });
});
