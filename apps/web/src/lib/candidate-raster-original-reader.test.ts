import { describe, expect, it, vi } from 'vitest';
import type { IngestionCandidateAssetPage } from '@wiser/data-contracts';
import { RETAINED_RASTER_HASHES, type CandidateRasterDecode } from './candidate-raster-window';
import { readCandidateRasterWindow, type CandidateRasterReadInput } from './candidate-raster-original-reader';

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  reviewHash: 'a'.repeat(64),
  processingBatchId: '10000000-0000-4000-8000-000000000002',
};
const bands = ['B03', 'B8A', 'SCL', 'TCI'] as const;
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

function fakeFetch(
  bytes: Readonly<Record<string, Uint8Array>>,
  options: { revokeAfterDecode?: () => boolean; wrongReference?: boolean; duplicateAsset?: boolean } = {},
) {
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    const path = String(url);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/candidates/get')) {
      if (options.revokeAfterDecode?.()) return new Response(null, { status: 403 });
      const value = page();
      return Response.json({
        ...value,
        reference: options.wrongReference ? { ...reference, reviewHash: 'b'.repeat(64) } : value.reference,
        assets: options.duplicateAsset ? [value.assets[0], value.assets[0], ...value.assets.slice(2)] : value.assets,
      });
    }
    const asset = input.assets.find((entry) => path.includes(`/${entry.assetId}?`));
    if (!asset) throw new Error(`Unexpected request ${path}`);
    const body = bytes[asset.band];
    if (!body) throw new Error(`Missing test bytes ${asset.band}`);
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(body.byteLength), 'content-type': 'application/octet-stream' } });
    return new Response(Uint8Array.from(body), { headers: { 'content-length': String(body.byteLength), 'content-type': 'application/octet-stream' } });
  });
  return { fetch, calls };
}

describe('current-authority candidate raster original adapter', () => {
  it('rejects duplicate asset IDs, wrong band hash, and malformed fixed references before any network read', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const signal = new AbortController().signal;
    await expect(readCandidateRasterWindow({ ...input, assets: [input.assets[0], input.assets[0], ...input.assets.slice(2)] }, signal, fetch)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(readCandidateRasterWindow({ ...input, assets: input.assets.map((asset) => asset.band === 'SCL' ? { ...asset, sha256: 'b'.repeat(64) } : asset) }, signal, fetch)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(readCandidateRasterWindow({ ...input, reference: { ...reference, reviewHash: 'x' } }, signal, fetch)).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a different candidate page or duplicate asset before fetching an original', async () => {
    for (const option of [{ wrongReference: true }, { duplicateAsset: true }]) {
      const { fetch, calls } = fakeFetch({}, option);
      await expect(readCandidateRasterWindow(input, new AbortController().signal, fetch)).rejects.toMatchObject({ kind: 'invalid' });
      expect(calls.every((call) => call.includes('/candidates/get'))).toBe(true);
    }
  });

  it('fails closed after cancellation before contacting originals', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(readCandidateRasterWindow(input, AbortSignal.abort(), fetch)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.runIf(Boolean(process.env.WISER_RETAINED_RASTER_DIR))('GETs four exact originals serially, hashes them, decodes once, then rechecks every asset before showing a result', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const names = ['b03-20m-native-window.tif', 'b8a-20m-native-window.tif', 'scl-20m-native-window.tif', 'tci-20m-native-window.tif'];
    const bytes = Object.fromEntries(await Promise.all(bands.map(async (band, i) => [band, await readFile(join(process.env.WISER_RETAINED_RASTER_DIR!, names[i]))]))) as Record<string, Uint8Array>;
    let decoded = false;
    const { fetch, calls } = fakeFetch(bytes, { revokeAfterDecode: () => false });
    const decode = vi.fn(async (task: CandidateRasterDecode) => {
      decoded = true;
      const { decodeCandidateRasterWindow } = await import('./candidate-raster-window');
      return decodeCandidateRasterWindow(task);
    });
    const result = await readCandidateRasterWindow(input, new AbortController().signal, fetch, decode);
    expect(decoded).toBe(true);
    expect(result.values.B03[0]).toBe(1415);
    expect(calls.filter((call) => call.startsWith('GET /api/data-foundation/candidate-assets/'))).toHaveLength(4);
    expect(calls.filter((call) => call.startsWith('HEAD /api/data-foundation/candidate-assets/'))).toHaveLength(4);
    expect(calls.at(-1)).toContain('/candidates/get');

    const revoked = fakeFetch(bytes, { revokeAfterDecode: () => decoded });
    await expect(readCandidateRasterWindow(input, new AbortController().signal, revoked.fetch, decode)).rejects.toMatchObject({ kind: 'denied' });
  });
});
