import { describe, expect, it } from 'vitest';
import type { WorkspacePack } from './spatial-workspace-contract';
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

function fixture(version = 1): WorkspacePack {
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
  } as unknown as WorkspacePack;
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
      'spatial',
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
});
