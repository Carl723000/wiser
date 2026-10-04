import { describe, expect, it } from 'vitest';
import type {
  WorkspacePack,
  WorkspaceRecord,
} from './spatial-workspace-contract';
import { parseWorkspacePack } from './spatial-workspace-pack';
import {
  createSpatialWorkspaceView,
  exportWorkspaceTopic,
  filterSpatialWorkspace,
  workspaceDisplayPositions,
  workspaceObjectDossier,
} from './spatial-workspace-view';
import type { WorkspaceReadingUrlState } from './spatial-workspace-url-state';
import {
  scopeWorkspaceReadingPack,
  workspaceReadingStateForView,
  workspaceViewForReadingState,
} from './spatial-workspace-reading-view';
function fixture(): WorkspacePack {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-04',
    processingVersion: 'fixture-only',
    sources: [
      {
        id: 's',
        versionId: 'v',
        title: 'Synthetic navigation fixture',
        provider: 'Fixture publisher',
        kind: 'report',
        originalSha256: 'a'.repeat(64),
        processingVersion: 'source-rule',
        regionIds: ['chaobai'],
        needIds: ['K5-001'],
        evidenceUrl: null,
        duplicateOf: null,
        rights: {
          public: false,
          displayAllowed: true,
          redistributionAllowed: false,
          note: 'Fixture only',
        },
        status: {
          original: 'saved',
          parsed: 'ready',
          checked: 'unknown',
          professionalReview: 'pending',
          space: 'reference',
          use: 'unknown',
        },
      },
    ],
    records: [],
    regions: [
      {
        id: 'bth',
        name: 'BTH',
        aliases: [],
        type: 'region',
        bounds: [113, 36, 120, 43],
      },
    ],
    topicPackages: [],
    rasterReports: [],
  };
}
const state: WorkspaceReadingUrlState = {
  regionId: null,
  needId: null,
  dateRole: null,
  monthWindow: null,
  tab: 'spatial',
  pane: 'map',
  source: null,
  selection: null,
};
it('does not serialize an implicit display default as an explicitly chosen regional scope', () => {
  const pack = fixture();
  const view = createSpatialWorkspaceView(pack);
  expect(
    workspaceReadingStateForView(pack, state, view, null, 'results')?.regionId,
  ).toBeNull();
});
it('retains a fixed source-only reading trail when switching panes without a record selection', () => {
  const pack = fixture();
  const input = {
    ...state,
    source: {
      sourceId: 's',
      versionId: 'v',
      sha256: 'a'.repeat(64),
      processingVersion: 'source-rule',
    },
  };
  const result = workspaceReadingStateForView(
    pack,
    input,
    workspaceViewForReadingState(pack, input),
    null,
    'evidence',
  );
  expect(result?.source).toEqual(input.source);
});
it('preserves a full leap month as a month scope while supplying legal date-control boundaries', () => {
  const pack = fixture();
  const input = {
    ...state,
    dateRole: 'PUBLICATION' as const,
    monthWindow: { start: '2024-02', end: '2024-02' },
  };
  const view = workspaceViewForReadingState(pack, input);
  expect([view.start, view.end]).toEqual(['2024-02-01', '2024-02-29']);
  const next = workspaceReadingStateForView(pack, input, view, null, 'map');
  expect(next?.monthWindow).toEqual(input.monthWindow);
  expect(next).not.toHaveProperty('dayWindow');
});
it('retains exact edited day boundaries instead of retaining a wider earlier month', () => {
  const pack = fixture();
  const input = {
    ...state,
    dateRole: 'PUBLICATION' as const,
    monthWindow: { start: '2024-02', end: '2024-02' },
  };
  const view = {
    ...workspaceViewForReadingState(pack, input),
    end: '2024-02-17',
  };
  const next = workspaceReadingStateForView(pack, input, view, null, 'map');
  expect(next?.dayWindow).toEqual({ start: '2024-02-01', end: '2024-02-17' });
  expect(next?.monthWindow).toBeNull();
});
it('excludes revoked and opposite-track raster reports without hiding permitted reference sources', () => {
  const pack = fixture();
  pack.rasterReports = [
    {
      sourceId: 's',
      versionId: 'v',
      rights: { displayAllowed: true },
      regionIds: ['chaobai'],
    } as WorkspacePack['rasterReports'][number],
  ];
  expect(
    scopeWorkspaceReadingPack(pack, { ...state, track: 'SYNTHETIC' })
      .rasterReports,
  ).toEqual([]);
  pack.sources[0].rights.displayAllowed = false;
  expect(
    scopeWorkspaceReadingPack(pack, { ...state, track: 'REAL' }).rasterReports,
  ).toEqual([]);
  expect(
    scopeWorkspaceReadingPack(pack, { ...state, track: 'REAL' }).sources,
  ).toBe(pack.sources);
});

/** Parser-valid public test data: one scene/report with four distinct products. */
function publicRasterFixture(): WorkspacePack {
  const pack = fixture();
  const source: WorkspacePack['sources'][number] = {
    ...pack.sources[0],
    kind: 'raster',
    track: 'REAL',
    regionIds: ['bth', 'yongding'],
    needIds: ['K5-005'],
    rights: {
      ...pack.sources[0].rights,
      public: true,
      note: 'Public test fixture only',
    },
  };
  const report: WorkspacePack['rasterReports'][number] = {
    id: 'one-scene-four-products',
    sourceId: source.id,
    versionId: source.versionId,
    sceneId: 'fixture-scene',
    acquiredAt: null,
    regionIds: ['bth', 'yongding'],
    title: 'One-scene raster fixture',
    products: (['B03', 'B8A', 'SCL', 'TCI'] as const).map((band) => ({
      band,
      width: 1,
      height: 1,
      channels: band === 'TCI' ? 3 : 1,
      dtype: 'uint8',
      sha256: 'b'.repeat(64),
      hashMatches: true,
      readable: true,
      nativeCrs: null,
      resolution: null,
      noData: [null],
      scales: [1],
      offsets: [0],
      stats: { min: 0, max: 1, validPixels: 1, noDataPixels: 0 },
      classFrequency: null,
      thumbnailUrl: `/spatial-workspace-media/${band.toLowerCase()}.png`,
    })),
    wgs84Bounds: null,
    footprint: null,
    qualityLayerPresent: true,
    oneSceneOnly: true,
    controlPointVerified: false,
    rights: {
      displayAllowed: true,
      redistributionAllowed: false,
      note: 'Public test fixture only',
    },
    limitations: [],
  };
  return parseWorkspacePack({
    ...pack,
    sources: [source],
    rasterReports: [report],
  });
}

describe('one public raster scene in the current reading scope', () => {
  it('keeps four products in one report only for its declared region and need, then restores it', () => {
    const pack = publicRasterFixture();
    const original = JSON.stringify(pack);
    expect(pack.rasterReports).toHaveLength(1);
    const inspect = (
      regionId: WorkspaceReadingUrlState['regionId'],
      needId: string | null,
    ) =>
      scopeWorkspaceReadingPack(pack, {
        ...state,
        track: 'REAL',
        regionId,
        needId,
      }).rasterReports;

    expect(inspect('bth', null)).toHaveLength(1);
    expect(inspect('yongding', 'K5-005')).toHaveLength(1);
    expect(inspect('chaobai', 'K5-005')).toEqual([]);
    expect(inspect('yongding', 'K5-001')).toEqual([]);
    const restored = inspect('yongding', 'K5-005');
    expect(restored).toHaveLength(1);
    expect(restored[0].oneSceneOnly).toBe(true);
    expect(restored[0].products.map((product) => product.band)).toEqual([
      'B03',
      'B8A',
      'SCL',
      'TCI',
    ]);
    expect(JSON.stringify(pack)).toBe(original);
  });

  it('rejects the opposite track and either revoked display grant, then restores only when both grants return', () => {
    const pack = publicRasterFixture();
    const inspect = (track: 'REAL' | 'SYNTHETIC') =>
      scopeWorkspaceReadingPack(pack, {
        ...state,
        track,
        regionId: 'yongding',
        needId: 'K5-005',
      }).rasterReports;

    expect(inspect('REAL')).toHaveLength(1);
    expect(inspect('SYNTHETIC')).toEqual([]);
    pack.rasterReports[0].rights.displayAllowed = false;
    expect(inspect('REAL')).toEqual([]);
    pack.sources[0].rights.displayAllowed = false;
    pack.rasterReports[0].rights.displayAllowed = true;
    expect(inspect('REAL')).toEqual([]);
    pack.sources[0].rights.displayAllowed = true;
    expect(inspect('REAL')).toHaveLength(1);
  });
});

/** All content is synthetic test data; REAL tests the declared business track only. */
function trackFixture(): WorkspacePack {
  const pack = fixture();
  const material = {
    ...pack.sources[0],
    title: 'Declared REAL fixture material',
    track: 'REAL' as const,
    workId: 'shared-work',
    rights: {
      public: true,
      displayAllowed: true,
      redistributionAllowed: true,
      note: 'Synthetic test content with explicit track declarations',
    },
  };
  const record: WorkspaceRecord = {
    id: 'real-row',
    sourceId: material.id,
    versionId: material.versionId,
    objectId: 'real-source-local-object',
    objectLabel: 'Declared REAL fixture object',
    kind: 'observation',
    regionIds: ['chaobai'],
    needIds: ['K5-001'],
    time: {
      start: '2023-04',
      end: '2023-04',
      precision: 'month',
      role: 'publication',
    },
    metric: 'grade',
    value: 'Ⅲ',
    unit: null,
    track: 'REAL',
    positions: [],
    evidence: [{ locator: 'fixture-table:1/row:1', text: 'Ⅲ', url: null }],
    processingVersion: 'fixture-record-rule',
    reviewStatus: 'pending',
    missingReasons: [],
  };
  const syntheticSource = {
    ...material,
    id: 'synthetic-source',
    versionId: 'synthetic-version',
    originalSha256: 'b'.repeat(64),
    title: 'SYNTHETIC-only fixture material',
    track: 'SYNTHETIC' as const,
  };
  const topic = {
    id: 'real-topic',
    title: 'Declared REAL fixture topic',
    regionIds: [
      'chaobai',
    ] as WorkspacePack['topicPackages'][number]['regionIds'],
    sourceIds: [material.id],
    recordIds: [record.id],
    question: 'Read the original fixture value',
    gaps: ['No independent observations established'],
  };
  return parseWorkspacePack({
    ...pack,
    sources: [
      material,
      // Absent track remains the existing REAL compatibility declaration.
      {
        ...material,
        id: 'real-copy',
        track: undefined,
        duplicateOf: material.id,
      },
      syntheticSource,
      {
        ...material,
        id: 'reference-geometry',
        versionId: 'reference-version',
        originalSha256: 'c'.repeat(64),
        title: 'Shared REAL reference background',
        workId: 'reference-work',
        kind: 'spatial',
      },
    ],
    records: [
      record,
      {
        ...record,
        id: 'synthetic-row',
        sourceId: syntheticSource.id,
        versionId: syntheticSource.versionId,
        objectId: 'synthetic-source-local-object',
        objectLabel: 'SYNTHETIC-only fixture object',
        track: 'SYNTHETIC',
        reviewStatus: 'synthetic-reviewed',
        positions: [
          {
            id: 'shared-reference',
            expression: 'Shared reference background',
            role: 'reference',
            match: 'bound',
            geometry: { type: 'Point', coordinates: [116, 40] },
            crs: 'EPSG:4326',
            geometrySourceId: 'reference-geometry',
            geometryVersionId: 'reference-version',
            locator: 'fixture-feature:1',
            scaleNote: 'Reference only; no sampling location is established',
            evidence: {
              locator: 'fixture-caption:1',
              text: 'Reference extent',
            },
          },
        ],
      },
    ],
    topicPackages: [
      topic,
      {
        ...topic,
        id: 'synthetic-topic',
        title: 'SYNTHETIC-only fixture topic',
        sourceIds: [syntheticSource.id],
        recordIds: ['synthetic-row'],
      },
      {
        ...topic,
        id: 'shared-topic',
        title: 'Shared fixture topic',
        sourceIds: [material.id, syntheticSource.id],
        recordIds: [record.id, 'synthetic-row'],
      },
      { ...topic, id: 'real-source-only-topic', recordIds: [] },
      {
        ...topic,
        id: 'synthetic-source-only-topic',
        title: 'SYNTHETIC-only source fixture topic',
        sourceIds: [syntheticSource.id],
        recordIds: [],
      },
    ],
  });
}

describe('current-track dossier and topic display', () => {
  it('does not present a SYNTHETIC source as a REAL business copy merely because workId matches', () => {
    const pack = trackFixture();
    const scoped = scopeWorkspaceReadingPack(pack, { ...state, track: 'REAL' });
    expect(scoped.records.map((record) => record.id)).toEqual(['real-row']);
    const dossier = workspaceObjectDossier(scoped, 'real-row');
    expect(dossier?.source.title).toBe('Declared REAL fixture material');
    expect(dossier?.copies.map((source) => source.id)).toEqual(['real-copy']);
    expect(dossier?.selected.value).toBe('Ⅲ');
  });

  it('removes purely SYNTHETIC topic metadata from REAL reading and topic export', () => {
    const scoped = scopeWorkspaceReadingPack(trackFixture(), {
      ...state,
      track: 'REAL',
    });
    expect(scoped.topicPackages.map((topic) => topic.id)).toEqual([
      'real-topic',
      'shared-topic',
      'real-source-only-topic',
    ]);
    expect(exportWorkspaceTopic(scoped, 'synthetic-topic')).toBeNull();
    expect(
      exportWorkspaceTopic(scoped, 'synthetic-source-only-topic'),
    ).toBeNull();
  });

  it('refuses export of a solely opposite-track topic even when source redistribution is permitted', () => {
    const pack = trackFixture();
    expect(
      pack.sources.find((source) => source.id === 'synthetic-source')?.rights,
    ).toMatchObject({ displayAllowed: true, redistributionAllowed: true });
    const scoped = scopeWorkspaceReadingPack(pack, { ...state, track: 'REAL' });
    expect(exportWorkspaceTopic(scoped, 'synthetic-topic')).toBeNull();
  });

  it('retains a legitimately shared topic with only current-track members and unchanged common metadata', () => {
    const pack = trackFixture();
    const snapshot = JSON.stringify(pack);
    const scoped = scopeWorkspaceReadingPack(pack, { ...state, track: 'REAL' });
    const original = pack.topicPackages.find(
      (topic) => topic.id === 'shared-topic',
    );
    const shared = scoped.topicPackages.find(
      (topic) => topic.id === 'shared-topic',
    );
    expect(shared).toEqual({
      ...original,
      sourceIds: ['s'],
      recordIds: ['real-row'],
    });
    const exported = exportWorkspaceTopic(scoped, 'shared-topic');
    expect(exported?.topic).toEqual(shared);
    expect(exported?.records.map((record) => record.id)).toEqual(['real-row']);
    expect(exported?.sources.map((source) => source.id)).toEqual(['s']);
    expect(JSON.stringify(exported)).not.toContain('SYNTHETIC-only');
    expect(JSON.stringify(pack)).toBe(snapshot);
  });

  it('keeps explicit SYNTHETIC reading separate while retaining its permitted REAL reference geometry', () => {
    const pack = trackFixture();
    const scoped = scopeWorkspaceReadingPack(pack, {
      ...state,
      track: 'SYNTHETIC',
    });
    expect(scoped.records.map((record) => record.id)).toEqual([
      'synthetic-row',
    ]);
    expect(scoped.topicPackages.map((topic) => topic.id)).toEqual([
      'synthetic-topic',
      'shared-topic',
      'synthetic-source-only-topic',
    ]);
    expect(
      scoped.topicPackages.find((topic) => topic.id === 'shared-topic'),
    ).toMatchObject({
      sourceIds: ['synthetic-source'],
      recordIds: ['synthetic-row'],
    });
    const dossier = workspaceObjectDossier(scoped, 'synthetic-row');
    expect(dossier?.copies).toEqual([]);
    const positions = workspaceDisplayPositions(scoped, scoped.records[0]);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual(pack.records[1].positions[0]);
    expect(
      filterSpatialWorkspace(scoped, createSpatialWorkspaceView(scoped))
        .geometryCount,
    ).toBe(1);
  });
});
