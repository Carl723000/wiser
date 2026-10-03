import { describe, expect, it } from 'vitest';
import type { Geometry } from 'geojson';
import type {
  Material,
  WorkspacePack,
  WorkspacePosition,
  WorkspaceRecord,
} from './spatial-workspace-contract';
import {
  geometryIntersectsWorkspaceBounds,
  isWorkspaceGeometry,
  parseWorkspaceBounds,
  projectWorkspaceCoordinate,
  workspaceGeometryAnchor,
  createSpatialWorkspaceView,
  switchSpatialWorkspaceRegion,
  filterSpatialWorkspace,
  captureSpatialWorkspaceView,
  restoreSpatialWorkspaceView,
  compareWorkspaceRecords,
  workspaceObjectDossier,
  exportWorkspaceTopic,
  workspaceEvidenceUrl,
  workspaceRasterOverlays,
  workspaceNativeTime,
} from './spatial-workspace-view';
import { parseWorkspacePack } from './spatial-workspace-pack';

const rectangle: Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [114, 38],
      [118, 38],
      [118, 42],
      [114, 42],
      [114, 38],
    ],
    [
      [115, 39],
      [117, 39],
      [117, 41],
      [115, 41],
      [115, 39],
    ],
  ],
};

describe('actual geometry intersection for spatial selection', () => {
  it('does not select the bounding box of a bent line as its geometry', () => {
    const line: Geometry = {
      type: 'LineString',
      coordinates: [
        [114, 38],
        [114, 42],
        [118, 42],
      ],
    };
    expect(geometryIntersectsWorkspaceBounds(line, [115, 39, 116, 40])).toBe(
      false,
    );
    expect(geometryIntersectsWorkspaceBounds(line, [113, 39, 115, 40])).toBe(
      true,
    );
  });

  it('selects a segment crossing a rectangle even when neither vertex is inside', () => {
    expect(
      geometryIntersectsWorkspaceBounds(
        {
          type: 'LineString',
          coordinates: [
            [114, 40],
            [118, 40],
          ],
        },
        [115, 39.5, 117, 40.5],
      ),
    ).toBe(true);
  });

  it('keeps a rectangle wholly inside a polygon hole unselected', () => {
    expect(
      geometryIntersectsWorkspaceBounds(rectangle, [115.2, 39.2, 116.8, 40.8]),
    ).toBe(false);
    expect(
      geometryIntersectsWorkspaceBounds(rectangle, [114.2, 38.2, 114.8, 38.8]),
    ).toBe(true);
    expect(
      geometryIntersectsWorkspaceBounds(rectangle, [113, 37, 119, 43]),
    ).toBe(true);
  });

  it('includes boundary contact without buffering or repairing the source', () => {
    expect(
      geometryIntersectsWorkspaceBounds(rectangle, [117, 39, 117.2, 40]),
    ).toBe(true);
  });

  it.each<Geometry>([
    {
      type: 'MultiPoint',
      coordinates: [
        [110, 30],
        [116, 40],
      ],
    },
    {
      type: 'MultiLineString',
      coordinates: [
        [
          [110, 30],
          [111, 31],
        ],
        [
          [114, 40],
          [118, 40],
        ],
      ],
    },
    { type: 'MultiPolygon', coordinates: [rectangle.coordinates] },
    {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [110, 30] },
        {
          type: 'LineString',
          coordinates: [
            [114, 40],
            [118, 40],
          ],
        },
      ],
    },
  ])('handles every part of %s without flattening its meaning', (geometry) => {
    expect(
      geometryIntersectsWorkspaceBounds(geometry, [114, 38, 114.5, 40.5]),
    ).toBe(geometry.type !== 'MultiPoint');
  });

  it('rejects invalid bounds instead of broadening the requested area', () => {
    expect(parseWorkspaceBounds('116,39,115,40')).toBeNull();
    expect(parseWorkspaceBounds('116,91,117,92')).toBeNull();
    expect(parseWorkspaceBounds('116,39,117,40,42')).toBeNull();
    expect(parseWorkspaceBounds('116,39,117,40')).toEqual([116, 39, 117, 40]);
  });
});

const source: Material = {
  id: 'report',
  versionId: 'report-v1',
  title: '公开月报',
  provider: '发布机构',
  kind: 'report',
  originalSha256: 'a'.repeat(64),
  originalPath: '/private/original.pdf',
  evidenceUrl: 'https://example.gov.cn/report.pdf',
  rights: {
    public: true,
    displayAllowed: true,
    redistributionAllowed: true,
    note: '公开资料',
  },
  regionIds: ['chaobai', 'beiyun'],
  needIds: ['K5-001'],
  processingVersion: 'parse-v1',
  status: {
    original: 'obtained',
    parsed: 'partial',
    checked: 'pending',
    professionalReview: 'pending',
    space: 'reference',
    use: 'reading',
  },
  duplicateOf: null,
};
const geometrySource: Material = {
  ...source,
  id: 'geometry',
  versionId: 'geometry-v1',
  kind: 'spatial',
  title: '许可参考河线',
};
const position: WorkspacePosition = {
  id: 'river',
  expression: '潮白河区域参考河线',
  role: 'reference',
  match: 'bound',
  geometry: {
    type: 'LineString',
    coordinates: [
      [116, 39],
      [118, 41],
    ],
  },
  crs: 'EPSG:4326',
  geometrySourceId: 'geometry',
  geometryVersionId: 'geometry-v1',
  locator: 'feature 8',
  scaleNote: '参考河网，不表示监测河段精确位置',
  evidence: { locator: 'table 1 row 2', text: '潮白河' },
};
const record: WorkspaceRecord = {
  id: 'row-1',
  sourceId: 'report',
  versionId: 'report-v1',
  objectId: 'report-local-river-1',
  objectLabel: '潮白河',
  kind: 'observation',
  regionIds: ['chaobai'],
  needIds: ['K5-001'],
  time: {
    start: '2023-12',
    end: '2023-12',
    precision: 'month',
    role: 'observation',
  },
  metric: 'water-quality-category',
  value: 'Ⅲ',
  unit: null,
  positions: [position],
  evidence: [
    { locator: 'table 1 row 2', text: '潮白河 Ⅲ', url: source.evidenceUrl },
  ],
  processingVersion: 'parse-v1',
  reviewStatus: 'pending',
  missingReasons: ['未取得浓度明细'],
};
const unknownRecord: WorkspaceRecord = {
  ...record,
  id: 'row-unknown',
  objectId: 'unknown-1',
  objectLabel: '待定位河段',
  positions: [
    {
      ...position,
      id: 'unknown',
      match: 'text-only',
      geometry: null,
      geometrySourceId: null,
      geometryVersionId: null,
      locator: null,
    },
  ],
  time: { start: null, end: null, precision: 'unknown', role: 'unknown' },
};
const pack: WorkspacePack = {
  schemaVersion: 1,
  generatedAt: '2026-10-02T00:00:00Z',
  processingVersion: 'pack-v1',
  sources: [source, geometrySource],
  records: [record, unknownRecord],
  regions: [
    {
      id: 'bth',
      name: '京津冀',
      aliases: [],
      type: 'administrative',
      bounds: [113, 36, 120, 43],
    },
    {
      id: 'chaobai',
      name: '潮白河',
      aliases: [],
      type: 'basin',
      bounds: [116, 39, 118, 42],
    },
    {
      id: 'beiyun',
      name: '北运河',
      aliases: [],
      type: 'basin',
      bounds: [116, 38, 118, 41],
    },
    {
      id: 'yongding',
      name: '永定河',
      aliases: [],
      type: 'basin',
      bounds: [114, 38, 117, 42],
    },
    {
      id: 'daqing-baiyangdian',
      name: '大清河—白洋淀',
      aliases: [],
      type: 'basin',
      bounds: [114, 37, 118, 40],
    },
    {
      id: 'bohai',
      name: '渤海湾',
      aliases: [],
      type: 'composite',
      bounds: [117, 37, 120, 40],
    },
  ],
  topicPackages: [
    {
      id: 'chaobai-topic',
      title: '潮白河资料',
      regionIds: ['chaobai'],
      sourceIds: ['report'],
      recordIds: ['row-1'],
      question: '月报能否支持浓度趋势？',
      gaps: ['缺少浓度明细'],
    },
  ],
  rasterReports: [],
};

describe('shared pack filtering and evidence identity', () => {
  it('keeps unresolved locations during a real geometry rectangle filter', () => {
    const view = {
      ...createSpatialWorkspaceView(pack, 'chaobai'),
      bounds: [116.5, 39.5, 117.5, 40.5] as const,
    };
    const filtered = filterSpatialWorkspace(pack, view);
    expect(filtered.locatedRecords.map((r) => r.id)).toEqual(['row-1']);
    expect(filtered.unlocatedRecords.map((r) => r.id)).toEqual(['row-unknown']);
    expect(filtered.features.features[0].geometry).toEqual(position.geometry);
    expect(filtered.sourceCount).toBe(1);
    expect(filtered.geometryCount).toBe(1);
    expect(record.positions[0].role).toBe('reference');
  });

  it('shows positioned records outside the rectangle separately from unknown positions', () => {
    const view = {
      ...createSpatialWorkspaceView(pack, 'chaobai'),
      bounds: [113, 36, 114, 37] as const,
    };
    const result = filterSpatialWorkspace(pack, view);
    expect(result.records.map((r) => r.id)).toEqual(['row-unknown']);
    expect(result.outsideRecords.map((r) => r.id)).toEqual(['row-1']);
    expect(result.unlocatedRecords.map((r) => r.id)).toEqual(['row-unknown']);
  });

  it.each([
    { role: 'institution-address' as const },
    { role: 'mention' as const },
    { match: 'candidate' as const },
    { match: 'ambiguous' as const },
    { crs: null },
    { locator: null },
  ])(
    'does not turn an unsupported location into a map object: %s',
    (change) => {
      const data = {
        ...pack,
        records: [{ ...record, positions: [{ ...position, ...change }] }],
      };
      const result = filterSpatialWorkspace(
        data,
        createSpatialWorkspaceView(data),
      );
      expect(result.geometryCount).toBe(0);
      expect(result.unlocatedRecords).toHaveLength(1);
    },
  );

  it('preserves multiple locations but counts a source once', () => {
    const data = {
      ...pack,
      records: [
        {
          ...record,
          positions: [
            position,
            {
              ...position,
              id: 'second',
              geometry: { type: 'Point' as const, coordinates: [117, 40] },
            },
          ],
        },
      ],
    };
    const result = filterSpatialWorkspace(
      data,
      createSpatialWorkspaceView(data),
    );
    expect(result.geometryCount).toBe(2);
    expect(result.sourceCount).toBe(1);
    expect(
      result.features.features.map((f) => f.properties?.['positionId']),
    ).toEqual(['river', 'second']);
  });

  it('uses original day/month/year periods and explicit time roles across a year boundary', () => {
    const yearly = {
      ...record,
      id: 'annual',
      time: {
        start: '2024',
        end: '2024',
        precision: 'year' as const,
        role: 'observation' as const,
      },
    };
    const publication = {
      ...record,
      id: 'publication',
      time: {
        start: '2024-01-02',
        end: '2024-01-02',
        precision: 'day' as const,
        role: 'publication' as const,
      },
    };
    const data = {
      ...pack,
      records: [record, unknownRecord, yearly, publication],
    };
    const view = {
      ...createSpatialWorkspaceView(data),
      start: '2023-12-20',
      end: '2024-01-03',
      timeRole: 'observation' as const,
      includeUndated: false,
    };
    expect(filterSpatialWorkspace(data, view).records.map((r) => r.id)).toEqual(
      ['row-1', 'annual'],
    );
    expect(yearly.time.precision).toBe('year');
    expect(yearly.value).toBe('Ⅲ');
  });

  it('resets region-local bounds, time, search and selection when changing region', () => {
    const view = {
      ...createSpatialWorkspaceView(pack, 'beiyun'),
      bounds: [116, 38, 117, 39] as const,
      start: '2023-12-01',
      search: '北运河',
      selection: { recordId: 'row-1', positionId: 'river' },
    };
    const next = switchSpatialWorkspaceRegion(view, pack, 'chaobai');
    expect(next.regionId).toBe('chaobai');
    expect(next.bounds).toBeNull();
    expect(next.start).toBeNull();
    expect(next.search).toBe('');
    expect(next.selection).toBeNull();
    expect(next.camera.longitude).toBe(117);
  });

  it('does not merge same-named objects in dossiers or count copies as independent evidence', () => {
    const copy = { ...source, id: 'copy', duplicateOf: 'report' };
    const other = { ...source, id: 'other', originalSha256: 'b'.repeat(64) };
    const data = {
      ...pack,
      sources: [...pack.sources, copy, other],
      records: [
        record,
        { ...record, id: 'copy-row', sourceId: 'copy' },
        { ...record, id: 'other-row', sourceId: 'other' },
      ],
    };
    expect(
      filterSpatialWorkspace(data, createSpatialWorkspaceView(data))
        .sourceCount,
    ).toBe(2);
    const dossier = workspaceObjectDossier(data, 'row-1');
    expect(dossier?.records.map((r) => r.id)).toEqual(['row-1']);
    expect(dossier?.copies.map((s) => s.id)).toEqual(['copy']);
    expect(dossier?.source.versionId).toBe('report-v1');
  });
});

describe('pinned scenes and source invalidation', () => {
  it('removes a changed geometry version from restored selection and dossier positions', () => {
    const view = {
      ...createSpatialWorkspaceView(pack),
      selection: { recordId: record.id, positionId: position.id },
    };
    const saved = captureSpatialWorkspaceView(pack, view);
    const changed = {
      ...pack,
      sources: pack.sources.map((source) =>
        source.id === geometrySource.id
          ? { ...source, originalSha256: 'f'.repeat(64) }
          : source,
      ),
    };
    const restored = restoreSpatialWorkspaceView(changed, saved)!;
    expect(filterSpatialWorkspace(changed, restored.view).geometryCount).toBe(
      0,
    );
    expect(restored.view.selection).toEqual({
      recordId: record.id,
      positionId: null,
    });
    expect(
      workspaceObjectDossier(changed, record.id, [], restored.view.sourcePins)
        ?.positions,
    ).toEqual([]);
  });

  it('does not silently display a changed source hash through an already fixed scene', () => {
    const saved = captureSpatialWorkspaceView(
      pack,
      createSpatialWorkspaceView(pack),
    );
    const changed = {
      ...pack,
      sources: pack.sources.map((source) =>
        source.id === record.sourceId
          ? { ...source, originalSha256: 'f'.repeat(64) }
          : source,
      ),
    };
    expect(filterSpatialWorkspace(changed, saved).records).toHaveLength(0);
  });
  it('pins both comparison scopes and restores a record selected in the right scope', () => {
    const rightSource = {
      ...source,
      id: 'right-source',
      versionId: 'right-v1',
    };
    const rightRecord = {
      ...record,
      id: 'right-record',
      sourceId: rightSource.id,
      versionId: rightSource.versionId,
      regionIds: ['beiyun' as const],
      positions: [
        {
          ...position,
          geometrySourceId: rightSource.id,
          geometryVersionId: rightSource.versionId,
        },
      ],
    };
    const data = {
      ...pack,
      sources: [...pack.sources, rightSource],
      records: [record, rightRecord],
    };
    const initial = createSpatialWorkspaceView(data, 'chaobai');
    const view = {
      ...initial,
      selection: { recordId: rightRecord.id, positionId: 'river' },
      comparison: {
        ...initial.comparison,
        enabled: true,
        left: { regionId: 'chaobai' as const, start: null, end: null },
        right: { regionId: 'beiyun' as const, start: null, end: null },
      },
    };
    const saved = captureSpatialWorkspaceView(data, view);
    expect(
      saved.sourcePins?.some((pin) => pin.sourceId === rightSource.id),
    ).toBe(true);
    expect(saved.selection?.recordId).toBe(rightRecord.id);
    expect(
      restoreSpatialWorkspaceView(data, saved)?.view.selection?.recordId,
    ).toBe(rightRecord.id);
  });

  it('counts explicitly shared works without merging their objects or versions', () => {
    const first = { ...source, workId: 'publication-one' },
      second = { ...source, id: 'second-source', workId: 'publication-one' };
    const data = {
      ...pack,
      sources: [first, second, geometrySource],
      records: [
        record,
        { ...record, id: 'second-record', sourceId: second.id },
      ],
    };
    expect(
      filterSpatialWorkspace(data, createSpatialWorkspaceView(data))
        .sourceCount,
    ).toBe(1);
    expect(workspaceObjectDossier(data, record.id)?.records).toHaveLength(1);
  });

  it('offers imagery only for a filtered, permitted exact-version footprint record', () => {
    const rasterRecord = {
      ...record,
      kind: 'raster' as const,
      sourceId: 'raster-source',
      versionId: 'raster-v1',
      positions: [
        {
          ...position,
          geometrySourceId: 'raster-source',
          geometryVersionId: 'raster-v1',
        },
      ],
    };
    const rasterSource = {
      ...source,
      id: 'raster-source',
      versionId: 'raster-v1',
      kind: 'raster' as const,
    };
    const report = {
      id: 'raster-report',
      sourceId: 'raster-source',
      versionId: 'raster-v1',
      sceneId: 'scene',
      acquiredAt: '2023-12-01',
      regionIds: ['chaobai' as const],
      title: '真实窗口',
      products: [],
      wgs84Bounds: [116, 39, 118, 41] as const,
      footprint: position.geometry,
      qualityLayerPresent: true,
      oneSceneOnly: true,
      controlPointVerified: false as const,
      rights: {
        displayAllowed: true,
        redistributionAllowed: true,
        note: '许可',
      },
      limitations: ['单景'],
    };
    const data = {
      ...pack,
      sources: [rasterSource],
      records: [rasterRecord],
      rasterReports: [report],
    };
    const view = createSpatialWorkspaceView(data);
    expect(workspaceRasterOverlays(data, view)).toHaveLength(1);
    expect(
      workspaceRasterOverlays(data, { ...view, kinds: ['observation'] }),
    ).toHaveLength(0);
    expect(
      workspaceRasterOverlays(data, view, [
        { sourceId: rasterSource.id, state: 'revoked' },
      ]),
    ).toHaveLength(0);
    expect(
      workspaceRasterOverlays(
        { ...data, rasterReports: [{ ...report, versionId: 'wrong-version' }] },
        view,
      ),
    ).toHaveLength(0);
  });
  it('restores camera, native filters, layers, selection and evidence identity without caching source text', () => {
    const view = {
      ...createSpatialWorkspaceView(pack, 'chaobai'),
      mode: '3d' as const,
      camera: {
        longitude: 116.8,
        latitude: 40.1,
        zoom: 8,
        bearing: 32,
        pitch: 55,
      },
      selection: { recordId: 'row-1', positionId: 'river' },
      expandedSources: ['report'],
    };
    const saved = captureSpatialWorkspaceView(pack, view);
    expect(JSON.stringify(saved)).not.toContain('/private/');
    expect(JSON.stringify(saved)).not.toContain('潮白河 Ⅲ');
    expect(JSON.stringify(saved)).not.toContain('coordinates');
    const restored = restoreSpatialWorkspaceView(
      pack,
      JSON.parse(JSON.stringify(saved)),
    );
    expect(restored?.view.camera).toEqual(view.camera);
    expect(restored?.view.selection).toEqual(view.selection);
    expect(
      restored?.view.sourcePins?.some((pin) => pin.versionId === 'report-v1'),
    ).toBe(true);
    expect(restored?.notices).toEqual([]);
  });

  it.each(['stale', 'revoked', 'missing'] as const)(
    'clears %s source objects and saved references without silently using a replacement',
    (state) => {
      const view = {
        ...createSpatialWorkspaceView(pack),
        selection: { recordId: 'row-1', positionId: 'river' },
        expandedSources: ['report'],
      };
      const saved = captureSpatialWorkspaceView(pack, view);
      const invalidations = [
        { sourceId: 'report', versionId: 'report-v1', state },
      ];
      const restored = restoreSpatialWorkspaceView(pack, saved, invalidations);
      expect(restored?.view.selection).toBeNull();
      expect(
        restored?.view.sourcePins?.some((pin) => pin.sourceId === 'report'),
      ).toBe(false);
      expect(restored?.view.expandedSources).toEqual([]);
      expect(restored?.notices.some((notice) => notice.state === state)).toBe(
        true,
      );
      expect(
        filterSpatialWorkspace(pack, restored!.view, invalidations).features
          .features,
      ).toEqual([]);
    },
  );

  it('keeps record-specific version impacts local to affected records', () => {
    const data = {
      ...pack,
      records: [
        record,
        { ...record, id: 'unaffected', objectId: 'another-river' },
      ],
    };
    const result = filterSpatialWorkspace(
      data,
      createSpatialWorkspaceView(data),
      [{ sourceId: 'report', state: 'stale', affectedRecordIds: ['row-1'] }],
    );
    expect(result.records.map((r) => r.id)).toEqual(['unaffected']);
  });

  it('clears a position whose licensed geometry source is withdrawn while retaining readable original text', () => {
    const view = {
      ...createSpatialWorkspaceView(pack),
      selection: { recordId: 'row-1', positionId: 'river' },
    };
    const saved = captureSpatialWorkspaceView(pack, view);
    const invalidations = [{ sourceId: 'geometry', state: 'revoked' as const }];
    const result = filterSpatialWorkspace(pack, view, invalidations);
    expect(result.geometryCount).toBe(0);
    expect(result.unlocatedRecords.some((r) => r.id === 'row-1')).toBe(true);
    expect(
      restoreSpatialWorkspaceView(pack, saved, invalidations)?.view.selection,
    ).toEqual({ recordId: 'row-1', positionId: null });
  });

  it('rejects corrupt scene shapes, invalid cameras and unrelated legacy payloads', () => {
    const saved = captureSpatialWorkspaceView(
      pack,
      createSpatialWorkspaceView(pack),
    );
    expect(
      restoreSpatialWorkspaceView(pack, {
        ...saved,
        camera: { ...saved.camera, longitude: 999 },
      }),
    ).toBeNull();
    expect(
      restoreSpatialWorkspaceView(pack, { ...saved, schemaVersion: 999 }),
    ).toBeNull();
    expect(
      restoreSpatialWorkspaceView(pack, { activeView: 'map', requests: {} }),
    ).toBeNull();
    expect(restoreSpatialWorkspaceView(pack, null)).toBeNull();
  });
});

const untypedPack = pack;
describe('comparison and permitted topic exports', () => {
  // These definitions and decisions are synthetic test facts, not a declaration
  // or professional approval of the shared monthly report fixture.
  const syntheticDefinition = (precision: 'day' | 'month' | 'year') => ({
    schemaVersion: 1 as const,
    reference: {
      definitionId: `synthetic-tn-${precision}`,
      definitionVersion: 'synthetic-v1',
      sourceId: source.id,
      sourceVersionId: source.versionId,
      sourceSha256: source.originalSha256,
    },
    track: 'SYNTHETIC' as const,
    measurementType: 'CONTINUOUS' as const,
    differenceUse: 'ALLOWED' as const,
    sourceDeclaration: {
      state: 'DECLARED' as const,
      evidence: {
        locator: 'synthetic definition §1',
        text: 'Synthetic test concentration, not real source approval',
      },
    },
    professionalReview: {
      state: 'APPROVED' as const,
      submittedBy: 'synthetic-proposer',
      reviewedBy: 'synthetic-independent-reviewer',
      decisionId: 'synthetic-review',
      evidence: {
        locator: 'synthetic review row',
        text: 'Synthetic independent review only',
      },
    },
    metric: {
      code: 'total-nitrogen',
      definition: 'Synthetic total nitrogen concentration',
      evidence: {
        locator: 'synthetic metric row',
        text: 'Synthetic continuous concentration',
      },
    },
    unit: {
      code: 'mg/L',
      evidence: { locator: 'synthetic unit row', text: 'Synthetic mg/L' },
    },
    method: {
      code: 'HJ-636',
      evidence: {
        locator: 'synthetic method row',
        text: 'Synthetic method code, not a real determination',
      },
    },
    temporal: {
      kind: 'INSTANT' as const,
      precision: precision.toUpperCase() as 'DAY' | 'MONTH' | 'YEAR',
      role: 'OBSERVATION' as const,
      length: 1,
      basis: `Synthetic single observation with ${precision} precision`,
      evidence: {
        locator: 'synthetic time row',
        text: 'Synthetic time definition',
      },
    },
    spatial: {
      kind: 'POINT' as const,
      support: 'Synthetic fixed sampling point',
      evidence: {
        locator: 'synthetic support row',
        text: 'Synthetic point support only',
      },
    },
    aggregation: {
      rule: 'SINGLE' as const,
      definition: 'Synthetic individual sample',
      evidence: {
        locator: 'synthetic rule row',
        text: 'Synthetic single observation, no aggregate',
      },
      denominator: {
        kind: 'NONE' as const,
        unit: null,
        basis: 'No aggregate denominator',
        evidence: {
          locator: 'synthetic denominator row',
          text: 'Synthetic individual sample',
        },
      },
    },
  });
  const pack: WorkspacePack = {
    ...untypedPack,
    sources: untypedPack.sources.map((s) => ({ ...s, track: 'SYNTHETIC' })),
    measurementDefinitions: ['day', 'month', 'year'].map((precision) =>
      syntheticDefinition(precision as 'day' | 'month' | 'year'),
    ),
  };
  // Explicitly synthetic point support. The shared record's reference river
  // geometry cannot serve as positive evidence for a sampling difference.
  const samplingPosition: WorkspacePosition = {
    ...position,
    id: 'synthetic-sampling-position',
    expression: 'Synthetic sampling point only',
    role: 'sampling',
    geometry: { type: 'Point', coordinates: [1, 1] },
    scaleNote: 'Synthetic point support; not a real station or aggregate',
    evidence: {
      locator: 'synthetic sampling row',
      text: 'Synthetic sampling point, not a real monitoring location',
    },
  };
  const numeric: WorkspaceRecord = {
    ...record,
    metric: 'total-nitrogen',
    value: '1.2',
    unit: 'mg/L',
    positions: [samplingPosition],
    track: 'SYNTHETIC',
    reviewStatus: 'synthetic-reviewed',
    measurement: {
      definition: syntheticDefinition('month').reference,
      track: 'SYNTHETIC',
      positionId: samplingPosition.id,
      denominator: null,
    },
    method: {
      code: 'HJ-636',
      evidence: {
        locator: 'methods paragraph 2',
        text: '本表总氮按HJ 636测定。',
        url: null,
      },
    },
  };

  it.each([
    ['source-defined index', 'index', '3', '4'],
    ['total-nitrogen', 'mg/L', '1.2', '1.5'],
  ])(
    'keeps %s values side by side without an evidenced measurement definition',
    (metric, unit, a, b) => {
      const left = {
        ...numeric,
        metric,
        unit,
        value: a,
        measurement: undefined,
      };
      const right = {
        ...numeric,
        id: 'undefined-measurement-next',
        metric,
        unit,
        value: b,
        measurement: undefined,
      };
      const original = JSON.stringify([left, right]);
      const result = compareWorkspaceRecords(left, right, pack);
      expect(result.state).toBe('side-by-side');
      expect(result.difference).toBeNull();
      expect(JSON.stringify([left, right])).toBe(original);
    },
  );

  it('does not make missing statistical grain comparable with a descriptive scale note', () => {
    const left = {
      ...numeric,
      measurement: undefined,
      positions: [{ ...samplingPosition, scaleNote: 'monthly data' }],
    };
    const right = { ...left, id: 'undefined-statistic-next', value: '1.5' };
    const result = compareWorkspaceRecords(left, right, pack);
    expect(result.state).toBe('side-by-side');
    expect(result.difference).toBeNull();
  });

  it('does not accept an unresolvable fixed definition reference', () => {
    const left = {
      ...numeric,
      measurement: {
        definition: {
          definitionId: 'absent-definition',
          definitionVersion: 'v1',
          sourceId: source.id,
          sourceVersionId: source.versionId,
          sourceSha256: source.originalSha256,
        },
        track: 'SYNTHETIC' as const,
        positionId: samplingPosition.id,
        denominator: null,
      },
    };
    const result = compareWorkspaceRecords(
      left,
      { ...left, id: 'absent-definition-next', value: '1.5' },
      pack,
    );
    expect(result.state).toBe('side-by-side');
    expect(result.difference).toBeNull();
  });

  it.each<{ name: string; positions: WorkspacePosition[] }>([
    { name: 'missing sampling position', positions: [] },
    { name: 'reference river only', positions: [position] },
    {
      name: 'same point used as a study area',
      positions: [{ ...samplingPosition, role: 'study-area' }],
    },
    {
      name: 'moved sampling point',
      positions: [
        {
          ...samplingPosition,
          geometry: { type: 'Point', coordinates: [2, 2] },
        },
      ],
    },
    {
      name: 'shared reference cannot cover a moved sampling point',
      positions: [
        position,
        {
          ...samplingPosition,
          geometry: { type: 'Point', coordinates: [2, 2] },
        },
      ],
    },
    {
      name: 'shared reference cannot cover candidate sampling',
      positions: [position, { ...samplingPosition, match: 'candidate' }],
    },
    {
      name: 'an extra ambiguous sampling declaration',
      positions: [
        samplingPosition,
        { ...samplingPosition, id: 'extra', match: 'ambiguous' },
      ],
    },
    {
      name: 'multiple bound sampling declarations without primary support',
      positions: [samplingPosition, { ...samplingPosition, id: 'extra' }],
    },
    {
      name: 'same point with changed support description',
      positions: [{ ...samplingPosition, scaleNote: 'Synthetic area average' }],
    },
    {
      name: 'unknown sampling support',
      positions: [{ ...samplingPosition, scaleNote: null }],
    },
    {
      name: 'empty sampling support',
      positions: [{ ...samplingPosition, scaleNote: '  ' }],
    },
    {
      name: 'unknown coordinate system',
      positions: [{ ...samplingPosition, crs: null }],
    },
    {
      name: 'invalid sampling geometry',
      positions: [
        {
          ...samplingPosition,
          geometry: { type: 'Point', coordinates: [1, 91] },
        },
      ],
    },
    {
      name: 'missing fixed geometry source',
      positions: [{ ...samplingPosition, geometrySourceId: null }],
    },
    {
      name: 'missing geometry evidence',
      positions: [{ ...samplingPosition, evidence: { locator: '', text: '' } }],
    },
    {
      name: 'missing geometry locator',
      positions: [{ ...samplingPosition, locator: null }],
    },
    {
      name: 'a different fixed geometry source despite equal coordinates',
      positions: [
        {
          ...samplingPosition,
          geometrySourceId: 'report',
          geometryVersionId: 'report-v1',
        },
      ],
    },
    {
      name: 'an unavailable fixed geometry version',
      positions: [{ ...samplingPosition, geometryVersionId: 'absent-version' }],
    },
  ])('withholds a numeric difference for $name', ({ positions }) => {
    const left = { ...numeric, positions: [position, samplingPosition] };
    const right = { ...numeric, id: 'synthetic-next', value: '1.5', positions };
    const originals = JSON.stringify([left, right, pack]);
    const result = compareWorkspaceRecords(left, right, pack);
    expect(result.state).toBe('side-by-side');
    expect(result.reasons).toContain('position');
    expect(result.difference).toBeNull();
    expect(JSON.stringify([left, right, pack])).toBe(originals);
  });

  it.each<Geometry>([
    {
      type: 'LineString',
      coordinates: [
        [1, 1],
        [2, 2],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [3, 0],
          [3, 3],
          [0, 3],
          [0, 0],
        ],
      ],
    },
    {
      type: 'MultiPoint',
      coordinates: [
        [1, 1],
        [2, 2],
      ],
    },
  ])(
    'does not infer aggregation grain from identical %s sampling geometry',
    (geometry) => {
      const left = {
        ...numeric,
        positions: [{ ...samplingPosition, geometry }],
      };
      const right = { ...left, id: 'synthetic-next', value: '1.5' };
      const result = compareWorkspaceRecords(left, right, pack);
      expect(result.state).toBe('side-by-side');
      expect(result.reasons).toContain('position');
      expect(result.difference).toBeNull();
    },
  );

  it.each(['stale', 'revoked', 'missing'] as const)(
    'withholds differences when the geometry source is %s',
    (state) => {
      const result = compareWorkspaceRecords(numeric, numeric, pack, [
        {
          sourceId: 'geometry',
          versionId: 'geometry-v1',
          state,
        },
      ]);
      expect(result.state).toBe('side-by-side');
      expect(result.reasons).toContain('position');
      expect(result.difference).toBeNull();
    },
  );

  it('withholds differences when the geometry source loses display permission', () => {
    const denied = {
      ...pack,
      sources: pack.sources.map((item) =>
        item.id === 'geometry'
          ? { ...item, rights: { ...item.rights, displayAllowed: false } }
          : item,
      ),
    };
    const result = compareWorkspaceRecords(numeric, numeric, denied);
    expect(result.state).toBe('side-by-side');
    expect(result.reasons).toContain('position');
    expect(result.difference).toBeNull();
  });

  it('retains synthetic point differences when references differ but sampling support is unchanged', () => {
    const result = compareWorkspaceRecords(
      { ...numeric, positions: [position, samplingPosition] },
      {
        ...numeric,
        id: 'synthetic-next',
        value: '1.5',
        positions: [samplingPosition],
      },
      pack,
    );
    expect(result.state).toBe('comparable');
    expect(result.difference).toBeCloseTo(0.3);
  });

  it.each(['unknown', ' 未知 ', '\tUnKnOwN\n', '\u00a0未知\u00a0'])(
    'does not accept matching explicitly unknown sampling support: %s',
    (scaleNote) => {
      const left = {
        ...numeric,
        positions: [{ ...samplingPosition, scaleNote }],
      };
      const right = { ...left, id: 'synthetic-next', value: '1.5' };
      const originals = JSON.stringify([left, right]);
      const result = compareWorkspaceRecords(left, right, pack);
      expect(result.state).toBe('side-by-side');
      expect(result.reasons).toContain('position');
      expect(result.difference).toBeNull();
      expect(JSON.stringify([left, right])).toBe(originals);
    },
  );

  it.each(['grade', 'GRADE'])(
    'does not subtract known categorical water-quality %s codes',
    (unit) => {
      const left = {
        ...numeric,
        metric: 'water-quality grade',
        unit,
        value: '3',
      };
      const right = { ...left, id: 'synthetic-grade-next', value: '4' };
      const originals = JSON.stringify([left, right]);
      const result = compareWorkspaceRecords(left, right, pack);
      expect(result.state).toBe('side-by-side');
      expect(result.reasons).toContain('categorical');
      expect(result.difference).toBeNull();
      expect(JSON.stringify([left, right])).toBe(originals);
    },
  );
  it('computes a difference only when object, metric, unit, native time precision and method evidence agree', () => {
    const next = {
      ...numeric,
      id: 'next-month',
      value: '1.5',
      time: { ...numeric.time, start: '2024-01', end: '2024-01' },
    };
    expect(compareWorkspaceRecords(numeric, next, pack).state).toBe(
      'comparable',
    );
    expect(compareWorkspaceRecords(numeric, next, pack).difference).toBeCloseTo(
      0.3,
    );
  });

  it.each([
    ['-1e308', '1e308'],
    ['1e308', '-1e308'],
  ])(
    'withholds an overflowing difference between finite inputs %s and %s',
    (a, b) => {
      const left = { ...numeric, value: a };
      const right = { ...numeric, id: 'finite-overflow-next', value: b };
      const originals = JSON.stringify([left, right]);
      expect(Number.isFinite(Number(a))).toBe(true);
      expect(Number.isFinite(Number(b))).toBe(true);
      const result = compareWorkspaceRecords(left, right, pack);
      expect(result.state).toBe('side-by-side');
      expect(result.reasons).toContain('numeric');
      expect(result.difference).toBeNull();
      expect(JSON.stringify([left, right])).toBe(originals);
    },
  );

  it('retains a valid zero difference without treating zero as missing', () => {
    const zero = { ...numeric, value: '0' };
    const result = compareWorkspaceRecords(zero, zero, pack);
    expect(result.state).toBe('comparable');
    expect(result.difference).toBe(0);
  });

  it.each([' 未知 ', ' unknown ', '\tUnKnOwN\n', '\u00a0未知\u00a0'])(
    'does not make an unknown unit comparable by adding whitespace: %s',
    (unit) => {
      const left = { ...numeric, unit };
      const right = { ...numeric, id: 'unknown-unit-next', value: '1.5', unit };
      const originals = JSON.stringify([left, right]);
      const result = compareWorkspaceRecords(left, right, pack);
      expect(result.state).toBe('side-by-side');
      expect(result.reasons).toContain('unit');
      expect(result.difference).toBeNull();
      expect(JSON.stringify([left, right])).toBe(originals);
    },
  );

  it.each([
    { precision: 'day', start: '2023-04', end: '2023-04' },
    { precision: 'day', start: '2023', end: '2023' },
    { precision: 'month', start: '2023', end: '2023' },
    { precision: 'day', start: '2023-04-01', end: '2023-04' },
    { precision: 'day', start: null, end: '2023-04' },
  ] as const)(
    'withholds differences when original dates do not support declared precision: %s',
    (time) => {
      const left = { ...numeric, time: { ...numeric.time, ...time } };
      const right = { ...left, id: 'unsupported-precision-next', value: '1.5' };
      const originals = JSON.stringify([left, right]);
      // Calendar range expansion is still useful for ordinary time filters.
      // It must not create missing precision for numeric comparison.
      expect(workspaceNativeTime(left)).not.toBeNull();
      const result = compareWorkspaceRecords(left, right, pack);
      expect(result.state).toBe('side-by-side');
      expect(result.reasons).toContain('time');
      expect(result.difference).toBeNull();
      expect(JSON.stringify([left, right])).toBe(originals);
    },
  );

  it.each([
    { precision: 'day', start: '2024-02-29', end: '2024-02-29' },
    { precision: 'month', start: '2024-02', end: '2024-02' },
    { precision: 'year', start: '2024', end: '2024' },
  ] as const)(
    'retains supported native date precision and valid zero differences: %s',
    (time) => {
      const left = {
        ...numeric,
        value: '0',
        time: { ...numeric.time, ...time },
        measurement: {
          ...numeric.measurement!,
          definition: syntheticDefinition(time.precision).reference,
        },
      };
      const result = compareWorkspaceRecords(left, left, pack);
      expect(result.state).toBe('comparable');
      expect(result.difference).toBe(0);
    },
  );

  it('keeps unequal unit strings blocked without silently normalizing or converting them', () => {
    const result = compareWorkspaceRecords(
      { ...numeric, unit: ' mg/L ' },
      { ...numeric, unit: 'mg/L' },
      pack,
    );
    expect(result.reasons).toContain('unit');
    expect(result.difference).toBeNull();
  });

  it.each([
    [{ objectId: 'same-name-different-id' }, 'object'],
    [{ sourceId: 'another-work' }, 'object'],
    [{ metric: 'ammonia' }, 'metric'],
    [{ unit: null }, 'unit'],
    [{ method: undefined }, 'method'],
    [{ time: { ...numeric.time, role: 'publication' as const } }, 'time'],
    [{ time: { ...numeric.time, precision: 'year' as const } }, 'time'],
    [{ value: '<1.5' }, 'numeric'],
  ] as const)(
    'retains side-by-side reading when comparison condition is missing: %s',
    (change, reason) => {
      const result = compareWorkspaceRecords(
        numeric,
        { ...numeric, ...change },
        pack,
      );
      expect(result.state).toBe('side-by-side');
      expect(result.reasons).toContain(reason);
      expect(result.difference).toBeNull();
    },
  );

  it('does not subtract water-quality categories even when they look numeric', () => {
    const first = {
      ...record,
      value: '3',
      unit: 'category',
      method: numeric.method,
    };
    const result = compareWorkspaceRecords(
      first,
      { ...first, value: '4' },
      pack,
    );
    expect(result.reasons).toContain('categorical');
    expect(result.difference).toBeNull();
  });

  it('does not calculate a difference with a stale processing result', () => {
    const result = compareWorkspaceRecords(numeric, numeric, pack, [
      { sourceId: 'report', state: 'stale', affectedRecordIds: ['row-1'] },
    ]);
    expect(result.reasons).toContain('stale');
    expect(result.difference).toBeNull();
  });

  it.each(['REACH', 'AREA'] as const)(
    'permits evidenced synthetic %s aggregates without inventing support from geometry',
    (kind) => {
      const definition = {
        ...syntheticDefinition('month'),
        temporal: {
          ...syntheticDefinition('month').temporal,
          kind: 'PERIOD' as const,
          basis: 'Synthetic calendar month',
        },
        spatial: {
          ...syntheticDefinition('month').spatial,
          kind,
          support: `Synthetic fixed ${kind} mean`,
        },
        aggregation: {
          ...syntheticDefinition('month').aggregation,
          rule: 'MEAN' as const,
          definition: 'Synthetic mean of independent observations',
          denominator: {
            kind: 'OBSERVATIONS' as const,
            unit: 'count',
            basis: 'Independent synthetic observations',
            evidence: {
              locator: 'synthetic denominator row',
              text: 'Five independent synthetic observations',
            },
          },
        },
      };
      const geometry: Geometry =
        kind === 'REACH'
          ? {
              type: 'LineString',
              coordinates: [
                [1, 1],
                [2, 2],
              ],
            }
          : {
              type: 'Polygon',
              coordinates: [
                [
                  [1, 1],
                  [2, 1],
                  [2, 2],
                  [1, 2],
                  [1, 1],
                ],
              ],
            };
      const aggregate: WorkspaceRecord = {
        ...numeric,
        positions: [
          {
            ...samplingPosition,
            geometry,
            scaleNote: `Synthetic ${kind} support`,
          },
        ],
        measurement: {
          ...numeric.measurement!,
          denominator: {
            kind: 'OBSERVATIONS',
            value: 5,
            unit: 'count',
            basis: 'Independent synthetic observations',
            evidence: {
              locator: 'synthetic original row',
              text: 'Synthetic denominator 5, not real monthly observations',
            },
          },
        },
      };
      const typedPack = { ...pack, measurementDefinitions: [definition] };
      const original = JSON.stringify([aggregate, typedPack]);
      const result = compareWorkspaceRecords(
        aggregate,
        { ...aggregate, value: '1.5' },
        typedPack,
      );
      expect(result.state).toBe('comparable');
      expect(result.difference).toBeCloseTo(0.3);
      expect(
        compareWorkspaceRecords(
          aggregate,
          {
            ...aggregate,
            measurement: { ...aggregate.measurement!, denominator: null },
          },
          typedPack,
        ).difference,
      ).toBeNull();
      expect(
        compareWorkspaceRecords(
          aggregate,
          {
            ...aggregate,
            positions: [{ ...aggregate.positions[0], role: 'reference' }],
          },
          typedPack,
        ).reasons,
      ).toContain('position');
      expect(
        compareWorkspaceRecords(
          aggregate,
          {
            ...aggregate,
            positions: [
              ...aggregate.positions,
              {
                ...samplingPosition,
                id: 'unresolved-extra',
                match: 'candidate',
              },
            ],
          },
          typedPack,
        ).difference,
      ).toBeNull();
      expect(JSON.stringify([aggregate, typedPack])).toBe(original);
    },
  );

  it('keeps real pending records and undefined indices side by side even with a synthetic definition', () => {
    expect(
      compareWorkspaceRecords(
        { ...numeric, track: 'REAL', reviewStatus: 'pending' },
        numeric,
        pack,
      ).difference,
    ).toBeNull();
    const index = {
      ...numeric,
      metric: 'source-defined index',
      unit: 'index',
      value: '3',
    };
    expect(
      compareWorkspaceRecords(index, { ...index, value: '4' }, pack).difference,
    ).toBeNull();
  });
  it('requires an explicit matching source track instead of trusting a synthetic label on the record', () => {
    const realPack = {
      ...pack,
      sources: pack.sources.map((s) => ({ ...s, track: 'REAL' as const })),
    };
    expect(
      compareWorkspaceRecords(numeric, numeric, realPack).difference,
    ).toBeNull();
  });

  it.each(['stale', 'revoked', 'missing'] as const)(
    'removes calculation when the independent definition source is %s',
    (state) => {
      const definitionSource = {
        ...source,
        track: 'SYNTHETIC' as const,
        id: 'synthetic-definition-source',
        versionId: 'synthetic-definition-v1',
      };
      const definition = {
        ...syntheticDefinition('month'),
        reference: {
          ...syntheticDefinition('month').reference,
          sourceId: definitionSource.id,
          sourceVersionId: definitionSource.versionId,
        },
      };
      const bound = {
        ...numeric,
        measurement: {
          ...numeric.measurement!,
          definition: definition.reference,
        },
      };
      const typedPack = {
        ...pack,
        sources: [...pack.sources, definitionSource],
        measurementDefinitions: [definition],
      };
      expect(compareWorkspaceRecords(bound, bound, typedPack).difference).toBe(
        0,
      );
      expect(
        compareWorkspaceRecords(bound, bound, typedPack, [
          {
            sourceId: definitionSource.id,
            versionId: definitionSource.versionId,
            state,
          },
        ]).difference,
      ).toBeNull();
      const denied = {
        ...typedPack,
        sources: typedPack.sources.map((s) =>
          s.id === definitionSource.id
            ? { ...s, rights: { ...s.rights, displayAllowed: false } }
            : s,
        ),
      };
      expect(
        compareWorkspaceRecords(bound, bound, denied).difference,
      ).toBeNull();
      const changedHash = {
        ...typedPack,
        sources: typedPack.sources.map((s) =>
          s.id === definitionSource.id
            ? { ...s, originalSha256: 'b'.repeat(64) }
            : s,
        ),
      };
      expect(
        compareWorkspaceRecords(bound, bound, changedHash).difference,
      ).toBeNull();
    },
  );

  it('validates and retains additive comparison context while old packs remain readable', () => {
    expect(parseWorkspacePack(untypedPack).records).toHaveLength(
      untypedPack.records.length,
    );
    const typed = { ...pack, records: [numeric] };
    const parsed = parseWorkspacePack(typed);
    expect(parsed.records[0].measurement).toEqual(numeric.measurement);
    expect(parsed.measurementDefinitions).toEqual(pack.measurementDefinitions);
    expect(
      compareWorkspaceRecords(parsed.records[0], parsed.records[0], parsed)
        .difference,
    ).toBe(0);
    expect(JSON.stringify(parsed)).not.toContain('/private/');
    expect(() =>
      parseWorkspacePack({
        ...typed,
        records: [
          {
            ...numeric,
            measurement: { ...numeric.measurement, track: 'inferred' },
          },
        ],
      }),
    ).toThrow('measurement-binding');
    expect(() =>
      parseWorkspacePack({
        ...typed,
        measurementDefinitions: [
          { ...pack.measurementDefinitions![0], injected: true },
        ],
      }),
    ).toThrow('measurement-definition');
  });

  it('crops denied definition evidence and references from browser packs and exports', () => {
    const definitionSource = {
      ...source,
      track: 'SYNTHETIC' as const,
      id: 'synthetic-private-definition',
      versionId: 'definition-v1',
      title: 'Synthetic private definition',
      rights: {
        ...source.rights,
        displayAllowed: false,
        redistributionAllowed: false,
      },
    };
    const definition = {
      ...syntheticDefinition('month'),
      reference: {
        ...syntheticDefinition('month').reference,
        sourceId: definitionSource.id,
        sourceVersionId: definitionSource.versionId,
      },
    };
    const bound = {
      ...numeric,
      measurement: {
        ...numeric.measurement!,
        definition: definition.reference,
      },
    };
    const denied = {
      ...pack,
      records: [bound],
      sources: [...pack.sources, definitionSource],
      measurementDefinitions: [definition],
    };
    const parsed = parseWorkspacePack(denied);
    expect(parsed.records[0].measurement).toBeUndefined();
    expect(parsed.measurementDefinitions).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain(definitionSource.id);
    const visible = {
      ...denied,
      sources: denied.sources.map((s) =>
        s.id === definitionSource.id
          ? { ...s, rights: { ...s.rights, displayAllowed: true } }
          : s,
      ),
    };
    const exported = exportWorkspaceTopic(visible, 'chaobai-topic');
    expect(exported?.records).toHaveLength(1);
    expect(exported?.records[0].measurement).toBeUndefined();
    expect(exported?.measurementDefinitions).toEqual([]);
    expect(JSON.stringify(exported)).not.toContain(definitionSource.id);
  });

  it('exports only the fixed permitted definitions actually referenced by the topic', () => {
    const typed = { ...pack, records: [numeric] };
    const exported = exportWorkspaceTopic(typed, 'chaobai-topic');
    expect(exported?.measurementDefinitions).toEqual([
      syntheticDefinition('month'),
    ]);
    expect(exported?.records[0].measurement).toEqual(numeric.measurement);
    expect(JSON.stringify(exported)).not.toContain('/private/');
  });

  it('pins the independent definition source without dropping original records after a definition-rule change', () => {
    const definitionSource = {
      ...source,
      track: 'SYNTHETIC' as const,
      id: 'synthetic-definition-source',
      versionId: 'synthetic-definition-v1',
    };
    const definition = {
      ...syntheticDefinition('month'),
      reference: {
        ...syntheticDefinition('month').reference,
        sourceId: definitionSource.id,
        sourceVersionId: definitionSource.versionId,
      },
    };
    const bound = {
      ...numeric,
      measurement: {
        ...numeric.measurement!,
        definition: definition.reference,
      },
    };
    const typedPack = {
      ...pack,
      records: [bound],
      sources: [...pack.sources, definitionSource],
      measurementDefinitions: [definition],
    };
    const scene = captureSpatialWorkspaceView(
      typedPack,
      createSpatialWorkspaceView(typedPack),
    );
    expect(scene.sourcePins).toContainEqual({
      sourceId: definitionSource.id,
      versionId: definitionSource.versionId,
      sha256: definitionSource.originalSha256,
      processingVersion: definitionSource.processingVersion,
    });
    const changed = {
      ...typedPack,
      sources: typedPack.sources.map((s) =>
        s.id === definitionSource.id
          ? { ...s, processingVersion: 'changed-definition-rule' }
          : s,
      ),
    };
    const restored = restoreSpatialWorkspaceView(changed, scene)!;
    expect(restored.notices).toContainEqual({
      sourceId: definitionSource.id,
      versionId: definitionSource.versionId,
      state: 'stale',
    });
    expect(
      filterSpatialWorkspace(changed, restored.view).records.map((r) => r.id),
    ).toEqual([bound.id]);
    expect(
      compareWorkspaceRecords(
        bound,
        bound,
        changed,
        [],
        restored.view.sourcePins,
      ).difference,
    ).toBeNull();
    expect(
      compareWorkspaceRecords(bound, bound, typedPack, [], scene.sourcePins)
        .difference,
    ).toBe(0);
  });

  it('exports only redistribution-permitted content and never original local paths', () => {
    const exported = exportWorkspaceTopic(pack, 'chaobai-topic');
    expect(exported?.records.map((r) => r.id)).toEqual(['row-1']);
    expect(JSON.stringify(exported)).not.toContain('/private/');
    const blocked = {
      ...pack,
      sources: [
        {
          ...source,
          rights: { ...source.rights, redistributionAllowed: false },
        },
        geometrySource,
      ],
    };
    expect(exportWorkspaceTopic(blocked, 'chaobai-topic')?.records).toEqual([]);
    expect(exportWorkspaceTopic(pack, 'missing-topic')).toBeNull();
  });

  it.each([
    'file:///private/original.pdf',
    'https://user:password@example.gov.cn/',
    'http://127.0.0.1:3101/',
    'http://10.0.0.2/',
    'https://example.gov.cn/?token=secret',
    'javascript:alert(1)',
  ])(
    'does not surface a private or credential-bearing evidence link: %s',
    (url) => {
      expect(workspaceEvidenceUrl(url)).toBeNull();
    },
  );
  it('retains ordinary public evidence links', () => {
    expect(workspaceEvidenceUrl(source.evidenceUrl)).toBe(source.evidenceUrl);
  });
});

describe('geographic rendering invariants', () => {
  it.each([
    { type: 'Point', coordinates: [116] },
    { type: 'Point', coordinates: [116, Number.NaN] },
    { type: 'Point', coordinates: [216, 40] },
    { type: 'LineString', coordinates: [[116, 40]] },
    {
      type: 'Polygon',
      coordinates: [
        [
          [116, 40],
          [117, 40],
          [117, 41],
          [116, 41],
        ],
      ],
    },
    { type: 'GeometryCollection', geometries: [] },
    { type: 'Polygon', coordinates: [] },
  ])(
    'rejects malformed input rather than inventing repaired coordinates: %s',
    (value) => {
      expect(isWorkspaceGeometry(value)).toBe(false);
    },
  );

  it('takes a card connector anchor from original geometry, including a polygon with a hole', () => {
    expect(workspaceGeometryAnchor(rectangle)).toEqual([114, 38]);
    expect(
      workspaceGeometryAnchor({
        type: 'Point',
        coordinates: [116.2, 40.1, 20],
      }),
    ).toEqual([116.2, 40.1]);
  });

  it('uses the map-provided 3D matrix, including its perspective divide', () => {
    const matrix = [2, 0, 0, 0, 0, 2, 0, 0, 0, -1, 1, 1, -1, -1, 0, 1];
    expect(projectWorkspaceCoordinate(matrix, [0.5, 0.5, 0], 800, 600)).toEqual(
      {
        x: 400,
        y: 300,
      },
    );
    expect(
      projectWorkspaceCoordinate(matrix, [0.5, 0.5, 0.5], 800, 600),
    ).toEqual({
      x: 400,
      y: 400,
    });
  });

  it('clips connectors behind the camera or outside its depth range', () => {
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(projectWorkspaceCoordinate(matrix, [0, 0, 2], 800, 600)).toBeNull();
    expect(
      projectWorkspaceCoordinate(
        matrix.map((n) => -n),
        [0, 0, 0],
        800,
        600,
      ),
    ).toBeNull();
    expect(projectWorkspaceCoordinate([], [0, 0, 0], 800, 600)).toBeNull();
  });
});

it('carries readable source and position context only from display-permitted fixed geometry', () => {
  const scoped = { ...pack, records: [record] };
  const view = createSpatialWorkspaceView(scoped);
  const filtered = filterSpatialWorkspace(scoped, view);
  expect(filtered.features.features[0].properties).toMatchObject({
    sourceTitle: source.title,
    positionExpression: position.expression,
    scaleNote: position.scaleNote,
    recordId: record.id,
    positionId: position.id,
    role: 'reference',
  });
  expect(filtered.features.features[0].geometry).toBe(position.geometry);
  const withdrawn = {
    ...scoped,
    sources: scoped.sources.map((material) =>
      material.id === geometrySource.id
        ? { ...material, rights: { ...material.rights, displayAllowed: false } }
        : material,
    ),
  };
  expect(filterSpatialWorkspace(withdrawn, view).features.features).toEqual([]);
});
