import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { loadSpatialMedia } from './spatial-workspace-media';

describe('local imagery delivery', () => {
  it('serves a bounded verified PNG locally and rejects traversal, wrong signatures and production', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wiser-media-test-'));
    const env = {
      NODE_ENV: 'development',
      WISER_AUTH_MODE: 'off',
      WISER_SPATIAL_WORKSPACE_MODE: 'local',
      WISER_SPATIAL_MEDIA_DIRECTORY: directory,
    };
    try {
      await writeFile(
        join(directory, 'band.png'),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
      );
      expect(
        await loadSpatialMedia(env, 'localhost:3410', 'band.png'),
      ).not.toBeNull();
      for (const file of [
        '../band.png',
        '/band.png',
        'missing.png',
        'band.svg',
      ])
        expect(await loadSpatialMedia(env, 'localhost:3410', file)).toBeNull();
      expect(
        await loadSpatialMedia(
          { ...env, NODE_ENV: 'production' },
          'localhost:3410',
          'band.png',
        ),
      ).toBeNull();
      await writeFile(join(directory, 'wrong.png'), 'not-an-image');
      expect(
        await loadSpatialMedia(env, 'localhost:3410', 'wrong.png'),
      ).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
