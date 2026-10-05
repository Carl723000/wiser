import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { WorkspaceMapFeatures } from './spatial-workspace-view';

/** Fixed, locally acquired public works. These hashes pin bytes, not business identity. */
export const fixedPublicReferenceHashes = {
  regional: '955998aa4f119709801e288aa765c9333c9f0a8c108c00c30fa9a1bbc986b7b9',
  reaches: '1843e403c2f4ccf2f7cff8c64cd339dd3729133f99592ce6b62b3e3650525269',
  regionalAdministrativeOriginal:
    '2d867a13d284c0423c252020362d9abc46e765a786e3b54a6a53c526bf2fa592',
  regionalWatercourseOriginal:
    '8c482bae58f4ef8192a4b9a4b6ebc9fdf6af5d937bde8d2b205ce880728673d1',
} as const;

export const publicReferenceKinds = [
  'administrative',
  'watercourse',
  'reference-reach',
  'reference-anchor',
] as const;
export type PublicReferenceKind = (typeof publicReferenceKinds)[number];
export type PublicReferenceVisibility = Record<
  Exclude<PublicReferenceKind, 'reference-anchor'>,
  boolean
> & { 'reference-anchor'?: boolean };
export interface PublicReferenceProperties {
  kind: PublicReferenceKind;
  label: string;
  fixedSourceId: string;
  sourceFileSha256: string;
  originalSha256: string[];
  attribution: string;
  licenseUrl: string;
  sourceUrl: string;
  limitation: string;
  /** Always a public geographic reference, never an observation boundary. */
  scope: 'public-geographic-reference';
  crs: 'EPSG:4326';
  referenceFileId?: string;
}
export type PublicReferences = FeatureCollection<
  Geometry,
  PublicReferenceProperties
> & { manifest?: PublicReferenceManifestSummary };
export const publicReferenceFormats = [
  'osm-regional-v1',
  'osm-reference-reaches-v1',
  'osm-reference-reach-v1',
  'osm-native-waterways-v1',
  'osm-native-anchors-v1',
] as const;
export interface PublicReferenceFile {
  id: string;
  path: string;
  format: (typeof publicReferenceFormats)[number];
  sha256: string;
  featureCount: number;
  originalSha256: string[];
  license: {
    id: 'ODbL-1.0';
    url: string;
    attribution: string;
    state: 'verified';
  };
  scope: 'public-geographic-reference';
  limitation: { 'zh-CN': string; en: string };
}
export interface PublicReferenceManifest {
  schemaVersion: 1;
  version: string;
  files: PublicReferenceFile[];
}
export interface PublicReferenceManifestSummary {
  version: string;
  files: Omit<PublicReferenceFile, 'path'>[];
}
const attribution = '© OpenStreetMap contributors · ODbL 1.0';
const licenseUrl = 'https://www.openstreetmap.org/copyright';
const sha256 = /^[a-f0-9]{64}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid public reference');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid public reference text');
  return value;
}
function original(value: unknown): string {
  const hash = text(value, 64);
  if (!sha256.test(hash)) throw new Error('Invalid original hash');
  return hash;
}
function geometry(value: unknown, allowed: readonly string[]): Geometry {
  const candidate = object(value);
  if (!allowed.includes(String(candidate.type)))
    throw new Error('Invalid public reference geometry type');
  let positions = 0;
  const check = (coordinate: unknown): void => {
    if (!Array.isArray(coordinate))
      throw new Error('Invalid public reference coordinates');
    if (
      coordinate.length >= 2 &&
      typeof coordinate[0] === 'number' &&
      typeof coordinate[1] === 'number'
    ) {
      if (
        coordinate.length !== 2 ||
        !Number.isFinite(coordinate[0]) ||
        !Number.isFinite(coordinate[1]) ||
        Math.abs(coordinate[0]) > 180 ||
        Math.abs(coordinate[1]) > 90 ||
        ++positions > 50000
      )
        throw new Error('Invalid public reference coordinate');
      return;
    }
    if (!coordinate.length) throw new Error('Empty public reference geometry');
    for (const part of coordinate) check(part);
  };
  check(candidate.coordinates);
  return {
    type: candidate.type,
    coordinates: candidate.coordinates,
  } as Geometry;
}
function collection(value: unknown, count: number): Record<string, unknown>[] {
  const parsed = object(value);
  if (
    parsed.type !== 'FeatureCollection' ||
    !Array.isArray(parsed.features) ||
    parsed.features.length !== count
  )
    throw new Error('Invalid fixed public reference collection');
  return parsed.features.map(object);
}
function common(
  kind: PublicReferenceKind,
  label: string,
  fixedSourceId: string,
  sourceFileSha256: string,
  originalSha256: string[],
  sourceUrl: string,
  limitation: string,
): PublicReferenceProperties {
  if (
    !/^https:\/\/www\.openstreetmap\.org\/(?:way|relation|node)\/\d+$/.test(
      sourceUrl,
    )
  )
    throw new Error('Invalid public reference source URL');
  return {
    kind,
    label,
    fixedSourceId,
    sourceFileSha256,
    originalSha256,
    attribution,
    licenseUrl,
    sourceUrl,
    limitation,
    scope: 'public-geographic-reference',
    crs: 'EPSG:4326',
  };
}

/** Parse only the two hash-pinned OSM derivatives, emitting a path-free map input. */
export function parseFixedPublicReferences(
  regional: unknown,
  reaches: unknown,
  pins = {
    regionalCount: 5,
    reachCount: 5,
    regionalHash: String(fixedPublicReferenceHashes.regional),
    reachHash: String(fixedPublicReferenceHashes.reaches),
  },
): PublicReferences {
  const features: Feature<Geometry, PublicReferenceProperties>[] = [];
  if (regional !== null) {
    const rows = collection(regional, pins.regionalCount);
    for (const row of rows) {
      if (row.type !== 'Feature') throw new Error('Invalid reference feature');
      const props = object(row.properties);
      if (
        props.source_attribution !== attribution ||
        props.license_url !== licenseUrl
      )
        throw new Error('Public reference rights changed');
      const kind: PublicReferenceKind =
        props.geometry_role === 'ADMINISTRATIVE_REFERENCE_AREA'
          ? 'administrative'
          : props.geometry_role === 'RIVER_REFERENCE_ROUTE'
            ? 'watercourse'
            : (() => {
                throw new Error('Unknown public reference role');
              })();
      const shape = geometry(
        row.geometry,
        kind === 'administrative'
          ? ['Polygon', 'MultiPolygon']
          : ['LineString', 'MultiLineString'],
      );
      const sourceUrl = text(props.source_url, 100);
      features.push({
        type: 'Feature',
        id: `regional:${sourceUrl}`,
        geometry: shape,
        properties: common(
          kind,
          text(props.name),
          kind === 'administrative'
            ? 'osm-admin-reference-20260919'
            : 'osm-river-reference-20260919',
          pins.regionalHash,
          [
            kind === 'administrative'
              ? fixedPublicReferenceHashes.regionalAdministrativeOriginal
              : fixedPublicReferenceHashes.regionalWatercourseOriginal,
          ],
          sourceUrl,
          text(props.limitation, 500),
        ),
      });
    }
  }
  if (reaches !== null) {
    const rows = collection(reaches, pins.reachCount);
    for (const row of rows) {
      if (row.type !== 'Feature') throw new Error('Invalid reference feature');
      const props = object(row.properties);
      if (
        props.nativeCrs !== 'EPSG:4326' ||
        props.sourceCanonicalWorkId !== 'openstreetmap' ||
        props.attribution !== attribution ||
        props.licenseUrl !== licenseUrl ||
        props.identityRelationship !==
          'geographical-reference-only; not same-as or observation-boundary' ||
        props.monthlyObservationIdentityConfirmed !== false ||
        props.professionalReview !== 'pending'
      )
        throw new Error('Reference reach authority or rights changed');
      const originals = props.sourceOriginals;
      if (
        !Array.isArray(originals) ||
        !originals.length ||
        originals.length > 16
      )
        throw new Error('Missing reference reach originals');
      const originalSha256 = [
        ...new Set(
          originals.map((entry: unknown) =>
            original(object(entry).originalSha256),
          ),
        ),
      ].sort();
      const nativeWays = props.nativeWayIds;
      if (!Array.isArray(nativeWays) || !nativeWays.length)
        throw new Error('Missing native OSM ways');
      const firstWay: unknown = nativeWays[0];
      if (
        typeof firstWay !== 'number' ||
        !Number.isSafeInteger(firstWay) ||
        firstWay <= 0
      )
        throw new Error('Invalid native OSM way');
      const sourceUrl = `https://www.openstreetmap.org/way/${firstWay}`;
      const id = text(props.id, 100);
      features.push({
        type: 'Feature',
        id: `reference-reach:${id}`,
        geometry: geometry(row.geometry, ['LineString', 'MultiLineString']),
        properties: common(
          'reference-reach',
          text(props.label),
          'openstreetmap',
          pins.reachHash,
          originalSha256,
          sourceUrl,
          '地理参考河线；不是月报观测边界，位置及历史范围待专业核验。',
        ),
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** A manifest is an operator-pinned local input, never a source or position grant. */
export function parsePublicReferenceManifest(
  value: unknown,
): PublicReferenceManifest {
  const parsed = object(value);
  if (
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.files) ||
    parsed.files.length < 1 ||
    parsed.files.length > 32
  )
    throw new Error('Invalid public reference manifest');
  const version = text(parsed.version, 100);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const files = parsed.files.map((value): PublicReferenceFile => {
    const file = object(value);
    const id = text(file.id, 100);
    const path = text(file.path, 2000);
    const format = file.format;
    const rights = object(file.license);
    const limitation = object(file.limitation);
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(id) ||
      ids.has(id) ||
      paths.has(path) ||
      !publicReferenceFormats.includes(
        format as PublicReferenceFile['format'],
      ) ||
      !Number.isSafeInteger(file.featureCount) ||
      Number(file.featureCount) < 1 ||
      Number(file.featureCount) > 25000 ||
      rights.id !== 'ODbL-1.0' ||
      rights.state !== 'verified' ||
      rights.url !== licenseUrl ||
      rights.attribution !== attribution ||
      file.scope !== 'public-geographic-reference' ||
      !Array.isArray(file.originalSha256) ||
      !file.originalSha256.length ||
      file.originalSha256.length > 16
    )
      throw new Error('Invalid public reference file declaration');
    ids.add(id);
    paths.add(path);
    const originals = file.originalSha256.map(original);
    if (new Set(originals).size !== originals.length)
      throw new Error('Duplicate public reference original');
    return {
      id,
      path,
      format: format as PublicReferenceFile['format'],
      sha256: original(file.sha256),
      featureCount: Number(file.featureCount),
      originalSha256: originals,
      license: {
        id: 'ODbL-1.0',
        state: 'verified',
        attribution,
        url: licenseUrl,
      },
      scope: 'public-geographic-reference',
      limitation: {
        'zh-CN': text(limitation['zh-CN'], 1000),
        en: text(limitation.en, 1000),
      },
    };
  });
  if (files.reduce((count, file) => count + file.featureCount, 0) > 25000)
    throw new Error('Public reference group feature budget exceeded');
  return { schemaVersion: 1, version, files };
}

function nativeId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid native OSM identity');
  return value;
}
function declaredOriginals(
  value: unknown,
  file: PublicReferenceFile,
): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 16)
    throw new Error('Missing public reference originals');
  const originals = [...new Set(value.map(original))].sort();
  if (originals.some((hash) => !file.originalSha256.includes(hash)))
    throw new Error('Undeclared public reference original');
  return originals;
}

/** File bytes must be verified by the host before this deterministic projection. */
export function parsePublicReferenceFile(
  value: unknown,
  file: PublicReferenceFile,
): PublicReferences {
  const pins = {
    regionalCount: file.featureCount,
    reachCount: file.featureCount,
    regionalHash: file.sha256,
    reachHash: file.sha256,
  };
  let parsed: PublicReferences;
  if (
    file.format === 'osm-regional-v1' ||
    file.format === 'osm-reference-reaches-v1'
  ) {
    parsed = parseFixedPublicReferences(
      file.format === 'osm-regional-v1' ? value : null,
      file.format === 'osm-reference-reaches-v1' ? value : null,
      pins,
    );
  } else {
    parsed = {
      type: 'FeatureCollection',
      features: collection(value, file.featureCount).map((row) => {
        if (row.type !== 'Feature')
          throw new Error('Invalid reference feature');
        const props = object(row.properties);
        if (props.nativeCrs !== 'EPSG:4326')
          throw new Error('Invalid public reference CRS');
        let id: string,
          label: string,
          sourceUrl: string,
          originals: string[],
          kind: PublicReferenceKind;
        if (file.format === 'osm-reference-reach-v1') {
          if (
            props.coordinateRole !== 'geographical-reference-line' ||
            props.professionalReview !== 'pending' ||
            props.monthlyBoundaryConfirmed !== false ||
            props.attribution !== '© OpenStreetMap contributors' ||
            props.license !== 'ODbL-1.0' ||
            props.fullOriginalRedistributionPermissionGranted !== false ||
            !Array.isArray(props.sourceWayIds) ||
            !props.sourceWayIds.length
          )
            throw new Error('Reference reach authority or rights changed');
          id = `reference-reach:${text(props.referenceRangeId, 100)}`;
          label = text(props.label);
          sourceUrl = `https://www.openstreetmap.org/way/${nativeId(props.sourceWayIds[0])}`;
          originals = declaredOriginals(props.sourceAssetSha256, file);
          kind = 'reference-reach';
        } else {
          if (
            props.canonicalWorkId !== 'openstreetmap' ||
            props.sourceId !== 'osm-public-database' ||
            props.reviewStatus !== 'pending' ||
            props.attribution !== attribution ||
            props.licenseUrl !== licenseUrl ||
            props.absolutePositionAccuracyMetres !== null
          )
            throw new Error('Native reference authority or rights changed');
          if (file.format === 'osm-native-waterways-v1') {
            if (
              props.positionRole !== 'open-geographical-reference' ||
              props.surveyedOrHistoricalBoundaryConfirmed !== false ||
              props.notAMonthlyObservationReach !== true
            )
              throw new Error('Native watercourse role changed');
            const way = nativeId(props.osmWayId);
            nativeId(props.osmWayVersion);
            id = `native-watercourse:${way}`;
            label = text(props.nameOriginal);
            sourceUrl = `https://www.openstreetmap.org/way/${way}`;
            originals = declaredOriginals(props.sourceOriginalSha256s, file);
            kind = 'watercourse';
          } else {
            if (
              !['confluence', 'weir-reference'].includes(
                String(props.positionRole),
              ) ||
              props.notSamplingPoint !== true ||
              props.monthlyBoundaryEquivalent !== false
            )
              throw new Error('Reference anchor role changed');
            const node = nativeId(props.osmNodeId);
            id = `reference-anchor:${node}`;
            label = text(props.label);
            sourceUrl = `https://www.openstreetmap.org/node/${node}`;
            originals = [...file.originalSha256].sort();
            kind = 'reference-anchor';
          }
        }
        return {
          type: 'Feature',
          id,
          geometry: geometry(
            row.geometry,
            kind === 'reference-anchor'
              ? ['Point']
              : ['LineString', 'MultiLineString'],
          ),
          properties: common(
            kind,
            label,
            'openstreetmap',
            file.sha256,
            originals,
            sourceUrl,
            file.limitation['zh-CN'],
          ),
        };
      }),
    };
  }
  const ids = new Set<string>();
  for (const feature of parsed.features) {
    declaredOriginals(feature.properties.originalSha256, file);
    const id = String(feature.id);
    if (ids.has(id)) throw new Error('Duplicate public reference feature');
    ids.add(id);
    feature.properties.referenceFileId = file.id;
  }
  return parsed;
}

function geometryKey(feature: Feature<Geometry, PublicReferenceProperties>) {
  return `${feature.properties.fixedSourceId}:${feature.properties.originalSha256.join('|')}:${JSON.stringify(feature.geometry)}`;
}

/** Visual deduplication only: record features and their counts remain untouched. */
export function visiblePublicReferences(
  references: PublicReferences,
  recordFeatures: WorkspaceMapFeatures,
  enabled: PublicReferenceVisibility,
): PublicReferences {
  const records = new Set(
    recordFeatures.features.map(
      (feature) =>
        `${feature.properties.sourceId}:${feature.properties.versionId}:${JSON.stringify(feature.geometry)}`,
    ),
  );
  const shown = new Set<string>();
  return {
    type: 'FeatureCollection',
    features: references.features.filter((feature) => {
      if (!enabled[feature.properties.kind]) return false;
      if (
        feature.properties.originalSha256.some((hash) =>
          records.has(
            `${feature.properties.fixedSourceId}:${hash}:${JSON.stringify(feature.geometry)}`,
          ),
        )
      )
        return false;
      const key = geometryKey(feature);
      if (shown.has(key)) return false;
      shown.add(key);
      return true;
    }),
  };
}
