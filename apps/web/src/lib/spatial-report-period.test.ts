import { describe, expect, it } from 'vitest';
import type { WorkspacePack } from './spatial-workspace-contract';
import type { ProjectReadinessInput } from '@wiser/data-core';
import { buildReadiness } from './spatial-readiness';
import { buildReadinessMatrix } from './spatial-readiness-matrix';
import { materialReference } from './spatial-readiness-facts';
import { buildMonthlyReadout } from './spatial-monthly-readout';
import { parseLocalReadinessFacts } from './spatial-readiness-input';
import { calculateProjectReadiness } from '@wiser/data-core';
import { parseWorkspacePack } from './spatial-workspace-pack';
import {
  decodeWorkspaceReadingUrl,
  encodeWorkspaceReadingUrl,
} from './spatial-workspace-url-state';
import {
  defaultWorkspaceReadingState,
  workspaceReadingStateForView,
  workspaceViewForReadingState,
} from './spatial-workspace-reading-view';
import {
  captureSpatialWorkspaceView,
  createSpatialWorkspaceView,
  exportWorkspaceTopic,
  restoreSpatialWorkspaceView,
} from './spatial-workspace-view';

function fixture(version: 1 | 2 = 1): WorkspacePack {
  return {
    schemaVersion: version,
    generatedAt: '2026-10-06T00:00:00Z',
    processingVersion: 'fixture-only',
    sources: [
      {
        id: 's',
        versionId: 'v',
        title: 'Fixture report',
        provider: 'Fixture publisher',
        kind: 'report',
        originalSha256: 'a'.repeat(64),
        evidenceUrl: null,
        rights: {
          public: true,
          displayAllowed: true,
          redistributionAllowed: true,
          note: 'Fixture only',
        },
        regionIds: ['bth'],
        needIds: ['K5-001'],
        processingVersion: 'fixture-only',
        status: {
          original: 'saved',
          parsed: 'ready',
          checked: 'unknown',
          professionalReview: 'pending',
          space: 'unknown',
          use: 'unknown',
        },
        duplicateOf: null,
      },
    ],
    records: [
      {
        id: 'row',
        sourceId: 's',
        versionId: 'v',
        objectId: 'source-local-row',
        objectLabel: 'Fixture river',
        kind: 'observation',
        regionIds: ['bth'],
        needIds: ['K5-001'],
        time: {
          start: '2023-04',
          end: '2023-04',
          precision: 'month',
          role: version === 2 ? 'report-period' : 'publication',
        },
        metric: 'category',
        value: '无水',
        unit: null,
        positions: [],
        evidence: [
          { locator: 'table:1/row:2', text: 'Fixture river | 无水', url: null },
        ],
        processingVersion: 'fixture-only',
        reviewStatus: 'pending',
        missingReasons: [],
      },
    ],
    regions: [
      {
        id: 'bth',
        name: 'BTH',
        aliases: [],
        type: 'navigation',
        bounds: [113, 36, 120, 43],
      },
    ],
    topicPackages: [
      {
        id: 't',
        title: 'Fixture topic',
        regionIds: ['bth'],
        sourceIds: ['s'],
        recordIds: ['row'],
        question: 'What did the report cover?',
        gaps: [],
      },
    ],
    rasterReports: [],
  };
}

function declaredFacts(pack: WorkspacePack): ProjectReadinessInput {
  const source = materialReference(pack.sources[0]!);
  const role = pack.schemaVersion === 2 ? 'REPORT_PERIOD' : 'PUBLICATION';
  const evidence = [
    {
      source,
      locator: 'table:1/title',
      excerpt: 'Fixture report covers April 2023.',
    },
  ];
  return {
    track: 'REAL',
    requirement: {
      needId: 'K5-001',
      version: 'fixture-v1',
      regionId: 'bth',
      purpose: 'category-reading',
      dateRole: role,
      window: { start: '2023-04', end: '2023-05' },
    },
    sources: [
      {
        ...source,
        kind: 'MONTHLY_REPORT',
        track: 'REAL',
        needIds: ['K5-001'],
        regionIds: ['bth'],
      },
    ],
    records: [
      {
        id: 'row',
        source,
        needIds: ['K5-001'],
        regionIds: ['bth'],
        object: {
          key: 'source-local-row',
          originalName: 'Fixture river',
          markers: [],
          footnotes: [],
        },
        series: { id: 'series', version: 'fixture-v1' },
        time: { value: '2023-04', role, precision: 'MONTH' },
        rawValue: '无水',
        metric: {
          code: 'category',
          kind: 'CATEGORY',
          unit: null,
          method: null,
        },
        parsing: 'READY',
        professionalState: 'PENDING_REVIEW',
        evidence,
        spatial: null,
      },
    ],
    series: [
      { id: 'series', version: 'fixture-v1', sources: [source], evidence },
    ],
    correspondences: [],
  };
}

describe('report-period explicit format compatibility', () => {
  it('reads version 2 report periods while leaving version 1 publication records unchanged', () => {
    expect(parseWorkspacePack(fixture(2)).records[0]?.time.role).toBe(
      'report-period',
    );
    expect(parseWorkspacePack(fixture(1)).records[0]?.time.role).toBe(
      'publication',
    );
    expect(() =>
      parseWorkspacePack({ ...fixture(2), schemaVersion: 1 }),
    ).toThrow();
    expect(() =>
      parseWorkspacePack({ ...fixture(2), schemaVersion: 3 }),
    ).toThrow('schema-version');
  });

  it('roundtrips the explicit URL role without report_period coercion or day-precision invention', () => {
    const pack = fixture(2);
    const params = new URLSearchParams(
      'dateRole=REPORT_PERIOD&monthStart=2023-04&monthEnd=2023-04',
    );
    const decoded = decodeWorkspaceReadingUrl(params, { pack });
    expect(decoded.status).toBe('valid');
    if (decoded.status !== 'valid')
      throw new Error('The explicit report-period role must decode.');
    const view = workspaceViewForReadingState(pack, decoded.state);
    expect(view.timeRole).toBe('report-period');
    expect(view.start).toBe('2023-04-01');
    expect(pack.records[0]?.time.precision).toBe('month');
    const restored = workspaceReadingStateForView(
      pack,
      decoded.state,
      view,
      null,
      'map',
    );
    expect(restored?.dateRole).toBe('REPORT_PERIOD');
    const encoded = encodeWorkspaceReadingUrl('zh-CN', restored!, { pack });
    expect(encoded.status).toBe('valid');
    if (encoded.status !== 'valid')
      throw new Error('Expected an explicit report-period reading URL.');
    expect(
      new URL(encoded.href, 'http://localhost').searchParams.get('dateRole'),
    ).toBe('REPORT_PERIOD');
  });

  it('uses a new local view version for the new role and rejects a forged legacy view', () => {
    const pack = fixture(2);
    const state = {
      ...defaultWorkspaceReadingState(),
      dateRole: 'REPORT_PERIOD',
    };
    const view = workspaceViewForReadingState(
      pack,
      state as Parameters<typeof workspaceViewForReadingState>[1],
    );
    const saved = captureSpatialWorkspaceView(pack, view);
    expect(saved.schemaVersion).toBe(2);
    expect(restoreSpatialWorkspaceView(pack, saved)).not.toBeNull();
    expect(
      restoreSpatialWorkspaceView(pack, { ...saved, schemaVersion: 1 }),
    ).toBeNull();
    const old = fixture(1);
    expect(createSpatialWorkspaceView(old).schemaVersion).toBe(1);
    expect(
      restoreSpatialWorkspaceView(
        old,
        captureSpatialWorkspaceView(old, createSpatialWorkspaceView(old)),
      ),
    ).not.toBeNull();
  });

  it('exports the new time semantics with a distinct format and unchanged original value', () => {
    const exported = exportWorkspaceTopic(fixture(2), 't');
    expect(exported?.schemaVersion).toBe(2);
    expect(exported?.records[0]).toMatchObject({
      value: '无水',
      time: { start: '2023-04', precision: 'month', role: 'report-period' },
    });
    expect(exportWorkspaceTopic(fixture(1), 't')?.schemaVersion).toBe(1);
  });
  it('uses explicit report months for category inspection without replacing legacy publication frequency', () => {
    const pack = fixture(2);
    const facts = declaredFacts(pack);
    const result = buildReadiness(pack, 'bth', [], facts);
    expect(
      result.uses.find((use) => use.id === 'monthly-category'),
    ).toMatchObject({
      eligible: true,
      reasons: ['reported-category-only', 'sampling-frequency-unknown'],
    });
    expect(result.density.frequency).toBe('monthly-report-period');
    const old = buildReadiness(fixture(), 'bth', [], declaredFacts(fixture()));
    expect(old.density.frequency).toBe('monthly-publication');
    expect(
      old.uses.find((use) => use.id === 'monthly-category')?.reasons,
    ).toContain('published-category-only');
  });

  it('keeps report-period matrix and month-strip scope distinct from publication and observation', () => {
    const pack = fixture(2);
    const facts = declaredFacts(pack);
    const result = buildReadiness(pack, 'bth', [], facts);
    expect(result.project.requirement.dateRole).toBe('REPORT_PERIOD');
    expect(result.project.records[0]?.time).toEqual({
      value: '2023-04',
      role: 'REPORT_PERIOD',
      precision: 'MONTH',
    });
    const cells = buildMonthlyReadout(result.project)[0]!.cells;
    expect(cells.map((cell) => [cell.month, cell.state])).toEqual([
      ['2023-04', 'PRESENT'],
      ['2023-05', 'MISSING'],
    ]);
    expect(cells[0]?.entries[0]?.value.raw).toBe('无水');
    const selection = {
      needId: 'K5-001',
      window: facts.requirement.window,
      dateRole: 'REPORT_PERIOD' as const,
    };
    const matrix = buildReadinessMatrix(pack, [], facts, selection);
    expect(
      matrix.cells.find(
        (cell) => cell.regionId === 'bth' && cell.needId === 'K5-001',
      )?.windowRecordIds,
    ).toEqual(['row']);
    for (const dateRole of ['PUBLICATION', 'OBSERVATION'] as const) {
      const other = buildReadinessMatrix(pack, [], facts, {
        ...selection,
        dateRole,
      });
      expect(
        other.cells.find(
          (cell) => cell.regionId === 'bth' && cell.needId === 'K5-001',
        )?.windowRecordIds,
      ).toEqual([]);
    }
  });
  it('parses explicit report roles and candidate identity without rewriting either into a catalog source', () => {
    const facts = declaredFacts(fixture(2));
    expect(parseLocalReadinessFacts(facts)).toEqual(facts);
    const source = {
      candidateReference: {
        kind: 'ingestion-candidate' as const,
        ingestionId: '10000000-0000-4000-8000-000000000001',
        processingBatchId: '10000000-0000-4000-8000-000000000002',
        reviewHash: 'a'.repeat(64),
      },
      assetId: '10000000-0000-4000-8000-000000000003',
      sourceLocalWorkId: null,
    };
    const candidate = {
      ...facts,
      sources: [
        {
          ...source,
          track: 'REAL',
          kind: 'MONTHLY_REPORT',
          needIds: ['K5-001'],
          regionIds: ['bth'],
        },
      ],
      records: facts.records.map((record) => ({
        ...record,
        source,
        evidence: record.evidence.map((entry) => ({ ...entry, source })),
      })),
      series: facts.series.map((series) => ({
        ...series,
        sources: [source],
        evidence: series.evidence.map((entry) => ({ ...entry, source })),
      })),
    };
    const read = parseLocalReadinessFacts(candidate);
    expect(read.sources[0]).toEqual(candidate.sources[0]);
    expect(read.sources[0]).not.toHaveProperty('workId');
    expect(calculateProjectReadiness(read).candidateCounts?.records).toBe(1);
  });

  it('rejects mixed local candidate references rather than silently stripping the candidate identity', () => {
    const facts = declaredFacts(fixture());
    const mixed = {
      ...facts.sources[0],
      candidateReference: {
        kind: 'ingestion-candidate',
        ingestionId: '10000000-0000-4000-8000-000000000001',
        processingBatchId: '10000000-0000-4000-8000-000000000002',
        reviewHash: 'a'.repeat(64),
      },
      sourceLocalWorkId: null,
    };
    expect(() =>
      parseLocalReadinessFacts({ ...facts, sources: [mixed] }),
    ).toThrow();
  });
});
