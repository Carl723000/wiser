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
] as const;
export type PublicReferenceKind = (typeof publicReferenceKinds)[number];
export type PublicReferenceVisibility = Record<PublicReferenceKind, boolean>;
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
}
export type PublicReferences = FeatureCollection<
  Geometry,
  PublicReferenceProperties
>;
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
  return candidate as unknown as Geometry;
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
    !/^https:\/\/www\.openstreetmap\.org\/(?:way|relation)\/\d+$/.test(
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
): PublicReferences {
  const features: Feature<Geometry, PublicReferenceProperties>[] = [];
  if (regional !== null) {
    const rows = collection(regional, 5);
    for (const [index, row] of rows.entries()) {
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
      if (index < 4 !== (kind === 'administrative'))
        throw new Error('Public reference role order changed');
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
          fixedPublicReferenceHashes.regional,
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
    const rows = collection(reaches, 5);
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
          fixedPublicReferenceHashes.reaches,
          originalSha256,
          sourceUrl,
          '地理参考河线；不是月报观测边界，位置及历史范围待专业核验。',
        ),
      });
    }
  }
  return { type: 'FeatureCollection', features };
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
