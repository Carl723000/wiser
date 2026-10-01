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
} from './spatial-workspace-view';

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

describe('comparison and permitted topic exports', () => {
  const numeric: WorkspaceRecord = {
    ...record,
    metric: 'total-nitrogen',
    value: '1.2',
    unit: 'mg/L',
    method: {
      code: 'HJ-636',
      evidence: {
        locator: 'methods paragraph 2',
        text: '本表总氮按HJ 636测定。',
        url: null,
      },
    },
  };
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
