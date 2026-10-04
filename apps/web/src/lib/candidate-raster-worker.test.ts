import { afterEach, expect, it, vi } from 'vitest';
import {
  RETAINED_RASTER_HASHES,
  type CandidateRasterDecode,
} from './candidate-raster-window';
import { runCandidateRasterWorker } from './candidate-raster-worker';

const input: CandidateRasterDecode = {
  assets: (['B03', 'B8A', 'SCL', 'TCI'] as const).map((band) => ({
    band,
    sha256: RETAINED_RASTER_HASHES[band],
    bytes: new ArrayBuffer(1),
  })),
  window: { row: 0, column: 0, rows: 1, columns: 1 },
  quality: { kind: 'raw' },
};
class WorkerDouble {
  static current: WorkerDouble;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    WorkerDouble.current = this;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('transfers original buffers and terminates its only Worker on cancellation', async () => {
  vi.stubGlobal('Worker', WorkerDouble);
  const controller = new AbortController();
  const pending = runCandidateRasterWorker(input, controller.signal);
  const concurrent = runCandidateRasterWorker(
    input,
    new AbortController().signal,
  );
  await expect(concurrent).rejects.toThrow('busy');
  expect(WorkerDouble.current.postMessage).toHaveBeenCalledWith(
    input,
    input.assets.map((asset) => asset.bytes),
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(WorkerDouble.current.terminate).toHaveBeenCalledOnce();
});

it('accepts a bounded native result and discards the Worker after delivery', async () => {
  vi.stubGlobal('Worker', WorkerDouble);
  const pending = runCandidateRasterWorker(input, new AbortController().signal);
  const result = {
    window: input.window,
    crs: 'EPSG:32650',
    affine: [20, 0, 385180, 0, -20, 4481920],
    values: {
      B03: Uint16Array.of(0),
      B8A: Uint16Array.of(2),
      SCL: Uint8Array.of(0),
      TCI: [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)],
    },
    validMask: Uint8Array.of(255),
    qualityMask: Uint8Array.of(1),
    quality: input.quality,
    sourceProduct: 'one-fixed-scene',
    sensingTime: '2026-08-24T03:05:19Z',
  };
  WorkerDouble.current.onmessage?.({ data: { kind: 'done', result } });
  await expect(pending).resolves.toEqual(result);
  expect(WorkerDouble.current.terminate).toHaveBeenCalledOnce();
});

it.each(['error', 'messageerror', 'invalid', 'timeout'] as const)(
  'releases the one-Worker budget on %s',
  async (failure) => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', WorkerDouble);
    const pending = runCandidateRasterWorker(
      input,
      new AbortController().signal,
    );
    const expected = expect(pending).rejects.toThrow();
    if (failure === 'error') WorkerDouble.current.onerror?.();
    if (failure === 'messageerror') WorkerDouble.current.onmessageerror?.();
    if (failure === 'invalid')
      WorkerDouble.current.onmessage?.({
        data: { kind: 'done', result: null },
      });
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
    await expected;
    expect(WorkerDouble.current.terminate).toHaveBeenCalledOnce();
    const again = runCandidateRasterWorker(input, AbortSignal.abort());
    await expect(again).rejects.toMatchObject({ name: 'AbortError' });
  },
);
