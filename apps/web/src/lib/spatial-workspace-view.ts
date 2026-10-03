import type { FeatureCollection, Geometry, Position } from 'geojson';
import type {
  Material,
  RegionId,
  WorkspaceBounds,
  WorkspacePack,
  WorkspacePosition,
  WorkspaceRecord,
  WorkspaceRasterReport,
} from './spatial-workspace-contract';
export type { WorkspaceBounds } from './spatial-workspace-contract';

function coordinate(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    value.every(
      (number) => typeof number === 'number' && Number.isFinite(number),
    ) &&
    Math.abs(value[0] as number) <= 180 &&
    Math.abs(value[1] as number) <= 90
  );
}

/** Validate input only. Never repair, smooth, snap or change original geometry. */
export function isWorkspaceGeometry(
  value: unknown,
  depth = 0,
): value is Geometry {
  if (!value || typeof value !== 'object' || depth > 16) return false;
  const geometry = value as Record<string, unknown>;
  const list = (
    value: unknown,
    min: number,
    valid: (item: unknown) => boolean,
  ) => Array.isArray(value) && value.length >= min && value.every(valid);
  const line = (value: unknown) => list(value, 2, coordinate);
  const ring = (value: unknown) => {
    if (!list(value, 4, coordinate)) return false;
    const points = value as Position[];
    const first = points[0],
      last = points[points.length - 1];
    return first[0] === last[0] && first[1] === last[1];
  };
  const polygon = (value: unknown) => list(value, 1, ring);
  switch (geometry['type']) {
    case 'Point':
      return coordinate(geometry['coordinates']);
    case 'MultiPoint':
      return list(geometry['coordinates'], 1, coordinate);
    case 'LineString':
      return line(geometry['coordinates']);
    case 'MultiLineString':
      return list(geometry['coordinates'], 1, line);
    case 'Polygon':
      return polygon(geometry['coordinates']);
    case 'MultiPolygon':
      return list(geometry['coordinates'], 1, polygon);
    case 'GeometryCollection':
      return list(geometry['geometries'], 1, (item) =>
        isWorkspaceGeometry(item, depth + 1),
      );
    default:
      return false;
  }
}

export function parseWorkspaceBounds(value: string): WorkspaceBounds | null {
  const parts = value.split(',').map((part) => part.trim());
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^-?\d+(?:\.\d+)?$/.test(part))
  )
    return null;
  const bounds = parts.map(Number);
  return validWorkspaceBounds(bounds) ? bounds : null;
}

function validWorkspaceBounds(
  value: readonly number[],
): value is WorkspaceBounds {
  return (
    value.length === 4 &&
    value.every(Number.isFinite) &&
    value[0] >= -180 &&
    value[2] <= 180 &&
    value[1] >= -90 &&
    value[3] <= 90 &&
    value[0] < value[2] &&
    value[1] < value[3]
  );
}

function pointInBounds(
  [x, y]: Position,
  [west, south, east, north]: WorkspaceBounds,
) {
  return x >= west && x <= east && y >= south && y <= north;
}

function segmentInBounds(a: Position, b: Position, bounds: WorkspaceBounds) {
  // Liang–Barsky clipping includes crossing segments and boundary contact.
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [
    a[0] - bounds[0],
    bounds[2] - a[0],
    a[1] - bounds[1],
    bounds[3] - a[1],
  ];
  let enter = 0,
    leave = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const ratio = q[i] / p[i];
      if (p[i] < 0) enter = Math.max(enter, ratio);
      else leave = Math.min(leave, ratio);
      if (enter > leave) return false;
    }
  }
  return true;
}

function pointInRing([x, y]: Position, ring: Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** GeoJSON uses linear interpolation in its coordinate frame; scope is local WGS84. */
export function geometryIntersectsWorkspaceBounds(
  geometry: Geometry,
  bounds: WorkspaceBounds,
): boolean {
  if (!validWorkspaceBounds(bounds) || !isWorkspaceGeometry(geometry))
    return false;
  const line = (points: Position[]) =>
    points.some((point) => pointInBounds(point, bounds)) ||
    points.some(
      (point, i) => i > 0 && segmentInBounds(points[i - 1], point, bounds),
    );
  const polygon = (rings: Position[][]) => {
    if (rings.some(line)) return true;
    const [west, south, east, north] = bounds;
    return [
      [west, south],
      [west, north],
      [east, north],
      [east, south],
    ].some(
      (point) =>
        pointInRing(point, rings[0]) &&
        !rings.slice(1).some((ring) => pointInRing(point, ring)),
    );
  };
  switch (geometry.type) {
    case 'Point':
      return pointInBounds(geometry.coordinates, bounds);
    case 'MultiPoint':
      return geometry.coordinates.some((point) => pointInBounds(point, bounds));
    case 'LineString':
      return line(geometry.coordinates);
    case 'MultiLineString':
      return geometry.coordinates.some(line);
    case 'Polygon':
      return polygon(geometry.coordinates);
    case 'MultiPolygon':
      return geometry.coordinates.some(polygon);
    case 'GeometryCollection':
      return geometry.geometries.some((part) =>
        geometryIntersectsWorkspaceBounds(part, bounds),
      );
  }
}

/** A connector attaches to an existing vertex; it is never a derived sampling point. */
export function workspaceGeometryAnchor(
  geometry: Geometry,
): [number, number] | null {
  if (!isWorkspaceGeometry(geometry)) return null;
  let point: Position;
  switch (geometry.type) {
    case 'GeometryCollection':
      return workspaceGeometryAnchor(geometry.geometries[0]);
    case 'Point':
      point = geometry.coordinates;
      break;
    case 'MultiPoint':
    case 'LineString':
      point = geometry.coordinates[0];
      break;
    case 'MultiLineString':
    case 'Polygon':
      point = geometry.coordinates[0][0];
      break;
    case 'MultiPolygon':
      point = geometry.coordinates[0][0][0];
      break;
  }
  return [point[0], point[1]];
}

/** Project an actual Mercator xyz with MapLibre's public, column-major map matrix. */
export function projectWorkspaceCoordinate(
  matrix: ArrayLike<number>,
  point: readonly [number, number, number],
  width: number,
  height: number,
) {
  if (
    matrix.length !== 16 ||
    ![width, height, ...point].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const result = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++)
    result[row] =
      matrix[row] * point[0] +
      matrix[4 + row] * point[1] +
      matrix[8 + row] * point[2] +
      matrix[12 + row];
  const [x, y, z, w] = result;
  if (!result.every(Number.isFinite) || w <= 0 || Math.abs(z / w) > 1)
    return null;
  return { x: ((1 + x / w) * width) / 2, y: ((1 - y / w) * height) / 2 };
}

export const workspaceRegionIds: readonly RegionId[] = [
  'bth',
  'yongding',
  'chaobai',
  'beiyun',
  'daqing-baiyangdian',
  'bohai',
];
export const workspaceRecordKinds: readonly WorkspaceRecord['kind'][] = [
  'observation',
  'event',
  'policy',
  'research',
  'spatial',
  'raster',
];
export type WorkspaceCamera = {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
};
export type WorkspaceSelection = {
  recordId: string;
  positionId: string | null;
} | null;
export interface WorkspaceInvalidation {
  sourceId: string;
  versionId?: string;
  state: 'stale' | 'revoked' | 'missing';
  reason?: string;
  affectedRecordIds?: readonly string[];
}
export interface WorkspaceSourcePin {
  sourceId: string;
  versionId: string;
  sha256: string;
  processingVersion: string;
}
export interface WorkspaceComparisonScope {
  regionId: RegionId;
  start: string | null;
  end: string | null;
}
export interface WorkspaceRasterSettings {
  enabled: boolean;
  band: WorkspaceRasterReport['products'][number]['band'];
  opacity: number;
}
export const defaultWorkspaceRaster: WorkspaceRasterSettings = {
  enabled: true,
  band: 'TCI',
  opacity: 0.8,
};
export interface SpatialWorkspaceView {
  schemaVersion: 1;
  kind: 'spatial-workspace-view';
  regionId: RegionId;
  start: string | null;
  end: string | null;
  timeRole: WorkspaceRecord['time']['role'] | 'all';
  includeUndated: boolean;
  kinds: WorkspaceRecord['kind'][];
  search: string;
  bounds: WorkspaceBounds | null;
  camera: WorkspaceCamera;
  mode: '2d' | '3d';
  raster?: WorkspaceRasterSettings;
  selection: WorkspaceSelection;
  expandedSources: string[];
  sourcePins: WorkspaceSourcePin[] | null;
  excludedRecordIds: string[];
  topicId: string | null;
  comparison: {
    enabled: boolean;
    mode: 'region' | 'time';
    left: WorkspaceComparisonScope;
    right: WorkspaceComparisonScope;
  };
}
export interface WorkspaceMapProperties {
  sourceId: string;
  versionId: string;
  recordId: string;
  positionId: string;
  kind: WorkspaceRecord['kind'];
  role: WorkspacePosition['role'];
  label: string;
}
export type WorkspaceMapFeatures = FeatureCollection<
  Geometry,
  WorkspaceMapProperties
>;

export function workspaceRegionCamera(
  pack: WorkspacePack,
  regionId: RegionId,
): WorkspaceCamera {
  const bounds = pack.regions.find((region) => region.id === regionId)
    ?.bounds ?? [113, 36, 120, 43];
  return {
    longitude: (bounds[0] + bounds[2]) / 2,
    latitude: (bounds[1] + bounds[3]) / 2,
    zoom: Math.max(
      4,
      Math.min(
        10,
        7 - Math.log2(Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1])),
      ),
    ),
    bearing: 0,
    pitch: 0,
  };
}

export function createSpatialWorkspaceView(
  pack: WorkspacePack,
  regionId: RegionId = 'bth',
): SpatialWorkspaceView {
  return {
    schemaVersion: 1,
    kind: 'spatial-workspace-view',
    regionId,
    start: null,
    end: null,
    timeRole: 'all',
    includeUndated: true,
    kinds: [...workspaceRecordKinds],
    search: '',
    bounds: null,
    camera: workspaceRegionCamera(pack, regionId),
    mode: '2d',
    raster: { ...defaultWorkspaceRaster },
    selection: null,
    expandedSources: [],
    sourcePins: null,
    excludedRecordIds: [],
    topicId: null,
    comparison: {
      enabled: false,
      mode: 'region',
      left: { regionId, start: null, end: null },
      right: {
        regionId: regionId === 'chaobai' ? 'beiyun' : 'chaobai',
        start: null,
        end: null,
      },
    },
  };
}

export function switchSpatialWorkspaceRegion(
  view: SpatialWorkspaceView,
  pack: WorkspacePack,
  regionId: RegionId,
): SpatialWorkspaceView {
  const next = createSpatialWorkspaceView(pack, regionId);
  return {
    ...next,
    mode: view.mode,
    camera: { ...next.camera, pitch: view.mode === '3d' ? 50 : 0 },
  };
}

function sourceKey(id: string, versionId: string) {
  return JSON.stringify([id, versionId]);
}
function packSource(pack: WorkspacePack, id: string, versionId: string) {
  return pack.sources.find(
    (source) => source.id === id && source.versionId === versionId,
  );
}
function matchingInvalidation(
  invalidations: readonly WorkspaceInvalidation[],
  sourceId: string,
  versionId: string,
  recordId?: string,
) {
  return invalidations.find(
    (item) =>
      item.sourceId === sourceId &&
      (!item.versionId || item.versionId === versionId) &&
      (!item.affectedRecordIds ||
        (recordId !== undefined && item.affectedRecordIds.includes(recordId))),
  );
}
function readableSource(
  pack: WorkspacePack,
  id: string,
  versionId: string,
  invalidations: readonly WorkspaceInvalidation[],
  recordId?: string,
) {
  const source = packSource(pack, id, versionId);
  return source?.rights.displayAllowed &&
    !matchingInvalidation(invalidations, id, versionId, recordId)
    ? source
    : null;
}

function withinPins(
  source: Material | null,
  pins: readonly WorkspaceSourcePin[] | null,
) {
  return (
    !!source &&
    (pins === null ||
      pins.some(
        (pin) =>
          pin.sourceId === source.id &&
          pin.versionId === source.versionId &&
          pin.sha256 === source.originalSha256 &&
          pin.processingVersion === source.processingVersion,
      ))
  );
}

/** A position is rendered only with a permitted, pinned and evidenced geometry source. */
export function workspaceDisplayPositions(
  pack: WorkspacePack,
  record: WorkspaceRecord,
  invalidations: readonly WorkspaceInvalidation[] = [],
  sourcePins: readonly WorkspaceSourcePin[] | null = null,
) {
  if (
    !withinPins(
      readableSource(
        pack,
        record.sourceId,
        record.versionId,
        invalidations,
        record.id,
      ),
      sourcePins,
    )
  )
    return [];
  return record.positions.filter(
    (position) =>
      position.match === 'bound' &&
      position.role !== 'institution-address' &&
      position.role !== 'mention' &&
      position.crs === 'EPSG:4326' &&
      isWorkspaceGeometry(position.geometry) &&
      !!position.locator?.trim() &&
      !!position.evidence.locator.trim() &&
      !!position.evidence.text.trim() &&
      !!position.geometrySourceId &&
      !!position.geometryVersionId &&
      withinPins(
        readableSource(
          pack,
          position.geometrySourceId,
          position.geometryVersionId,
          invalidations,
          record.id,
        ),
        sourcePins,
      ),
  );
}

function normalizedDate(value: string | null, end: boolean): string | null {
  if (!value) return null;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]),
    month = match[2] ? Number(match[2]) : end ? 12 : 1;
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  const day = match[3] ? Number(match[3]) : end ? days : 1;
  if (day < 1 || day > days) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function workspaceNativeTime(record: WorkspaceRecord) {
  if (record.time.precision === 'unknown') return null;
  const start = normalizedDate(record.time.start ?? record.time.end, false),
    end = normalizedDate(record.time.end ?? record.time.start, true);
  return start && end && start <= end ? { start, end } : null;
}

export function validWorkspaceTimeFilter(
  start: string | null,
  end: string | null,
) {
  const minimum = start ? normalizedDate(start, false) : null,
    maximum = end ? normalizedDate(end, true) : null;
  return (
    (!start || minimum !== null) &&
    (!end || maximum !== null) &&
    (!minimum || !maximum || minimum <= maximum)
  );
}

function timeMatches(
  record: WorkspaceRecord,
  view: Pick<
    SpatialWorkspaceView,
    'start' | 'end' | 'timeRole' | 'includeUndated'
  >,
) {
  if (!validWorkspaceTimeFilter(view.start, view.end)) return false;
  const period = workspaceNativeTime(record);
  if (!period)
    return (
      view.includeUndated &&
      (view.timeRole === 'all' ||
        view.timeRole === record.time.role ||
        record.time.role === 'unknown')
    );
  if (view.timeRole !== 'all' && view.timeRole !== record.time.role)
    return false;
  const start = normalizedDate(view.start, false),
    end = normalizedDate(view.end, true);
  return (!start || period.end >= start) && (!end || period.start <= end);
}

function workRoot(pack: WorkspacePack, sourceId: string) {
  let current = sourceId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return sourceId;
    seen.add(current);
    const source = pack.sources.find((source) => source.id === current);
    if (source?.workId) return source.workId;
    const parent = source?.duplicateOf;
    if (!parent) return current;
    current = parent;
  }
}

export function filterSpatialWorkspace(
  pack: WorkspacePack,
  view: SpatialWorkspaceView,
  invalidations: readonly WorkspaceInvalidation[] = [],
) {
  const recordIds = view.topicId
    ? new Set(
        pack.topicPackages.find((topic) => topic.id === view.topicId)
          ?.recordIds ?? [],
      )
    : null;
  const pinned =
    view.sourcePins === null
      ? null
      : new Set(
          view.sourcePins.map((pin) => sourceKey(pin.sourceId, pin.versionId)),
        );
  const search = view.search.trim().toLocaleLowerCase('en');
  const excluded = new Set(view.excludedRecordIds);
  const candidates = pack.records.filter((record) => {
    const source = readableSource(
      pack,
      record.sourceId,
      record.versionId,
      invalidations,
      record.id,
    );
    return (
      source &&
      withinPins(source, view.sourcePins) &&
      !excluded.has(record.id) &&
      (!pinned || pinned.has(sourceKey(record.sourceId, record.versionId))) &&
      (!recordIds || recordIds.has(record.id)) &&
      (view.regionId === 'bth' || record.regionIds.includes(view.regionId)) &&
      view.kinds.includes(record.kind) &&
      timeMatches(record, view) &&
      (!search ||
        `${record.objectLabel} ${source.title} ${record.metric} ${record.id}`
          .toLocaleLowerCase('en')
          .includes(search))
    );
  });
  const records: WorkspaceRecord[] = [],
    locatedRecords: WorkspaceRecord[] = [],
    unlocatedRecords: WorkspaceRecord[] = [],
    outsideRecords: WorkspaceRecord[] = [];
  const features: WorkspaceMapFeatures = {
    type: 'FeatureCollection',
    features: [],
  };
  for (const record of candidates) {
    const positions = workspaceDisplayPositions(
      pack,
      record,
      invalidations,
      view.sourcePins,
    ).filter(
      (position) =>
        !pinned ||
        pinned.has(
          sourceKey(position.geometrySourceId!, position.geometryVersionId!),
        ),
    );
    if (positions.length === 0) {
      records.push(record);
      unlocatedRecords.push(record);
      continue;
    }
    const inside = positions.filter(
      (position) =>
        !view.bounds ||
        geometryIntersectsWorkspaceBounds(position.geometry!, view.bounds),
    );
    if (inside.length === 0) {
      outsideRecords.push(record);
      continue;
    }
    records.push(record);
    locatedRecords.push(record);
    for (const position of inside)
      features.features.push({
        type: 'Feature',
        id: JSON.stringify([record.id, position.id]),
        geometry: position.geometry!,
        properties: {
          recordId: record.id,
          positionId: position.id,
          sourceId: record.sourceId,
          versionId: record.versionId,
          kind: record.kind,
          role: position.role,
          label: record.objectLabel,
        },
      });
  }
  return {
    records,
    locatedRecords,
    unlocatedRecords,
    outsideRecords,
    features,
    recordCount: records.length,
    geometryCount: features.features.length,
    sourceCount: new Set(
      records.map((record) => workRoot(pack, record.sourceId)),
    ).size,
  };
}

export function workspaceObjectDossier(
  pack: WorkspacePack,
  recordId: string,
  invalidations: readonly WorkspaceInvalidation[] = [],
  sourcePins: readonly WorkspaceSourcePin[] | null = null,
) {
  const selected = pack.records.find((record) => record.id === recordId);
  if (!selected) return null;
  const source = readableSource(
    pack,
    selected.sourceId,
    selected.versionId,
    invalidations,
    selected.id,
  );
  if (!source || !withinPins(source, sourcePins)) return null;
  const records = pack.records.filter(
    (record) =>
      record.sourceId === selected.sourceId &&
      record.objectId === selected.objectId &&
      withinPins(
        readableSource(
          pack,
          record.sourceId,
          record.versionId,
          invalidations,
          record.id,
        ),
        sourcePins,
      ),
  );
  const work = workRoot(pack, selected.sourceId);
  const copies = pack.sources.filter(
    (copy) =>
      copy.id !== source.id &&
      workRoot(pack, copy.id) === work &&
      withinPins(
        readableSource(pack, copy.id, copy.versionId, invalidations),
        sourcePins,
      ),
  );
  const versions = pack.sources.filter(
    (version) =>
      version.id === source.id &&
      records.some((record) => record.versionId === version.versionId),
  );
  return {
    selected,
    source,
    records,
    copies,
    versions,
    positions: workspaceDisplayPositions(
      pack,
      selected,
      invalidations,
      sourcePins,
    ),
  };
}

function pinFor(source: Material): WorkspaceSourcePin {
  return {
    sourceId: source.id,
    versionId: source.versionId,
    sha256: source.originalSha256,
    processingVersion: source.processingVersion,
  };
}

function sceneRecords(
  pack: WorkspacePack,
  view: SpatialWorkspaceView,
  invalidations: readonly WorkspaceInvalidation[],
) {
  const records = filterSpatialWorkspace(pack, view, invalidations).records;
  if (view.comparison.enabled)
    for (const scope of [view.comparison.left, view.comparison.right])
      records.push(
        ...filterSpatialWorkspace(
          pack,
          { ...view, ...scope, bounds: null, topicId: null },
          invalidations,
        ).records,
      );
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

/** Notices identify affected reading scopes without restoring withdrawn content. */
export function workspaceScopeInvalidations(
  pack: WorkspacePack,
  view: SpatialWorkspaceView,
  invalidations: readonly WorkspaceInvalidation[],
) {
  const topicRecords = view.topicId
    ? pack.topicPackages.find((topic) => topic.id === view.topicId)?.recordIds
    : null;
  return invalidations.filter(
    (invalid) =>
      pack.records.some(
        (record) =>
          record.sourceId === invalid.sourceId &&
          (!invalid.versionId || record.versionId === invalid.versionId) &&
          (!invalid.affectedRecordIds ||
            invalid.affectedRecordIds.includes(record.id)) &&
          (view.regionId === 'bth' ||
            record.regionIds.includes(view.regionId)) &&
          view.kinds.includes(record.kind) &&
          timeMatches(record, view) &&
          (!topicRecords || topicRecords.includes(record.id)),
      ) ||
      (invalid.state === 'missing' &&
        view.sourcePins?.some(
          (pin) =>
            pin.sourceId === invalid.sourceId &&
            (!invalid.versionId || pin.versionId === invalid.versionId),
        )),
  );
}

/** Imagery remains bound to an exact, filtered and evidenced footprint record. */
export function workspaceRasterOverlays(
  pack: WorkspacePack,
  view: SpatialWorkspaceView,
  invalidations: readonly WorkspaceInvalidation[] = [],
) {
  const filtered = filterSpatialWorkspace(pack, view, invalidations);
  return pack.rasterReports.filter(
    (report) =>
      report.rights.displayAllowed &&
      report.wgs84Bounds &&
      validWorkspaceBounds([...report.wgs84Bounds]) &&
      filtered.records.some(
        (record) =>
          record.kind === 'raster' &&
          record.sourceId === report.sourceId &&
          record.versionId === report.versionId &&
          workspaceDisplayPositions(pack, record, invalidations).some(
            (position) =>
              position.geometrySourceId === report.sourceId &&
              position.geometryVersionId === report.versionId &&
              (!view.bounds ||
                geometryIntersectsWorkspaceBounds(
                  position.geometry!,
                  view.bounds,
                )),
          ),
      ),
  );
}

export function captureSpatialWorkspaceView(
  pack: WorkspacePack,
  view: SpatialWorkspaceView,
  invalidations: readonly WorkspaceInvalidation[] = [],
): SpatialWorkspaceView {
  const records = sceneRecords(pack, view, invalidations);
  const needed = new Set(
    records.map((record) => sourceKey(record.sourceId, record.versionId)),
  );
  for (const record of records)
    for (const position of workspaceDisplayPositions(
      pack,
      record,
      invalidations,
      view.sourcePins,
    ))
      needed.add(
        sourceKey(position.geometrySourceId!, position.geometryVersionId!),
      );
  const sourcePins = pack.sources
    .filter((source) => needed.has(sourceKey(source.id, source.versionId)))
    .map(pinFor);
  const selection = sanitizeWorkspaceSelection(
    pack,
    view.selection,
    records,
    invalidations,
    sourcePins,
  );
  return {
    ...structuredClone(view),
    selection,
    sourcePins,
    expandedSources: view.expandedSources.filter((id) =>
      sourcePins.some((pin) => pin.sourceId === id),
    ),
  };
}

export function sanitizeWorkspaceSelection(
  pack: WorkspacePack,
  selection: WorkspaceSelection,
  records: readonly WorkspaceRecord[],
  invalidations: readonly WorkspaceInvalidation[] = [],
  sourcePins: readonly WorkspaceSourcePin[] | null = null,
): WorkspaceSelection {
  if (!selection) return null;
  const record = records.find((record) => record.id === selection.recordId);
  if (
    !record ||
    !readableSource(
      pack,
      record.sourceId,
      record.versionId,
      invalidations,
      record.id,
    )
  )
    return null;
  return {
    recordId: record.id,
    positionId:
      selection.positionId &&
      workspaceDisplayPositions(pack, record, invalidations, sourcePins).some(
        (position) => position.id === selection.positionId,
      )
        ? selection.positionId
        : null,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
function isCamera(value: unknown): value is WorkspaceCamera {
  if (!object(value)) return false;
  const keys = ['longitude', 'latitude', 'zoom', 'bearing', 'pitch'];
  return (
    keys.every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    ) &&
    Math.abs(value['longitude'] as number) <= 180 &&
    Math.abs(value['latitude'] as number) <= 85 &&
    (value['zoom'] as number) >= 0 &&
    (value['zoom'] as number) <= 20 &&
    Math.abs(value['bearing'] as number) <= 180 &&
    (value['pitch'] as number) >= 0 &&
    (value['pitch'] as number) <= 75
  );
}
function isScope(value: unknown): value is WorkspaceComparisonScope {
  return (
    object(value) &&
    workspaceRegionIds.includes(value['regionId'] as RegionId) &&
    (value['start'] === null || typeof value['start'] === 'string') &&
    (value['end'] === null || typeof value['end'] === 'string') &&
    validWorkspaceTimeFilter(value['start'], value['end'])
  );
}
function isView(value: unknown): value is SpatialWorkspaceView {
  if (
    !object(value) ||
    value['schemaVersion'] !== 1 ||
    value['kind'] !== 'spatial-workspace-view' ||
    !workspaceRegionIds.includes(value['regionId'] as RegionId) ||
    !isCamera(value['camera'])
  )
    return false;
  if (value['mode'] !== '2d' && value['mode'] !== '3d') return false;
  const raster = value['raster'];
  if (
    raster !== undefined &&
    (!object(raster) ||
      typeof raster['enabled'] !== 'boolean' ||
      !['B03', 'B8A', 'SCL', 'TCI'].includes(String(raster['band'])) ||
      typeof raster['opacity'] !== 'number' ||
      !Number.isFinite(raster['opacity']) ||
      raster['opacity'] < 0 ||
      raster['opacity'] > 1)
  )
    return false;
  if (
    (value['start'] !== null && typeof value['start'] !== 'string') ||
    (value['end'] !== null && typeof value['end'] !== 'string')
  )
    return false;
  if (
    !validWorkspaceTimeFilter(value['start'], value['end']) ||
    ![
      'all',
      'observation',
      'publication',
      'event',
      'acquisition',
      'unknown',
    ].includes(String(value['timeRole'])) ||
    typeof value['includeUndated'] !== 'boolean'
  )
    return false;
  if (
    !strings(value['kinds']) ||
    !value['kinds'].every((kind) =>
      workspaceRecordKinds.includes(kind as WorkspaceRecord['kind']),
    ) ||
    typeof value['search'] !== 'string' ||
    !strings(value['expandedSources']) ||
    !strings(value['excludedRecordIds'])
  )
    return false;
  if (
    value['bounds'] !== null &&
    (!Array.isArray(value['bounds']) ||
      !validWorkspaceBounds(value['bounds'] as number[]))
  )
    return false;
  const selection = value['selection'];
  if (
    selection !== null &&
    (!object(selection) ||
      typeof selection['recordId'] !== 'string' ||
      (selection['positionId'] !== null &&
        typeof selection['positionId'] !== 'string'))
  )
    return false;
  const pins = value['sourcePins'];
  if (
    pins !== null &&
    (!Array.isArray(pins) ||
      !pins.every(
        (pin: unknown) =>
          object(pin) &&
          ['sourceId', 'versionId', 'sha256', 'processingVersion'].every(
            (key) => typeof pin[key] === 'string',
          ),
      ))
  )
    return false;
  if (value['topicId'] !== null && typeof value['topicId'] !== 'string')
    return false;
  const comparison = value['comparison'];
  return (
    object(comparison) &&
    typeof comparison['enabled'] === 'boolean' &&
    ['region', 'time'].includes(String(comparison['mode'])) &&
    isScope(comparison['left']) &&
    isScope(comparison['right'])
  );
}

export function restoreSpatialWorkspaceView(
  pack: WorkspacePack,
  value: unknown,
  invalidations: readonly WorkspaceInvalidation[] = [],
) {
  if (!isView(value)) return null;
  const view = structuredClone(value);
  const notices: WorkspaceInvalidation[] = [];
  if (view.sourcePins)
    view.sourcePins = view.sourcePins.filter((pin) => {
      const invalid = matchingInvalidation(
        invalidations,
        pin.sourceId,
        pin.versionId,
      );
      const source = packSource(pack, pin.sourceId, pin.versionId);
      const state =
        invalid?.state ??
        (!source
          ? pack.sources.some((source) => source.id === pin.sourceId)
            ? 'stale'
            : 'missing'
          : !source.rights.displayAllowed
            ? 'revoked'
            : source.originalSha256 !== pin.sha256 ||
                source.processingVersion !== pin.processingVersion
              ? 'stale'
              : null);
      if (state) {
        notices.push({
          sourceId: pin.sourceId,
          versionId: pin.versionId,
          state,
        });
        return false;
      }
      return true;
    });
  for (const invalid of invalidations) {
    if (invalid.affectedRecordIds)
      view.excludedRecordIds = [
        ...new Set([...view.excludedRecordIds, ...invalid.affectedRecordIds]),
      ];
    if (
      !notices.some(
        (notice) =>
          notice.sourceId === invalid.sourceId &&
          notice.versionId === invalid.versionId &&
          notice.state === invalid.state,
      )
    )
      notices.push({ ...invalid });
  }
  const allowed = new Set(
    view.sourcePins?.map((pin) => pin.sourceId) ??
      pack.sources
        .filter((source) => source.rights.displayAllowed)
        .map((source) => source.id),
  );
  view.expandedSources = view.expandedSources.filter((id) => allowed.has(id));
  const records = sceneRecords(pack, view, invalidations);
  view.selection = sanitizeWorkspaceSelection(
    pack,
    view.selection,
    records,
    invalidations,
    view.sourcePins,
  );
  if (view.mode === '2d') view.camera.pitch = 0;
  return { view, notices };
}

export type WorkspaceComparisonReason =
  | 'object'
  | 'position'
  | 'metric'
  | 'unit'
  | 'time'
  | 'method'
  | 'categorical'
  | 'numeric'
  | 'permission'
  | 'stale';

function comparisonSamplingPosition(
  record: WorkspaceRecord,
  pack: WorkspacePack,
  invalidations: readonly WorkspaceInvalidation[],
) {
  // Inspect declarations before display filtering: an unresolved second sample
  // must not disappear and leave an apparently unambiguous primary location.
  const sampling = record.positions.filter((item) => item.role === 'sampling');
  if (record.kind !== 'observation' || sampling.length !== 1) return null;
  const position = sampling[0];
  if (
    !workspaceDisplayPositions(pack, record, invalidations).includes(
      position,
    ) ||
    position.geometry?.type !== 'Point' ||
    !position.scaleNote?.trim()
  )
    return null;
  // The current contract cannot establish line/area aggregation support.
  // Compare exact fixed point support without snapping or altering originals.
  return JSON.stringify([
    position.geometrySourceId,
    position.geometryVersionId,
    position.geometry.coordinates,
    position.scaleNote,
  ]);
}

function comparisonTimeHasNativePrecision(record: WorkspaceRecord) {
  const { precision, start, end } = record.time;
  if (precision === 'unknown' || !workspaceNativeTime(record)) return false;
  const minimumLength =
    precision === 'day' ? 10 : precision === 'month' ? 7 : 4;
  return [start, end].every(
    (value) => value === null || value.length >= minimumLength,
  );
}

export function compareWorkspaceRecords(
  left: WorkspaceRecord,
  right: WorkspaceRecord,
  pack: WorkspacePack,
  invalidations: readonly WorkspaceInvalidation[] = [],
) {
  const reasons: WorkspaceComparisonReason[] = [];
  if (
    !left.objectId ||
    !right.objectId ||
    left.sourceId !== right.sourceId ||
    left.objectId !== right.objectId
  )
    reasons.push('object');
  const leftSampling = comparisonSamplingPosition(left, pack, invalidations),
    rightSampling = comparisonSamplingPosition(right, pack, invalidations);
  if (!leftSampling || leftSampling !== rightSampling) reasons.push('position');
  if (!left.metric.trim() || left.metric !== right.metric)
    reasons.push('metric');
  if (
    !left.unit?.trim() ||
    !right.unit?.trim() ||
    left.unit !== right.unit ||
    /^(unknown|未知)$/i.test(left.unit.trim())
  )
    reasons.push('unit');
  if (
    left.time.role === 'unknown' ||
    left.time.role !== right.time.role ||
    left.time.precision === 'unknown' ||
    left.time.precision !== right.time.precision ||
    !comparisonTimeHasNativePrecision(left) ||
    !comparisonTimeHasNativePrecision(right)
  )
    reasons.push('time');
  if (
    !left.method?.code.trim() ||
    left.method.code !== right.method?.code ||
    !left.method.evidence.locator.trim() ||
    !left.method.evidence.text.trim() ||
    !right.method.evidence.locator.trim() ||
    !right.method.evidence.text.trim()
  )
    reasons.push('method');
  if (
    /category|class|\bgrade\b|类别|分类|等级/i.test(
      `${left.metric} ${right.metric} ${left.unit ?? ''} ${right.unit ?? ''}`,
    )
  )
    reasons.push('categorical');
  const number = (value: string | null) =>
    value &&
    /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) &&
    Number.isFinite(Number(value))
      ? Number(value)
      : null;
  const a = number(left.value),
    b = number(right.value);
  const difference = a === null || b === null ? null : b - a;
  if (difference === null || !Number.isFinite(difference))
    reasons.push('numeric');
  for (const record of [left, right]) {
    const invalid = matchingInvalidation(
      invalidations,
      record.sourceId,
      record.versionId,
      record.id,
    );
    if (invalid?.state === 'stale') {
      if (!reasons.includes('stale')) reasons.push('stale');
    } else if (
      !readableSource(
        pack,
        record.sourceId,
        record.versionId,
        invalidations,
        record.id,
      ) &&
      !reasons.includes('permission')
    )
      reasons.push('permission');
  }
  return {
    state: reasons.length ? ('side-by-side' as const) : ('comparable' as const),
    reasons,
    difference: reasons.length ? null : difference,
  };
}

export function workspaceEvidenceUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value),
      host = url.hostname.toLowerCase();
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.lan') ||
      host.startsWith('[') ||
      /^(?:127|10|0|169\.254)\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    )
      return null;
    for (const key of url.searchParams.keys())
      if (/token|authorization|password|secret|api.?key/i.test(key))
        return null;
    return url.href;
  } catch {
    return null;
  }
}

/** A permitted index contains no source file paths and never adds distribution rights. */
export function exportWorkspaceTopic(
  pack: WorkspacePack,
  topicId: string,
  invalidations: readonly WorkspaceInvalidation[] = [],
) {
  const topic = pack.topicPackages.find((topic) => topic.id === topicId);
  if (!topic) return null;
  const allowedSources = pack.sources.filter(
    (source) =>
      source.rights.redistributionAllowed &&
      readableSource(pack, source.id, source.versionId, invalidations),
  );
  const allowed = new Set(
    allowedSources.map((source) => sourceKey(source.id, source.versionId)),
  );
  const records = pack.records
    .filter(
      (record) =>
        topic.recordIds.includes(record.id) &&
        allowed.has(sourceKey(record.sourceId, record.versionId)) &&
        !matchingInvalidation(
          invalidations,
          record.sourceId,
          record.versionId,
          record.id,
        ),
    )
    .map((record) => ({
      ...record,
      evidence: record.evidence.map((evidence) => ({
        ...evidence,
        url: workspaceEvidenceUrl(evidence.url),
      })),
      ...(record.method
        ? {
            method: {
              ...record.method,
              evidence: {
                ...record.method.evidence,
                url: workspaceEvidenceUrl(record.method.evidence.url),
              },
            },
          }
        : {}),
      positions: record.positions.map((position) =>
        position.geometrySourceId &&
        position.geometryVersionId &&
        !allowed.has(
          sourceKey(position.geometrySourceId, position.geometryVersionId),
        )
          ? {
              ...position,
              geometry: null,
              geometrySourceId: null,
              geometryVersionId: null,
              locator: null,
            }
          : position,
      ),
    }));
  const sourceIds = new Set(
    records.flatMap((record) => [
      record.sourceId,
      ...record.positions.flatMap((position) =>
        position.geometrySourceId ? [position.geometrySourceId] : [],
      ),
    ]),
  );
  const sources = allowedSources
    .filter((source) => sourceIds.has(source.id))
    .map((source) => ({
      id: source.id,
      versionId: source.versionId,
      title: source.title,
      provider: source.provider,
      originalSha256: source.originalSha256,
      processingVersion: source.processingVersion,
      evidenceUrl: workspaceEvidenceUrl(source.evidenceUrl),
      rights: source.rights,
      duplicateOf: source.duplicateOf,
    }));
  return {
    schemaVersion: 1 as const,
    topic: {
      ...topic,
      recordIds: records.map((record) => record.id),
      sourceIds: [...new Set(records.map((record) => record.sourceId))],
    },
    processingVersion: pack.processingVersion,
    sources,
    records,
  };
}

export function workspaceGeometryBounds(
  geometry: Geometry,
): WorkspaceBounds | null {
  if (!isWorkspaceGeometry(geometry)) return null;
  let bounds: [number, number, number, number] | null = null;
  const point = ([x, y]: Position) => {
    bounds = bounds
      ? [
          Math.min(bounds[0], x),
          Math.min(bounds[1], y),
          Math.max(bounds[2], x),
          Math.max(bounds[3], y),
        ]
      : [x, y, x, y];
  };
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (coordinate(value)) point(value);
    else value.forEach(visit);
  };
  const part = (value: Geometry) => {
    if (value.type === 'GeometryCollection') value.geometries.forEach(part);
    else visit(value.coordinates);
  };
  part(geometry);
  return bounds;
}
