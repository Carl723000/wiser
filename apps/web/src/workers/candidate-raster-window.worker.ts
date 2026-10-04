import {
  decodeCandidateRasterWindow,
  type CandidateRasterDecode,
} from '../lib/candidate-raster-window';

// The controller terminates this entire Worker on cancellation. GeoTIFF.js does
// not get a nested decoder pool, and no decoded values survive a failed task.
self.onmessage = async (event: MessageEvent<CandidateRasterDecode>) => {
  try {
    const result = await decodeCandidateRasterWindow(event.data);
    self.postMessage({ kind: 'done', result });
  } catch {
    self.postMessage({ kind: 'failed' });
  }
};
