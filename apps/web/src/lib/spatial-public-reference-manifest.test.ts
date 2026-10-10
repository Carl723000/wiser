import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadLocalSpatialWorkspace } from './spatial-workspace-local';
import { loadPublicReferences } from './spatial-public-reference.server';
vi.mock('server-only', () => ({}));
import { parsePublicReferenceManifest } from './spatial-public-reference';

const attribution = '© OpenStreetMap contributors · ODbL 1.0';
const licenseUrl = 'https://www.openstreetmap.org/copyright';
const original = 'a'.repeat(64);
const digest = (bytes: string) =>
  createHash('sha256').update(bytes).digest('hex');
const line = {
  type: 'LineString',
  coordinates: [
    [116, 39],
    [117, 40],
  ],
};
const reach = (index: number) => ({
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
    nativeWayIds: [123456 + index],
    sourceOriginals: [{ originalSha256: original }],
  },
});
const thirdReach = {
  type: 'Feature',
  id: 'cb-bai-devzone-hecao-reference',
  geometry: line,
  properties: {
    referenceRangeId: 'cb-bai-devzone-hecao-reference',
    label: '开发区橡胶坝—河槽汇口（地理参考，非月报全段）',
    nativeCrs: 'EPSG:4326',
    sourceWayIds: [654520834, 653954175],
    sourceAssetSha256: [original],
    professionalReview: 'pending',
    monthlyBoundaryConfirmed: false,
    serviceRegistered: false,
    coordinateRole: 'geographical-reference-line',
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL-1.0',
    fullOriginalRedistributionPermissionGranted: false,
  },
};
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'wiser-reference-manifest-'));
  const packPath = join(directory, 'pack.json');
  const manifestPath = join(directory, 'references.json');
  await writeFile(
    packPath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-10-05',
      processingVersion: 'p1',
      sources: [],
      records: [],
      regions: [],
      topicPackages: [],
      rasterReports: [],
    }),
  );
  const files: Record<string, unknown>[] = [];
  const add = async (id: string, format: string, features: unknown[]) => {
    const path = join(directory, `${id}.geojson`);
    const bytes = JSON.stringify({ type: 'FeatureCollection', features });
    await writeFile(path, bytes);
    files.push({
      id,
      path,
      format,
      sha256: digest(bytes),
      featureCount: features.length,
      originalSha256: [original],
      license: {
        id: 'ODbL-1.0',
        url: licenseUrl,
        attribution,
        state: 'verified',
      },
      scope: 'public-geographic-reference',
      limitation: {
        'zh-CN': '地理参考；不证明月报边界。',
        en: 'Geographic reference; no monthly boundary attestation.',
      },
    });
    return path;
  };
  const save = async (overrides: Record<string, unknown> = {}) => {
    const bytes = JSON.stringify({
      schemaVersion: 1,
      version: '2026-10-05.1',
      files,
      ...overrides,
    });
    await writeFile(manifestPath, bytes);
    return {
      NODE_ENV: 'development',
      WISER_AUTH_MODE: 'off',
      WISER_SPATIAL_WORKSPACE_MODE: 'local',
      WISER_SPATIAL_INPUT_MANIFEST: packPath,
      WISER_SPATIAL_PUBLIC_REFERENCE_MANIFEST: manifestPath,
      WISER_SPATIAL_PUBLIC_REFERENCE_SHA256: digest(bytes),
    };
  };
  return { directory, files, add, save };
}

describe('versioned public geographic reference manifest', () => {
  it('strips undeclared geometry fields while retaining the exact native coordinates', async () => {
    const fixture = await setup();
    try {
      await fixture.add('third', 'osm-reference-reach-v1', [
        {
          ...thirdReach,
          geometry: {
            ...line,
            privatePath: '/private/geometry-never-serialize',
          },
        },
      ]);
      const result = await loadLocalSpatialWorkspace(
        await fixture.save(),
        'localhost:3410',
      );
      expect(result.publicReferenceState).toBe('ready');
      expect(result.publicReferences?.features[0].geometry).toEqual(line);
      expect(JSON.stringify(result)).not.toContain('geometry-never-serialize');
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
  it('rejects an aggregate feature declaration over 25,000 without truncating a file', async () => {
    const fixture = await setup();
    try {
      await fixture.add('first', 'osm-reference-reaches-v1', [reach(0)]);
      await fixture.add('second', 'osm-reference-reaches-v1', [reach(1)]);
      fixture.files[0].featureCount = 13000;
      fixture.files[1].featureCount = 13000;
      expect(() =>
        parsePublicReferenceManifest({
          schemaVersion: 1,
          version: 'budget-1',
          files: fixture.files,
        }),
      ).toThrow();
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('rejects aggregate inputs over 32 MiB even when every file fits its own budget', async () => {
    const fixture = await setup();
    try {
      for (let index = 0; index < 3; index++) {
        const path = await fixture.add(
          `file-${index}`,
          'osm-reference-reaches-v1',
          [reach(index)],
        );
        const bytes = (await readFile(path, 'utf8')).padEnd(
          11 * 1024 * 1024,
          ' ',
        );
        await writeFile(path, bytes);
        fixture.files[index].sha256 = digest(bytes);
      }
      expect(
        await loadLocalSpatialWorkspace(await fixture.save(), 'localhost:3410'),
      ).toMatchObject({
        state: 'ready',
        publicReferenceState: 'invalid',
        publicReferences: null,
      });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
  it('loads six reaches from separately pinned files without assigning monthly identity', async () => {
    const fixture = await setup();
    try {
      await fixture.add(
        'existing-reaches',
        'osm-reference-reaches-v1',
        Array.from({ length: 5 }, (_, i) => reach(i)),
      );
      await fixture.add('third-reach', 'osm-reference-reach-v1', [thirdReach]);
      const result = await loadLocalSpatialWorkspace(
        await fixture.save(),
        'localhost:3410',
      );
      expect(result.publicReferenceState).toBe('ready');
      expect(result.publicReferences?.features).toHaveLength(6);
      expect(result.publicReferences?.features[5]).toMatchObject({
        id: 'reference-reach:cb-bai-devzone-hecao-reference',
        geometry: line,
        properties: {
          kind: 'reference-reach',
          scope: 'public-geographic-reference',
          originalSha256: [original],
        },
      });
      expect(result.publicReferences).toMatchObject({
        manifest: {
          version: '2026-10-05.1',
          files: [
            { id: 'existing-reaches', featureCount: 5 },
            { id: 'third-reach', featureCount: 1 },
          ],
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /wiser-reference-manifest-|sourceWayIds|monthlyBoundaryConfirmed|originalMonthlyRecordId/,
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('uses each declared feature count rather than a fixed five-feature limit', async () => {
    const fixture = await setup();
    try {
      await fixture.add(
        'six-in-one',
        'osm-reference-reaches-v1',
        Array.from({ length: 6 }, (_, i) => reach(i)),
      );
      const result = await loadLocalSpatialWorkspace(
        await fixture.save(),
        'localhost:3410',
      );
      expect(result.publicReferenceState).toBe('ready');
      expect(result.publicReferences?.features).toHaveLength(6);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it.each([
    'manifest-hash',
    'file-hash',
    'count',
    'license',
    'monthly-identity',
    'original-hash',
    'duplicate-id',
    'coordinate',
  ])(
    'closes the complete public layer on %s while retaining the record pack',
    async (failure) => {
      const fixture = await setup();
      try {
        await fixture.add('good', 'osm-reference-reaches-v1', [reach(0)]);
        const path = await fixture.add('third', 'osm-reference-reach-v1', [
          thirdReach,
        ]);
        if (failure === 'count') fixture.files[1].featureCount = 2;
        if (failure === 'license')
          fixture.files[1].license = { id: 'unknown', state: 'pending' };
        if (failure === 'original-hash')
          fixture.files[1].originalSha256 = ['b'.repeat(64)];
        if (failure === 'duplicate-id') fixture.files[1].id = 'good';
        if (failure === 'monthly-identity' || failure === 'coordinate') {
          const changed = JSON.parse(await readFile(path, 'utf8')) as {
            features: (typeof thirdReach)[];
          };
          if (failure === 'monthly-identity')
            changed.features[0].properties.monthlyBoundaryConfirmed = true;
          else changed.features[0].geometry.coordinates[0][0] = 181;
          const bytes = JSON.stringify(changed);
          await writeFile(path, bytes);
          fixture.files[1].sha256 = digest(bytes);
        }
        const env = await fixture.save();
        if (failure === 'manifest-hash')
          env.WISER_SPATIAL_PUBLIC_REFERENCE_SHA256 = '0'.repeat(64);
        if (failure === 'file-hash') await writeFile(path, '{}');
        const result = await loadLocalSpatialWorkspace(env, 'localhost:3410');
        expect(result).toMatchObject({
          state: 'ready',
          publicReferenceState: 'invalid',
          publicReferences: null,
        });
      } finally {
        await rm(fixture.directory, { recursive: true, force: true });
      }
    },
  );

  it('retains an explicit unavailable state for a missing configured file and never falls back to legacy paths', async () => {
    const fixture = await setup();
    try {
      const path = await fixture.add('missing', 'osm-reference-reach-v1', [
        thirdReach,
      ]);
      const env = await fixture.save();
      await rm(path);
      const result = await loadLocalSpatialWorkspace(
        {
          ...env,
          WISER_SPATIAL_REACH_REFERENCE_GEOJSON: '/also-missing.geojson',
        },
        'localhost:3410',
      );
      expect(result).toMatchObject({
        state: 'ready',
        publicReferenceState: 'unavailable',
        publicReferences: null,
      });
      expect(JSON.stringify(result)).not.toMatch(
        /missing.geojson|wiser-reference-manifest/,
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

it('loads the pinned public background in production without opening the local business pack', async () => {
  const fixture = await setup();
  try {
    await fixture.add('third', 'osm-reference-reach-v1', [thirdReach]);
    const environment = {
      ...(await fixture.save()),
      NODE_ENV: 'production',
      WISER_AUTH_MODE: 'supabase',
    };
    expect(
      await loadLocalSpatialWorkspace(environment, 'public.example'),
    ).toEqual({ state: 'disabled', pack: null });
    const loaded = await loadPublicReferences(environment);
    expect(loaded.publicReferenceState).toBe('ready');
    expect(loaded.publicReferences?.features).toHaveLength(1);
    expect(JSON.stringify(loaded)).not.toContain(fixture.directory);
    await writeFile(String(fixture.files[0].path), '{}');
    expect(await loadPublicReferences(environment)).toEqual({
      publicReferenceState: 'invalid',
      publicReferences: null,
    });
    expect(
      await loadPublicReferences({
        WISER_SPATIAL_PUBLIC_REFERENCE_MANIFEST:
          environment.WISER_SPATIAL_PUBLIC_REFERENCE_MANIFEST,
      }),
    ).toEqual({ publicReferenceState: 'invalid', publicReferences: null });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
