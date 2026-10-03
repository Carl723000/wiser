import type { Geometry } from 'geojson';
import type {
  MeasurementBinding,
  MeasurementDefinition,
  MeasurementTrack,
} from '@wiser/data-contracts';

/** Local processing interchange only; not a public query or authority model. */
export type RegionId =
  'bth' | 'yongding' | 'chaobai' | 'beiyun' | 'daqing-baiyangdian' | 'bohai';
export type WorkspaceBounds = readonly [number, number, number, number];
export interface WorkspaceEvidence {
  locator: string;
  text: string;
  url: string | null;
}
export interface Material {
  /** A missing track stays unknown; a record label cannot classify its source. */
  track?: MeasurementTrack;
  /** Shared work identity for counting versions/copies, never an object identity merge. */
  workId?: string;
  id: string;
  versionId: string;
  title: string;
  provider: string;
  kind: 'report' | 'policy' | 'research' | 'spatial' | 'raster';
  originalSha256: string;
  /** Kept in controlled local manifests, removed before crossing the server boundary. */
  originalPath?: string;
  evidenceUrl: string | null;
  rights: {
    public: boolean;
    displayAllowed: boolean;
    redistributionAllowed: boolean;
    note: string;
  };
  regionIds: RegionId[];
  needIds: string[];
  processingVersion: string;
  status: {
    original: string;
    parsed: string;
    checked: string;
    professionalReview: string;
    space: string;
    use: string;
  };
  duplicateOf: string | null;
  coverageNote?: string;
  fieldNames?: string[];
  quantity?: {
    candidateRows: number;
    sourceObjects: number;
    geometryRecords: number;
    validObservations: number | null;
  };
}
export interface WorkspacePosition {
  id: string;
  expression: string;
  role:
    | 'study-area'
    | 'sampling'
    | 'event-location'
    | 'applicable-area'
    | 'mention'
    | 'institution-address'
    | 'reference';
  match: 'bound' | 'candidate' | 'text-only' | 'ambiguous' | 'restricted';
  geometry: Geometry | null;
  crs: 'EPSG:4326' | null;
  nativeCrs?: string | null;
  geometrySourceId: string | null;
  geometryVersionId: string | null;
  locator: string | null;
  scaleNote: string | null;
  evidence: { locator: string; text: string };
}
export interface WorkspaceRecord {
  id: string;
  sourceId: string;
  versionId: string;
  objectId: string;
  objectLabel: string;
  kind: 'observation' | 'event' | 'policy' | 'research' | 'spatial' | 'raster';
  regionIds: RegionId[];
  needIds: string[];
  time: {
    start: string | null;
    end: string | null;
    precision: 'day' | 'month' | 'year' | 'unknown';
    role: 'observation' | 'publication' | 'event' | 'acquisition' | 'unknown';
  };
  metric: string;
  value: string | null;
  unit: string | null;
  method?: { code: string; evidence: WorkspaceEvidence };
  /** Explicit track and fixed source-defined comparison context; no inferred type. */
  track?: MeasurementTrack;
  measurement?: MeasurementBinding;
  positions: WorkspacePosition[];
  evidence: WorkspaceEvidence[];
  processingVersion: string;
  reviewStatus: 'pending' | 'synthetic-reviewed';
  missingReasons: string[];
}
export interface WorkspaceRegion {
  id: RegionId;
  name: string;
  aliases: string[];
  type: string;
  /** Navigation extent, not a verified basin boundary. */
  bounds: WorkspaceBounds;
}
export interface WorkspaceTopicPackage {
  id: string;
  title: string;
  regionIds: RegionId[];
  sourceIds: string[];
  recordIds: string[];
  question: string;
  gaps: string[];
}
export interface WorkspaceRasterReport {
  id: string;
  sourceId: string;
  versionId: string;
  sceneId: string;
  acquiredAt: string | null;
  regionIds: RegionId[];
  title: string;
  products: {
    band: 'B03' | 'B8A' | 'SCL' | 'TCI';
    width: number;
    height: number;
    channels: number;
    dtype: string;
    sha256: string;
    hashMatches: boolean;
    readable: boolean;
    nativeCrs: string | null;
    resolution: [number, number] | null;
    noData: (number | null)[];
    scales: number[];
    offsets: number[];
    stats: {
      min: number;
      max: number;
      validPixels: number;
      noDataPixels: number;
    };
    classFrequency: Record<string, number> | null;
    thumbnailUrl: string | null;
  }[];
  wgs84Bounds: WorkspaceBounds | null;
  footprint: Geometry | null;
  qualityLayerPresent: boolean;
  oneSceneOnly: boolean;
  controlPointVerified: false;
  rights: {
    displayAllowed: boolean;
    redistributionAllowed: boolean;
    note: string;
  };
  limitations: string[];
  pixelProbes?: {
    id: string;
    row: number;
    column: number;
    coordinates: [number, number];
    rawValues: Record<'B03' | 'B8A' | 'SCL' | 'TCI', number[]>;
    sclLabel: string;
  }[];
}
export interface WorkspacePack {
  schemaVersion: 1;
  generatedAt: string;
  processingVersion: string;
  sources: Material[];
  records: WorkspaceRecord[];
  measurementDefinitions?: MeasurementDefinition[];
  regions: WorkspaceRegion[];
  topicPackages: WorkspaceTopicPackage[];
  rasterReports: WorkspaceRasterReport[];
}
