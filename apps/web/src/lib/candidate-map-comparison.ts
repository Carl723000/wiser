import {
  candidateSavedReferenceKey,
  type IngestionCandidateGeometryPage,
} from '@wiser/data-contracts';
import type { MapCamera } from './amap-camera';

export type CandidateComparisonSide = 'left' | 'right';
export interface CandidateComparisonPosition {
  after?: string;
  anchor?: string;
  savedStart?: boolean;
  first?: number;
  readonly previous: readonly Omit<CandidateComparisonPosition, 'previous'>[];
}
export function candidateComparisonNext(
  position: CandidateComparisonPosition,
  cursor: string,
  anchor?: string,
): CandidateComparisonPosition {
  const { previous, ...current } = position;
  return {
    after: cursor,
    ...(anchor ? { anchor } : {}),
    ...(position.first ? { first: position.first } : {}),
    previous: [...previous, current].slice(-32),
  };
}
export function candidateComparisonPrevious(
  position: CandidateComparisonPosition,
): CandidateComparisonPosition {
  return {
    ...position.previous.at(-1),
    previous: position.previous.slice(0, -1),
  };
}
export function candidateComparisonDrawing(
  page: IngestionCandidateGeometryPage,
) {
  return JSON.stringify({
    reference: candidateSavedReferenceKey(page.reference),
    assetId: page.assetId.toLowerCase(),
    crs: page.crs,
    features: page.features,
  });
}
export function candidateComparisonOwner(
  side: CandidateComparisonSide,
  page: IngestionCandidateGeometryPage,
  position: CandidateComparisonPosition,
  epoch: number,
) {
  return JSON.stringify({
    side,
    drawing: candidateComparisonDrawing(page),
    first: position.first ?? 50,
    after: position.after ?? null,
    anchor: position.anchor ?? null,
    epoch,
  });
}
/** Framing uses native business geometry only; it assigns no new spatial identity. */
export function candidateComparisonInitialCamera(
  page: IngestionCandidateGeometryPage,
): MapCamera {
  const xs: number[] = [],
    ys: number[] = [];
  function coordinates(value: unknown) {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      xs.push(value[0]);
      ys.push(value[1]);
    } else for (const child of value) coordinates(child);
  }
  function geometry(
    value: IngestionCandidateGeometryPage['features'][number]['geometry'],
  ) {
    coordinates(value.coordinates);
    for (const child of value.geometries ?? []) geometry(child as typeof value);
  }
  for (const feature of page.features) geometry(feature.geometry);
  // Loop avoids spreading a potentially large validated page into call arguments.
  let west = 180,
    east = -180,
    south = 90,
    north = -90;
  for (let i = 0; i < xs.length; i++) {
    west = Math.min(west, xs[i]);
    east = Math.max(east, xs[i]);
    south = Math.min(south, ys[i]);
    north = Math.max(north, ys[i]);
  }
  return xs.length
    ? {
        longitude: (west + east) / 2,
        latitude: Math.max(
          -85.051129,
          Math.min(85.051129, (south + north) / 2),
        ),
        zoom: Math.max(
          1,
          Math.min(
            11,
            7 - Math.log2(Math.max(0.01, east - west, north - south)),
          ),
        ),
        bearing: 0,
        pitch: 0,
      }
    : { longitude: 105, latitude: 35, zoom: 2.3, bearing: 0, pitch: 0 };
}

/** Independent bounded read ownership; no fetch, persistence or authority lives here. */
export function createCandidateComparisonReadController() {
  let generation = 0;
  let pending: AbortController | null = null;
  return {
    start() {
      pending?.abort();
      pending = new AbortController();
      return { generation: ++generation, controller: pending };
    },
    current(token: { generation: number; controller: AbortController }) {
      return (
        token.generation === generation &&
        pending === token.controller &&
        !token.controller.signal.aborted
      );
    },
    finish(token: { generation: number; controller: AbortController }) {
      if (pending === token.controller) pending = null;
    },
    cancel() {
      generation++;
      pending?.abort();
      pending = null;
    },
  };
}
