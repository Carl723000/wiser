import { describe, expect, it } from 'vitest';
import type {
  Material,
  WorkspacePack,
  WorkspaceRecord,
} from './spatial-workspace-contract';
import { buildReadiness, NEED_IDS } from './spatial-readiness';

const material: Material = {
  id: 'report',
  versionId: 'v1',
  title: 'Monthly categories',
  provider: 'Public provider',
  kind: 'report',
  originalSha256: 'a'.repeat(64),
  evidenceUrl: null,
  rights: {
    public: true,
    displayAllowed: true,
    redistributionAllowed: false,
    note: 'Local inspection',
  },
  regionIds: ['bth', 'chaobai', 'beiyun'],
  needIds: ['K5-001'],
  processingVersion: 'p1',
  status: {
    original: 'obtained',
    parsed: 'partial',
    checked: 'cells-verified',
    professionalReview: 'pending',
    space: 'reference',
    use: 'inspect',
  },
  duplicateOf: null,
};
const record: WorkspaceRecord = {
  id: 'r1',
  sourceId: 'report',
  versionId: 'v1',
  objectId: 'source-object-1',
  objectLabel: 'Reported reach',
  kind: 'observation',
  regionIds: ['bth', 'chaobai'],
  needIds: ['K5-001'],
  time: {
    start: '2023-04',
    end: '2023-04',
    precision: 'month',
    role: 'observation',
  },
  metric: '现状水质类别',
  value: 'Ⅲ',
  unit: null,
  positions: [],
  evidence: [{ locator: 'table:1/row:2', text: 'Ⅲ', url: null }],
  processingVersion: 'p1',
  reviewStatus: 'pending',
  missingReasons: ['exact-position-unknown'],
};
const pack = (sources = [material], records = [record]): WorkspacePack => ({
  schemaVersion: 1,
  generatedAt: '2026-10-02',
  processingVersion: 'p1',
  sources,
  records,
  regions: [],
  topicPackages: [],
  rasterReports: [],
});

describe('multi-region readiness', () => {
  it('has 19 demand slots for each of six regions without treating slots as datasets', () => {
    expect(NEED_IDS).toHaveLength(19);
    const result = buildReadiness(pack(), 'chaobai');
    expect(result.needs).toHaveLength(19);
    expect(result.questions).toHaveLength(9);
    expect(result.counts.sources).toBe(1);
    expect(result.needs[1].state).toBe('not-obtained');
  });
  it('does not invent cleaning or quality-control result sets when no task is recorded', () => {
    const result = buildReadiness(pack(), 'chaobai');
    for (const id of ['cleaning', 'quality-control'] as const) {
      expect(
        result.questions.find((question) => question.id === id)?.recordIds,
      ).toEqual([]);
    }
  });
  it('resolves readability by the exact source version rather than the last matching source ID', () => {
    const restrictedRevision = {
      ...material,
      versionId: 'v2',
      rights: { ...material.rights, displayAllowed: false },
    };
    const result = buildReadiness(
      pack([material, restrictedRevision]),
      'chaobai',
    );
    expect(result.uses.find((use) => use.id === 'archive')?.eligible).toBe(
      true,
    );
  });
  it('does not include record contents with no matching readable fixed source', () => {
    const orphan = { ...record, id: 'orphan', versionId: 'not-present' };
    const result = buildReadiness(
      pack([material], [record, orphan]),
      'chaobai',
    );
    expect(result.counts.records).toBe(1);
    expect(
      result.questions.flatMap((question) => question.recordIds),
    ).not.toContain('orphan');
  });
  it('global union deduplicates a source used by several regions and a format copy', () => {
    const duplicate = { ...material, id: 'copy', duplicateOf: 'report' };
    const result = buildReadiness(
      pack(
        [material, duplicate],
        [
          record,
          {
            ...record,
            id: 'r2',
            regionIds: ['beiyun'],
            objectId: 'source-object-2',
          },
        ],
      ),
      'bth',
    );
    expect(result.counts.sources).toBe(1);
    expect(result.counts.versions).toBe(1);
    expect(result.counts.records).toBe(2);
    expect(result.counts.sourceObjects).toBe(2);
  });
  it('keeps unknown observation counts and density separate from record counts', () => {
    const result = buildReadiness(pack(), 'chaobai');
    expect(result.counts.validObservations).toBeNull();
    expect(result.density.spatial).toBeNull();
    expect(result.density.reportWindows).toEqual(['2023-04']);
    expect(
      result.uses.find((u) => u.id === 'concentration-trend')?.eligible,
    ).toBe(false);
    expect(result.uses.find((u) => u.id === 'monthly-category')?.eligible).toBe(
      true,
    );
  });
  it('counts separate queries of one work once without collapsing their versions or objects', () => {
    const first = { ...material, workId: 'openstreetmap' };
    const second = {
      ...material,
      id: 'query2',
      versionId: 'v2',
      workId: 'openstreetmap',
    };
    const result = buildReadiness(
      pack(
        [first, second],
        [
          record,
          {
            ...record,
            id: 'r2',
            sourceId: 'query2',
            versionId: 'v2',
            objectId: 'different-source-object',
          },
        ],
      ),
      'bth',
    );
    expect(result.counts.sources).toBe(1);
    expect(result.counts.versions).toBe(2);
    expect(result.counts.sourceObjects).toBe(2);
  });
  it('does not count synthetic decisions, missing geometry, or an institutional address as valid mapped sampling', () => {
    const synthetic = {
      ...record,
      id: 'synth',
      reviewStatus: 'synthetic-reviewed' as const,
    };
    const address = {
      id: 'address',
      expression: 'Author institution',
      role: 'institution-address' as const,
      match: 'bound' as const,
      geometry: { type: 'Point' as const, coordinates: [116, 40] },
      crs: 'EPSG:4326' as const,
      geometrySourceId: 'report',
      geometryVersionId: 'v1',
      locator: 'paragraph:1',
      scaleNote: null,
      evidence: { locator: 'paragraph:1', text: 'Author institution' },
    };
    const result = buildReadiness(
      pack([material], [{ ...record, positions: [address] }, synthetic]),
      'chaobai',
    );
    expect(result.counts.records).toBe(1);
    expect(result.counts.geometryRecords).toBe(0);
    expect(result.counts.samplingSites).toBeNull();
    expect(result.counts.professionallyReviewed).toBe(0);
  });
  it('stale records explain affected uses and preserve quantities', () => {
    const result = buildReadiness(pack(), 'chaobai', ['r1']);
    expect(result.staleRecordIds).toEqual(['r1']);
    expect(result.counts.records).toBe(1);
    expect(result.uses.every((u) => !u.eligible)).toBe(true);
  });
  it('time windows expose missing months and distinguish publication from observations', () => {
    const result = buildReadiness(
      pack(
        [material],
        [
          record,
          {
            ...record,
            id: 'june',
            time: { ...record.time, start: '2023-06', end: '2023-06' },
          },
          {
            ...record,
            id: 'press',
            time: {
              start: '2026-06-04',
              end: '2026-06-04',
              precision: 'day',
              role: 'publication',
            },
          },
        ],
      ),
      'chaobai',
    );
    expect(result.density.missingReportWindows).toEqual(['2023-05']);
    expect(result.density.reportWindows).not.toContain('2026-06-04');
  });
});
