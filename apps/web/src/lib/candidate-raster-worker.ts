import {
  CANDIDATE_RASTER_MAX_CELLS,
  type CandidateRasterDecode,
  type CandidateRasterWindowResult,
} from './candidate-raster-window';

let active = false;

function validResult(
  value: unknown,
  input: CandidateRasterDecode,
): value is CandidateRasterWindowResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<CandidateRasterWindowResult>;
  const length = input.window.rows * input.window.columns;
  if (
    length < 1 ||
    length > CANDIDATE_RASTER_MAX_CELLS ||
    JSON.stringify(result.window) !== JSON.stringify(input.window) ||
    result.crs !== 'EPSG:32650' ||
    JSON.stringify(result.affine) !==
      JSON.stringify([20, 0, 385180, 0, -20, 4481920]) ||
    !(result.values?.B03 instanceof Uint16Array) ||
    result.values.B03.length !== length ||
    !(result.values.B8A instanceof Uint16Array) ||
    result.values.B8A.length !== length ||
    !(result.values.SCL instanceof Uint8Array) ||
    result.values.SCL.length !== length ||
    !Array.isArray(result.values.TCI) ||
    result.values.TCI.length !== 3 ||
    result.values.TCI.some(
      (item) => !(item instanceof Uint8Array) || item.length !== length,
    ) ||
    !(result.validMask instanceof Uint8Array) ||
    result.validMask.length !== length ||
    result.validMask.some((item) => item !== 255) ||
    !(result.qualityMask instanceof Uint8Array) ||
    result.qualityMask.length !== length ||
    result.qualityMask.some((item) => item !== 0 && item !== 1) ||
    JSON.stringify(result.quality) !== JSON.stringify(input.quality) ||
    typeof result.sourceProduct !== 'string' ||
    !result.sourceProduct ||
    typeof result.sensingTime !== 'string' ||
    !result.sensingTime
  )
    return false;
  return true;
}

/** At most one local browser task; abort/error/timeout destroys its decoder. */
export function runCandidateRasterWorker(
  input: CandidateRasterDecode,
  signal: AbortSignal,
): Promise<CandidateRasterWindowResult> {
  if (signal.aborted)
    return Promise.reject(new DOMException('Raster cancelled', 'AbortError'));
  if (active) return Promise.reject(new Error('Raster reader busy'));
  active = true;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL(
          '../workers/candidate-raster-window.worker.ts',
          import.meta.url,
        ),
        {
          type: 'module',
          name: 'wiser-candidate-raster-window',
        },
      );
    } catch {
      active = false;
      reject(new Error('Raster reader unavailable'));
      return;
    }
    let settled = false;
    const settle = (error?: Error, result?: CandidateRasterWindowResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      active = false;
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      settle(new DOMException('Raster cancelled', 'AbortError'));
    const timer = setTimeout(
      () => settle(new Error('Raster reader timeout')),
      60_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        const message = event.data as {
          kind?: unknown;
          result?: unknown;
        } | null;
        if (message?.kind === 'done' && validResult(message.result, input))
          settle(undefined, message.result);
        else settle(new Error('Raster reader unavailable'));
      } catch {
        settle(new Error('Raster reader unavailable'));
      }
    };
    worker.onerror = () => settle(new Error('Raster reader unavailable'));
    worker.onmessageerror = () =>
      settle(new Error('Raster reader unavailable'));
    try {
      // Transfer the four bounded buffers instead of retaining a second copy in the UI.
      worker.postMessage(
        input,
        input.assets.map((asset) => asset.bytes),
      );
    } catch {
      settle(new Error('Raster reader unavailable'));
    }
    if (signal.aborted) abort();
  });
}
