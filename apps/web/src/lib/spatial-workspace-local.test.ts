import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadLocalSpatialWorkspace } from './spatial-workspace-local';

describe('explicit local spatial processing input', () => {
  it('does not read a manifest in production, a signed-in live environment, or on a public host', async () => {
    const env = {
      NODE_ENV: 'development',
      WISER_AUTH_MODE: 'off',
      WISER_SPATIAL_WORKSPACE_MODE: 'local',
      WISER_SPATIAL_INPUT_MANIFEST: '/missing.json',
    };
    for (const [environment, host] of [
      [{ ...env, NODE_ENV: 'production' }, '127.0.0.1:3410'],
      [{ ...env, WISER_AUTH_MODE: 'supabase' }, 'localhost:3410'],
      [env, 'wiser.example.org'],
      [{ ...env, WISER_SPATIAL_WORKSPACE_MODE: undefined }, 'localhost:3410'],
    ] as const)
      expect(await loadLocalSpatialWorkspace(environment, host)).toEqual({
        state: 'disabled',
        pack: null,
      });
  });
  it('classifies absent and malformed local input without leaking its path or falling back to fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wiser-spatial-test-'));
    const path = join(directory, 'input.json');
    const env = {
      NODE_ENV: 'development',
      WISER_AUTH_MODE: 'off',
      WISER_SPATIAL_WORKSPACE_MODE: 'local',
      WISER_SPATIAL_INPUT_MANIFEST: path,
    };
    try {
      expect(await loadLocalSpatialWorkspace(env, '127.0.0.1:3410')).toEqual({
        state: 'unavailable',
        pack: null,
      });
      await writeFile(path, '{"token":"never-serialize"}');
      const failed = await loadLocalSpatialWorkspace(env, 'localhost:3410');
      expect(failed).toEqual({ state: 'invalid', pack: null });
      expect(JSON.stringify(failed)).not.toMatch(
        /never-serialize|wiser-spatial-test/,
      );
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-10-02',
          processingVersion: 'p1',
          sources: [],
          records: [],
          regions: [],
          topicPackages: [],
          rasterReports: [],
        }),
      );
      expect(
        (await loadLocalSpatialWorkspace(env, 'localhost:3410')).state,
      ).toBe('ready');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('loads only hash-pinned real readiness facts through the same local gate and strips unknown fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wiser-readiness-test-'));
    const path = join(directory, 'pack.json');
    const factsPath = join(directory, 'facts.json');
    const pack = {
      schemaVersion: 1,
      generatedAt: '2026-10-03',
      processingVersion: 'p1',
      sources: [],
      records: [],
      regions: [],
      topicPackages: [],
      rasterReports: [],
    };
    const facts = {
      track: 'REAL',
      requirement: {
        needId: 'K5-001',
        version: 'fixed-v1',
        regionId: 'chaobai',
        purpose: 'publication-coverage',
        dateRole: 'PUBLICATION',
        window: { start: '2023-04', end: '2023-11' },
        originalPath: '/private/never-serialize',
      },
      sources: [],
      records: [],
      series: [],
      correspondences: [],
      token: 'never-serialize',
    };
    const content = JSON.stringify(facts);
    const env = {
      NODE_ENV: 'development',
      WISER_AUTH_MODE: 'off',
      WISER_SPATIAL_WORKSPACE_MODE: 'local',
      WISER_SPATIAL_INPUT_MANIFEST: path,
      WISER_SPATIAL_READINESS_INPUT_MANIFEST: factsPath,
      WISER_SPATIAL_READINESS_INPUT_SHA256: createHash('sha256')
        .update(content)
        .digest('hex'),
    };
    try {
      await writeFile(path, JSON.stringify(pack));
      await writeFile(factsPath, content);
      const loaded = await loadLocalSpatialWorkspace(env, '127.0.0.1:3421');
      expect(loaded).toMatchObject({
        state: 'ready',
        readinessState: 'ready',
        readinessFacts: { track: 'REAL', requirement: { version: 'fixed-v1' } },
      });
      expect(JSON.stringify(loaded)).not.toMatch(
        /never-serialize|readiness-test-/,
      );
      const unavailableSource = {
        workId: 'not-in-readable-pack',
        versionId: 'v1',
        assetId: 'fixed-asset',
      };
      const withUnavailableContent = JSON.stringify({
        ...facts,
        sources: [
          {
            ...unavailableSource,
            track: 'REAL',
            kind: 'DOCUMENT',
            needIds: ['K5-001'],
            regionIds: ['chaobai'],
          },
        ],
        records: [
          {
            id: 'unreadable-record',
            source: unavailableSource,
            needIds: ['K5-001'],
            regionIds: ['chaobai'],
            object: {
              key: 'object-1',
              originalName: 'unreadable-value',
              markers: [],
              footnotes: [],
            },
            series: null,
            time: { value: null, role: 'UNKNOWN', precision: 'UNKNOWN' },
            rawValue: 'unreadable-value',
            metric: null,
            parsing: 'READY',
            professionalState: 'PENDING_REVIEW',
            evidence: [],
            spatial: null,
          },
        ],
      });
      await writeFile(factsPath, withUnavailableContent);
      const scoped = await loadLocalSpatialWorkspace(
        {
          ...env,
          WISER_SPATIAL_READINESS_INPUT_SHA256: createHash('sha256')
            .update(withUnavailableContent)
            .digest('hex'),
        },
        'localhost:3421',
      );
      expect(scoped).toMatchObject({
        readinessState: 'ready',
        readinessFacts: { sources: [], records: [] },
      });
      expect(JSON.stringify(scoped)).not.toMatch(
        /unreadable-value|unreadable-record/,
      );
      await writeFile(factsPath, content);
      const mismatch = await loadLocalSpatialWorkspace(
        { ...env, WISER_SPATIAL_READINESS_INPUT_SHA256: '0'.repeat(64) },
        'localhost:3421',
      );
      expect(mismatch).toMatchObject({
        state: 'ready',
        readinessState: 'invalid',
        readinessFacts: null,
      });
      const disabled = await loadLocalSpatialWorkspace(
        env,
        'public.example.org',
      );
      expect(disabled).toEqual({ state: 'disabled', pack: null });
      const syntheticContent = JSON.stringify({ ...facts, track: 'SYNTHETIC' });
      await writeFile(factsPath, syntheticContent);
      expect(
        await loadLocalSpatialWorkspace(
          {
            ...env,
            WISER_SPATIAL_READINESS_INPUT_SHA256: createHash('sha256')
              .update(syntheticContent)
              .digest('hex'),
          },
          'localhost:3421',
        ),
      ).toMatchObject({ readinessState: 'invalid', readinessFacts: null });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
