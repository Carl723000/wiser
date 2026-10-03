import { describe, expect, it } from 'vitest';
import {
  parseFixedPublicReferences,
  visiblePublicReferences,
  type PublicReferences,
} from './spatial-public-reference';
import type { WorkspaceMapFeatures } from './spatial-workspace-view';

const attribution = '© OpenStreetMap contributors · ODbL 1.0';
const licenseUrl = 'https://www.openstreetmap.org/copyright';
const line = {
  type: 'LineString' as const,
  coordinates: [
    [116, 39],
    [117, 40],
  ],
};
const polygon = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [116, 39],
      [117, 39],
      [117, 40],
      [116, 39],
    ],
  ],
};
const regional = {
  type: 'FeatureCollection',
  features: [
    ...Array.from({ length: 4 }, (_, index) => ({
      type: 'Feature',
      geometry: polygon,
      properties: {
        name: `区${index}`,
        geometry_role: 'ADMINISTRATIVE_REFERENCE_AREA',
        osm_id: String(index + 1),
        osm_type: 'relation',
        source_attribution: attribution,
        license_url: licenseUrl,
        source_url: `https://www.openstreetmap.org/relation/${index + 1}`,
        limitation: '不是法定界线',
      },
    })),
    {
      type: 'Feature',
      geometry: line,
      properties: {
        name: '河流参考线',
        geometry_role: 'RIVER_REFERENCE_ROUTE',
        osm_id: '5',
        osm_type: 'way',
        source_attribution: attribution,
        license_url: licenseUrl,
        source_url: 'https://www.openstreetmap.org/way/5',
        limitation: '不是月报河段边界',
      },
    },
  ],
};
const reaches = {
  type: 'FeatureCollection',
  features: Array.from({ length: 5 }, (_, index) => ({
    type: 'Feature',
    geometry: line,
    properties: {
      id: `reach-${index}`,
      label: `参考河段${index}`,
      nativeCrs: 'EPSG:4326',
      sourceCanonicalWorkId: 'openstreetmap',
      attribution,
      licenseUrl,
      identityRelationship:
        'geographical-reference-only; not same-as or observation-boundary',
      monthlyObservationIdentityConfirmed: false,
      professionalReview: 'pending',
      sourceOriginals: [
        { originalPath: '/private/original.json', originalSha256: 'a'.repeat(64) },
      ],
    },
  })),
};

describe('fixed public reference input', () => {
  it('keeps three public-reference roles separate and strips original paths', () => {
    const parsed = parseFixedPublicReferences(regional, reaches);
    expect(parsed.features.map((item) => item.properties.kind)).toEqual([
      'administrative',
      'administrative',
      'administrative',
      'administrative',
      'watercourse',
      'reference-reach',
      'reference-reach',
      'reference-reach',
      'reference-reach',
      'reference-reach',
    ]);
    expect(parsed.features[5].properties.originalSha256).toEqual([
      'a'.repeat(64),
    ]);
    expect(JSON.stringify(parsed)).not.toContain('/private/original.json');
    expect(JSON.stringify(parsed)).not.toContain('originalMonthlyRecordId');
    expect(parsed.features[0].properties.sourceFileSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an altered coordinate system or rights rather than drawing it', () => {
    expect(() =>
      parseFixedPublicReferences(regional, {
        ...reaches,
        features: reaches.features.map((feature, index) =>
          index === 0
            ? {
                ...feature,
                properties: { ...feature.properties, nativeCrs: 'EPSG:3857' },
              }
            : feature,
        ),
      }),
    ).toThrow();
    expect(() =>
      parseFixedPublicReferences(
        {
          ...regional,
          features: regional.features.map((feature, index) =>
            index === 0
              ? {
                  ...feature,
                  properties: { ...feature.properties, license_url: '' },
                }
              : feature,
          ),
        },
        null,
      ),
    ).toThrow();
  });

  it('hides only the identical fixed-source geometry under a visible record', () => {
    const parsed = parseFixedPublicReferences(regional, null);
    const original = parsed.features[0];
    const recordFeatures: WorkspaceMapFeatures = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'record-1',
          geometry: original.geometry,
          properties: {
            sourceId: 'source',
            versionId: original.properties.originalSha256[0],
            recordId: 'record-1',
            positionId: 'position-1',
            kind: 'spatial',
            role: 'reference',
            label: 'record',
          },
        },
      ],
    };
    const shown = visiblePublicReferences(parsed, recordFeatures, {
      administrative: true,
      watercourse: true,
      'reference-reach': true,
    });
    expect(shown.features).toHaveLength(4);
    expect(recordFeatures.features).toHaveLength(1);
    const otherSource: WorkspaceMapFeatures = {
      ...recordFeatures,
      features: [
        {
          ...recordFeatures.features[0],
          properties: {
            ...recordFeatures.features[0].properties,
            versionId: 'different-source',
          },
        },
      ],
    };
    expect(
      visiblePublicReferences(parsed, otherSource, {
        administrative: true,
        watercourse: true,
        'reference-reach': true,
      }).features,
    ).toHaveLength(5);
  });

  it('retains independent source identities when coordinates coincide', () => {
    const first = parseFixedPublicReferences(regional, null);
    const sameGeometryDifferentSource: PublicReferences = {
      ...first,
      features: [
        first.features[0],
        {
          ...first.features[0],
          id: 'other',
          properties: {
            ...first.features[0].properties,
            originalSha256: ['b'.repeat(64)],
          },
        },
      ],
    };
    expect(
      visiblePublicReferences(
        sameGeometryDifferentSource,
        { type: 'FeatureCollection', features: [] },
        { administrative: true, watercourse: true, 'reference-reach': true },
      ).features,
    ).toHaveLength(2);
  });
});
