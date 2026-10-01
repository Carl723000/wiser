import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
