import { describe, expect, it, vi } from 'vitest';
import type { IngestionCandidateAssetPage } from '@wiser/data-contracts';
import {
  RETAINED_RASTER_HASHES,
  type CandidateRasterDecode,
} from './candidate-raster-window';
import {
  readCandidateRasterWindow,
  type CandidateRasterReadInput,
} from './candidate-raster-original-reader';

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  reviewHash: 'a'.repeat(64),
  processingBatchId: '10000000-0000-4000-8000-000000000002',
};
const bands = ['B03', 'B8A', 'SCL', 'TCI'] as const;
const savedViewId = '10000000-0000-4000-8000-000000000009';
const input: CandidateRasterReadInput = {
  reference,
  locale: 'zh-CN',
  assets: bands.map((band, index) => ({
    band,
    assetId: `10000000-0000-4000-8000-${String(index + 3).padStart(12, '0')}`,
    sha256: RETAINED_RASTER_HASHES[band],
  })),
  window: { row: 77, column: 318, rows: 7, columns: 9 },
  quality: { kind: 'raw' },
};

function requestPath(value: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.href
      : value.url;
}

function page(): IngestionCandidateAssetPage {
  return {
    reference,
    parserVersion: 'raster-fixture',
    status: 'UNAVAILABLE',
    createdAt: '2026-10-03T10:00:00Z',
    totalAssetCount: 4,
    knownRecordCount: 0,
    knownFeatureCount: 0,
    unknownAssetCount: 4,
    assets: input.assets.map(({ assetId, sha256 }) => ({
      assetId,
      sourceHash: sha256,
      status: 'UNSUPPORTED',
      recordCount: null,
      featureCount: null,
      reason: 'UNSUPPORTED_RASTER',
    })),
    nextCursor: null,
  };
}

function savedOpen() {
  return {
    kind: 'ingestion-candidate-view',
    savedView: {
      kind: 'ingestion-candidate-view',
      viewId: savedViewId,
      title: 'Fixed raster scene',
      visibility: 'private',
      createdAt: '2026-10-03T10:00:00Z',
      revokedAt: null,
    },
    references: [reference],
    viewSpec: { page: { kind: 'assets', reference, first: 50 } },
    request: {
      capabilityId: 'data.ingestion.candidate.get',
      input: { ...reference, first: 50 },
    },
  };
}

function fakeFetch(
  bytes: Readonly<Record<string, Uint8Array>>,
  options: {
    revokeAfterDecode?: () => boolean;
    wrongReference?: boolean;
    duplicateAsset?: boolean;
    revokeSavedAfterDecode?: () => boolean;
    declaredLength?: Partial<Record<(typeof bands)[number], number>>;
  } = {},
) {
  const calls: string[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((url, init) => {
      const path = requestPath(url);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/candidate-saved-views/open'))
        return Promise.resolve(
          options.revokeSavedAfterDecode?.()
            ? new Response(null, { status: 410 })
            : Response.json(savedOpen()),
        );
      if (path.endsWith('/candidates/get')) {
        if (options.revokeAfterDecode?.())
          return Promise.resolve(new Response(null, { status: 403 }));
        const value = page();
        return Promise.resolve(
          Response.json({
            ...value,
            reference: options.wrongReference
              ? { ...reference, reviewHash: 'b'.repeat(64) }
              : value.reference,
            assets: options.duplicateAsset
              ? [value.assets[0], value.assets[0], ...value.assets.slice(2)]
              : value.assets,
          }),
        );
      }
      const asset = input.assets.find((entry) =>
        path.includes(`/${entry.assetId}?`),
      );
      if (!asset) throw new Error(`Unexpected request ${path}`);
      const body = bytes[asset.band];
      if (!body) throw new Error(`Missing test bytes ${asset.band}`);
      const length = options.declaredLength?.[asset.band] ?? body.byteLength;
      if (init?.method === 'HEAD')
        return Promise.resolve(
          new Response(null, {
            headers: {
              'content-length': String(length),
              'content-type': 'application/octet-stream',
            },
          }),
        );
      return Promise.resolve(
        new Response(Uint8Array.from(body), {
          headers: {
            'content-length': String(length),
            'content-type': 'application/octet-stream',
          },
        }),
      );
    });
  return { fetch, calls };
}

describe('current-authority candidate raster original adapter', () => {
  it('rejects duplicate asset IDs, wrong band hash, and malformed fixed references before any network read', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const signal = new AbortController().signal;
    await expect(
      readCandidateRasterWindow(
        {
          ...input,
          assets: [input.assets[0], input.assets[0], ...input.assets.slice(2)],
        },
        signal,
        fetch,
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(
      readCandidateRasterWindow(
        {
          ...input,
          assets: input.assets.map((asset) =>
            asset.band === 'SCL' ? { ...asset, sha256: 'b'.repeat(64) } : asset,
          ),
        },
        signal,
        fetch,
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(
      readCandidateRasterWindow(
        { ...input, reference: { ...reference, reviewHash: 'x' } },
        signal,
        fetch,
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a different candidate page or duplicate asset before fetching an original', async () => {
    for (const option of [{ wrongReference: true }, { duplicateAsset: true }]) {
      const { fetch, calls } = fakeFetch({}, option);
      await expect(
        readCandidateRasterWindow(input, new AbortController().signal, fetch),
      ).rejects.toMatchObject({ kind: 'invalid' });
      expect(calls.every((call) => call.includes('/candidates/get'))).toBe(
        true,
      );
    }
  });

  it('fails closed after cancellation before contacting originals', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      readCandidateRasterWindow(input, AbortSignal.abort(), fetch),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the standard current saved-view open before any original read', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 410 }));
    await expect(
      readCandidateRasterWindow(
        { ...input, savedViewId },
        new AbortController().signal,
        fetch,
      ),
    ).rejects.toMatchObject({ kind: 'stale' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestPath(fetch.mock.calls[0][0])).toContain(
      '/candidate-saved-views/open',
    );
  });

  it('rejects an over-budget declared body before it can be consumed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((url) =>
      Promise.resolve(
        requestPath(url).endsWith('/candidates/get')
          ? Response.json(page())
          : new Response('x', {
              headers: {
                'content-length': String(16 * 1024 * 1024 + 1),
                'content-type': 'application/octet-stream',
              },
            }),
      ),
    );
    await expect(
      readCandidateRasterWindow(input, new AbortController().signal, fetch),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(
      fetch.mock.calls.filter(([url]) =>
        requestPath(url).includes('/candidate-assets/'),
      ),
    ).toHaveLength(1);
  });

  it('cancels a slow original stream and releases the local admission', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const streaming = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((url) => {
      if (requestPath(url).endsWith('/candidates/get'))
        return Promise.resolve(Response.json(page()));
      entered();
      return Promise.resolve(
        new Response(
          new ReadableStream({ pull: () => new Promise<void>(() => {}) }),
          {
            headers: {
              'content-length': '2061896',
              'content-type': 'application/octet-stream',
            },
          },
        ),
      );
    });
    const pending = readCandidateRasterWindow(input, controller.signal, fetch);
    await streaming;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    const retry = readCandidateRasterWindow(
      {
        ...input,
        assets: [input.assets[0], input.assets[0], ...input.assets.slice(2)],
      },
      new AbortController().signal,
      fetch,
    );
    await expect(retry).rejects.toMatchObject({ kind: 'invalid' });
  });

  it.runIf(Boolean(process.env.WISER_RETAINED_RASTER_DIR))(
    'GETs four exact originals serially, hashes them, decodes once, then rechecks every asset before showing a result',
    async () => {
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const names = [
        'b03-20m-native-window.tif',
        'b8a-20m-native-window.tif',
        'scl-20m-native-window.tif',
        'tci-20m-native-window.tif',
      ];
      const bytes = Object.fromEntries(
        await Promise.all(
          bands.map(async (band, i) => [
            band,
            await readFile(
              path.join(process.env.WISER_RETAINED_RASTER_DIR!, names[i]),
            ),
          ]),
        ),
      ) as Record<string, Uint8Array>;
      let decoded = false;
      const { fetch, calls } = fakeFetch(bytes, {
        revokeAfterDecode: () => false,
      });
      const decode = vi.fn(async (task: CandidateRasterDecode) => {
        decoded = true;
        const { decodeCandidateRasterWindow } =
          await import('./candidate-raster-window');
        return decodeCandidateRasterWindow(task);
      });
      const result = await readCandidateRasterWindow(
        input,
        new AbortController().signal,
        fetch,
        decode,
      );
      expect(decoded).toBe(true);
      expect(result.values.B03[0]).toBe(1415);
      expect(
        calls.filter((call) =>
          call.startsWith('GET /api/data-foundation/candidate-assets/'),
        ),
      ).toHaveLength(4);
      expect(
        calls.filter((call) =>
          call.startsWith('HEAD /api/data-foundation/candidate-assets/'),
        ),
      ).toHaveLength(4);
      expect(calls.at(-1)).toContain('/candidates/get');

      decoded = false;
      const revoked = fakeFetch(bytes, { revokeAfterDecode: () => decoded });
      await expect(
        readCandidateRasterWindow(
          input,
          new AbortController().signal,
          revoked.fetch,
          decode,
        ),
      ).rejects.toMatchObject({ kind: 'denied' });
      expect(
        revoked.calls.filter((call) =>
          call.startsWith('HEAD /api/data-foundation/candidate-assets/'),
        ),
      ).toHaveLength(4);

      const corruptedBytes = { ...bytes, B03: Uint8Array.from(bytes.B03) };
      corruptedBytes.B03[corruptedBytes.B03.length - 1] ^= 1;
      const corrupted = fakeFetch(corruptedBytes);
      await expect(
        readCandidateRasterWindow(
          input,
          new AbortController().signal,
          corrupted.fetch,
          decode,
        ),
      ).rejects.toMatchObject({ kind: 'invalid' });
      expect(
        corrupted.calls.some((call) =>
          call.startsWith('HEAD /api/data-foundation/candidate-assets/'),
        ),
      ).toBe(false);

      const aggregate = fakeFetch(bytes, {
        declaredLength: { TCI: 13 * 1024 * 1024 },
      });
      await expect(
        readCandidateRasterWindow(
          input,
          new AbortController().signal,
          aggregate.fetch,
          decode,
        ),
      ).rejects.toMatchObject({ kind: 'invalid' });
      expect(
        aggregate.calls.filter((call) =>
          call.startsWith('GET /api/data-foundation/candidate-assets/'),
        ),
      ).toHaveLength(4);
      expect(
        aggregate.calls.some((call) =>
          call.startsWith('HEAD /api/data-foundation/candidate-assets/'),
        ),
      ).toBe(false);

      decoded = false;
      const saved = fakeFetch(bytes, { revokeSavedAfterDecode: () => decoded });
      await expect(
        readCandidateRasterWindow(
          { ...input, savedViewId },
          new AbortController().signal,
          saved.fetch,
          decode,
        ),
      ).rejects.toMatchObject({ kind: 'stale' });
      expect(
        saved.calls.filter((call) =>
          call.includes('/candidate-saved-views/open'),
        ),
      ).toHaveLength(2);
      expect(
        saved.calls
          .filter((call) => call.includes('/candidate-assets/'))
          .every((call) => call.includes(`savedViewId=${savedViewId}`)),
      ).toBe(true);
    },
  );
});
