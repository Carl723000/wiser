import type { Geometry } from 'geojson';
import type {
  Material,
  RegionId,
  WorkspaceBounds,
  WorkspaceEvidence,
  WorkspacePack,
  WorkspacePosition,
  WorkspaceRasterReport,
  WorkspaceRecord,
} from './spatial-workspace-contract';

function fail(code: string): never {
  throw new Error(`spatial-pack:${code}`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.length > 20000) fail('string');
  return value;
}
function nullable(value: unknown): string | null {
  return value === null ? null : string(value);
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('boolean');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('number');
  return value;
}
function count(value: unknown): number {
  const n = number(value);
  if (n < 0 || !Number.isInteger(n)) fail('count');
  return n;
}
function array(value: unknown, maximum = 5000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail('array');
  return value;
}
function strings(value: unknown): string[] {
  return array(value).map(string);
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) fail('enum');
  return value as T;
}
const regionIds = [
  'bth',
  'yongding',
  'chaobai',
  'beiyun',
  'daqing-baiyangdian',
  'bohai',
] as const;
function regions(value: unknown): RegionId[] {
  return array(value, 6).map((v) => choice(v, regionIds));
}
function needs(value: unknown): string[] {
  const ids = strings(value);
  if (ids.some((id) => !/^K5-0(?:0[1-9]|1[0-9])$/.test(id))) fail('need-id');
  return ids;
}
function hash(value: unknown): string {
  const text = string(value);
  if (!/^[a-f0-9]{64}$/.test(text)) fail('hash');
  return text;
}
function url(value: unknown, thumbnail = false): string | null {
  if (value === null) return null;
  const text = string(value);
  if (thumbnail && /^\/spatial-workspace-media\/[a-zA-Z0-9._-]+$/.test(text))
    return text;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return fail('url');
  }
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(
      parsed.hostname,
    )
  )
    fail('url');
  return text;
}
function evidence(value: unknown): WorkspaceEvidence {
  const v = object(value);
  return { locator: string(v.locator), text: string(v.text), url: url(v.url) };
}
function bounds(value: unknown): WorkspaceBounds {
  const a = array(value, 4).map(number);
  if (
    a.length !== 4 ||
    a[0] > a[2] ||
    a[1] > a[3] ||
    a[0] < -180 ||
    a[2] > 180 ||
    a[1] < -90 ||
    a[3] > 90
  )
    fail('bounds');
  return a as unknown as WorkspaceBounds;
}
function geometry(value: unknown, depth = 0): Geometry | null {
  if (value === null) return null;
  if (depth > 5) fail('geometry-depth');
  const v = object(value);
  const type = choice(v.type, [
    'Point',
    'MultiPoint',
    'LineString',
    'MultiLineString',
    'Polygon',
    'MultiPolygon',
    'GeometryCollection',
  ] as const);
  if (type === 'GeometryCollection')
    return {
      type,
      geometries: array(v.geometries, 100).map((g) => {
        const result = geometry(g, depth + 1);
        if (!result) fail('geometry');
        return result;
      }),
    };
  let vertices = 0;
  function coordinates(input: unknown, level: number): unknown {
    const values = array(input, 150000);
    if (level === 0) {
      if (values.length < 2 || values.length > 3 || ++vertices > 150000)
        fail('coordinates');
      const p = values.map(number);
      if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) fail('coordinates');
      return p;
    }
    return values.map((item) => coordinates(item, level - 1));
  }
  const levels = {
    Point: 0,
    MultiPoint: 1,
    LineString: 1,
    MultiLineString: 2,
    Polygon: 2,
    MultiPolygon: 3,
  };
  return {
    type,
    coordinates: coordinates(v.coordinates, levels[type]),
  } as Geometry;
}
function source(value: unknown): Material {
  const v = object(value),
    rights = object(v.rights),
    status = object(v.status);
  const result: Material = {
    id: string(v.id),
    versionId: string(v.versionId),
    title: string(v.title),
    provider: string(v.provider),
    kind: choice(v.kind, [
      'report',
      'policy',
      'research',
      'spatial',
      'raster',
    ] as const),
    originalSha256: hash(v.originalSha256),
    evidenceUrl: url(v.evidenceUrl),
    rights: {
      public: bool(rights.public),
      displayAllowed: bool(rights.displayAllowed),
      redistributionAllowed: bool(rights.redistributionAllowed),
      note: string(rights.note),
    },
    regionIds: regions(v.regionIds),
    needIds: needs(v.needIds),
    processingVersion: string(v.processingVersion),
    duplicateOf: nullable(v.duplicateOf),
    status: {
      original: string(status.original),
      parsed: string(status.parsed),
      checked: string(status.checked),
      professionalReview: string(status.professionalReview),
      space: string(status.space),
      use: string(status.use),
    },
  };
  if (v.coverageNote !== undefined)
    result.coverageNote = string(v.coverageNote);
  if (v.fieldNames !== undefined) result.fieldNames = strings(v.fieldNames);
  if (v.quantity !== undefined) {
    const q = object(v.quantity);
    result.quantity = {
      candidateRows: count(q.candidateRows),
      sourceObjects: count(q.sourceObjects),
      geometryRecords: count(q.geometryRecords),
      validObservations:
        q.validObservations === null ? null : count(q.validObservations),
    };
  }
  return result;
}
function position(value: unknown): WorkspacePosition {
  const v = object(value),
    e = object(v.evidence);
  const result: WorkspacePosition = {
    id: string(v.id),
    expression: string(v.expression),
    role: choice(v.role, [
      'study-area',
      'sampling',
      'event-location',
      'applicable-area',
      'mention',
      'institution-address',
      'reference',
    ] as const),
    match: choice(v.match, [
      'bound',
      'candidate',
      'text-only',
      'ambiguous',
      'restricted',
    ] as const),
    geometry: geometry(v.geometry),
    crs: v.crs === null ? null : choice(v.crs, ['EPSG:4326'] as const),
    geometrySourceId: nullable(v.geometrySourceId),
    geometryVersionId: nullable(v.geometryVersionId),
    locator: nullable(v.locator),
    scaleNote: nullable(v.scaleNote),
    evidence: { locator: string(e.locator), text: string(e.text) },
  };
  if (v.nativeCrs !== undefined) result.nativeCrs = nullable(v.nativeCrs);
  if (
    result.geometry &&
    (result.crs !== 'EPSG:4326' ||
      !result.geometrySourceId ||
      !result.geometryVersionId ||
      !result.locator)
  )
    fail('geometry-evidence');
  if (result.match === 'bound' && !result.geometry) fail('bound-geometry');
  if (result.match === 'restricted' && result.geometry)
    fail('restricted-geometry');
  return result;
}
function record(value: unknown): WorkspaceRecord {
  const v = object(value),
    t = object(v.time);
  const start = nullable(t.start),
    end = nullable(t.end);
  const precision = choice(t.precision, [
    'day',
    'month',
    'year',
    'unknown',
  ] as const);
  for (const time of [start, end])
    if (
      time !== null &&
      !/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/.test(time)
    )
      fail('time');
  if (start && end && start > end) fail('time-order');
  const result: WorkspaceRecord = {
    id: string(v.id),
    sourceId: string(v.sourceId),
    versionId: string(v.versionId),
    objectId: string(v.objectId),
    objectLabel: string(v.objectLabel),
    kind: choice(v.kind, [
      'observation',
      'event',
      'policy',
      'research',
      'spatial',
      'raster',
    ] as const),
    regionIds: regions(v.regionIds),
    needIds: needs(v.needIds),
    time: {
      start,
      end,
      precision,
      role: choice(t.role, [
        'observation',
        'publication',
        'event',
        'acquisition',
        'unknown',
      ] as const),
    },
    metric: string(v.metric),
    value: nullable(v.value),
    unit: nullable(v.unit),
    positions: array(v.positions, 100).map(position),
    evidence: array(v.evidence, 100).map(evidence),
    processingVersion: string(v.processingVersion),
    reviewStatus: choice(v.reviewStatus, [
      'pending',
      'synthetic-reviewed',
    ] as const),
    missingReasons: strings(v.missingReasons),
  };
  if (v.method !== undefined) {
    const m = object(v.method);
    result.method = { code: string(m.code), evidence: evidence(m.evidence) };
  }
  return result;
}
function raster(value: unknown): WorkspaceRasterReport {
  const v = object(value),
    rights = object(v.rights);
  return {
    id: string(v.id),
    sourceId: string(v.sourceId),
    versionId: string(v.versionId),
    sceneId: string(v.sceneId),
    acquiredAt: nullable(v.acquiredAt),
    regionIds: regions(v.regionIds),
    title: string(v.title),
    products: array(v.products, 8).map((input) => {
      const p = object(input),
        s = object(p.stats);
      const resolution =
        p.resolution === null ? null : array(p.resolution, 2).map(number);
      if (resolution && resolution.length !== 2) fail('resolution');
      const frequency =
        p.classFrequency === null
          ? null
          : Object.fromEntries(
              Object.entries(object(p.classFrequency)).map(([k, n]) => [
                string(k),
                count(n),
              ]),
            );
      return {
        band: choice(p.band, ['B03', 'B8A', 'SCL', 'TCI'] as const),
        width: count(p.width),
        height: count(p.height),
        channels: count(p.channels),
        dtype: string(p.dtype),
        sha256: hash(p.sha256),
        hashMatches: bool(p.hashMatches),
        readable: bool(p.readable),
        nativeCrs: nullable(p.nativeCrs),
        resolution: resolution as [number, number] | null,
        noData: array(p.noData, 4).map((n) => (n === null ? null : number(n))),
        scales: array(p.scales, 4).map(number),
        offsets: array(p.offsets, 4).map(number),
        stats: {
          min: number(s.min),
          max: number(s.max),
          validPixels: count(s.validPixels),
          noDataPixels: count(s.noDataPixels),
        },
        classFrequency: frequency,
        thumbnailUrl: url(p.thumbnailUrl, true),
      };
    }),
    wgs84Bounds: v.wgs84Bounds === null ? null : bounds(v.wgs84Bounds),
    footprint: geometry(v.footprint),
    qualityLayerPresent: bool(v.qualityLayerPresent),
    oneSceneOnly: bool(v.oneSceneOnly),
    controlPointVerified:
      v.controlPointVerified === false ? false : fail('control-point-status'),
    rights: {
      displayAllowed: bool(rights.displayAllowed),
      redistributionAllowed: bool(rights.redistributionAllowed),
      note: string(rights.note),
    },
    limitations: strings(v.limitations),
  };
}

/** Validate all identities before applying the stricter anonymous local-display boundary. */
export function parseWorkspacePack(input: unknown): WorkspacePack {
  const v = object(input);
  if (v.schemaVersion !== 1) fail('schema-version');
  const sources = array(v.sources, 80).map(source),
    records = array(v.records).map(record);
  const allVersions = new Set(sources.map((s) => `${s.id}\0${s.versionId}`));
  if (
    allVersions.size !== sources.length ||
    new Set(records.map((r) => r.id)).size !== records.length
  )
    fail('duplicate-identity');
  for (const r of records) {
    if (!allVersions.has(`${r.sourceId}\0${r.versionId}`))
      fail('source-version');
    for (const p of r.positions)
      if (
        p.geometry &&
        !allVersions.has(`${p.geometrySourceId}\0${p.geometryVersionId}`)
      )
        fail('geometry-source-version');
  }
  const allowed = sources.filter(
    (s) => s.rights.public && s.rights.displayAllowed,
  );
  const allowedVersions = new Set(
      allowed.map((s) => `${s.id}\0${s.versionId}`),
    ),
    ids = new Set(allowed.map((s) => s.id));
  const visibleRecords = records
    .filter((r) => allowedVersions.has(`${r.sourceId}\0${r.versionId}`))
    .map((r) => ({
      ...r,
      positions: r.positions.map((p) =>
        p.geometry &&
        !allowedVersions.has(`${p.geometrySourceId}\0${p.geometryVersionId}`)
          ? {
              ...p,
              geometry: null,
              crs: null,
              match: 'restricted' as const,
              geometrySourceId: null,
              geometryVersionId: null,
              locator: null,
            }
          : p,
      ),
    }));
  const recordIds = new Set(visibleRecords.map((r) => r.id));
  return {
    schemaVersion: 1,
    generatedAt: string(v.generatedAt),
    processingVersion: string(v.processingVersion),
    sources: allowed,
    records: visibleRecords,
    regions: array(v.regions, 6).map((input) => {
      const r = object(input);
      return {
        id: choice(r.id, regionIds),
        name: string(r.name),
        aliases: strings(r.aliases),
        type: string(r.type),
        bounds: bounds(r.bounds),
      };
    }),
    topicPackages: array(v.topicPackages, 30).map((input) => {
      const t = object(input);
      return {
        id: string(t.id),
        title: string(t.title),
        regionIds: regions(t.regionIds),
        sourceIds: strings(t.sourceIds).filter((id) => ids.has(id)),
        recordIds: strings(t.recordIds).filter((id) => recordIds.has(id)),
        question: string(t.question),
        gaps: strings(t.gaps),
      };
    }),
    rasterReports: array(v.rasterReports, 20)
      .map(raster)
      .filter(
        (r) =>
          r.rights.displayAllowed &&
          allowedVersions.has(`${r.sourceId}\0${r.versionId}`),
      ),
  };
}
