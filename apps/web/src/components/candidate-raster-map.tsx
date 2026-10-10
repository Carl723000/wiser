'use client';
import type { PublicReferenceInput } from '@/lib/spatial-public-reference.server';
import { useMemo, useState } from 'react';
import { getDictionary, type Locale } from '@/lib/i18n';
import type {
  CandidateRasterWindow,
  CandidateRasterWindowResult,
} from '@/lib/candidate-raster-window';
import {
  mapRasterPixel,
  mapRasterWindowFromBounds,
  nativeRasterWindowBounds,
  rasterFootprintMapRing,
  rasterWindowMapRing,
} from '@/lib/candidate-raster-map';
import type { WorkspaceBounds } from '@/lib/spatial-workspace-contract';
import type {
  WorkspaceCamera,
  WorkspaceMapFeatures,
} from '@/lib/spatial-workspace-view';
import {
  SpatialWorkspaceMap,
  type SpatialWorkspaceMapProps,
} from './spatial-workspace-map';
import styles from './ingestion-candidate-raster-panel.module.css';

const emptyFeatures: WorkspaceMapFeatures = {
  type: 'FeatureCollection',
  features: [],
};
const footprint = rasterFootprintMapRing();
function cameraFor(
  ring: readonly (readonly number[])[],
  zoom: number,
): WorkspaceCamera {
  const longitudes = ring.map((point) => point[0]),
    latitudes = ring.map((point) => point[1]);
  return {
    longitude: (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    latitude: (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
    zoom,
    bearing: 0,
    pitch: 0,
  };
}

/** Only the current fixed candidate's reading state; nothing is persisted. */
export function CandidateRasterMap({
  locale,
  publicReferences,
  publicReferenceState,
  window,
  result,
  disabled,
  onWindow,
  onInvalid,
}: {
  readonly locale: Locale;
  readonly window: CandidateRasterWindow | null;
  readonly result: CandidateRasterWindowResult | null;
  readonly disabled: boolean;
  readonly onWindow: (window: CandidateRasterWindow) => void;
  readonly onInvalid: () => void;
} & PublicReferenceInput) {
  const dictionary = getDictionary(locale).dataFoundation;
  const copy = dictionary.candidateReader.raster;
  const [camera, setCamera] = useState(() => cameraFor(footprint, 10));
  const [area, setArea] = useState(false);
  const ring = window ? rasterWindowMapRing(window) : null;
  const pixels = useMemo(
    () =>
      result
        ? Array.from(
            { length: result.window.rows * result.window.columns },
            (_, index) => ({
              type: 'Feature' as const,
              properties: {
                kind: 'pixel' as const,
                color: `rgb(${result.values.TCI.map((band) => band[index]).join(',')})`,
              },
              geometry: {
                type: 'Polygon' as const,
                coordinates: [
                  rasterWindowMapRing({
                    row:
                      result.window.row +
                      Math.floor(index / result.window.columns),
                    column:
                      result.window.column + (index % result.window.columns),
                    rows: 1,
                    columns: 1,
                  }),
                ],
              },
            }),
          )
        : [],
    [result],
  );
  const geometry: NonNullable<SpatialWorkspaceMapProps['inspectionGeometry']> =
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { kind: 'footprint' },
          geometry: { type: 'Polygon', coordinates: [footprint] },
        },
        ...pixels,
        ...(ring
          ? [
              {
                type: 'Feature' as const,
                properties: { kind: 'selection' as const },
                geometry: { type: 'Polygon' as const, coordinates: [ring] },
              },
            ]
          : []),
      ],
    };
  function choose(point: readonly number[]) {
    if (disabled) return;
    try {
      onWindow({ ...mapRasterPixel(point), rows: 1, columns: 1 });
    } catch {
      onInvalid();
    }
  }
  function chooseBounds(bounds: WorkspaceBounds) {
    if (disabled) return;
    try {
      onWindow(mapRasterWindowFromBounds(bounds));
    } catch {
      onInvalid();
    }
  }
  return (
    <section aria-label={copy.mapTitle} className={styles.mapSection}>
      <p>{copy.mapScope}</p>
      <div className={styles.pager}>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={!area}
          onClick={() => setArea(false)}
        >
          {copy.selectPixel}
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={area}
          onClick={() => setArea(true)}
        >
          {copy.selectArea}
        </button>
        <button
          type="button"
          disabled={disabled || !ring}
          onClick={() => {
            if (ring) setCamera(cameraFor(ring, 16));
          }}
        >
          {copy.viewSelection}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setCamera(cameraFor(footprint, 10))}
        >
          {copy.viewGrid}
        </button>
      </div>
      <p>{area ? copy.selectAreaHint : copy.selectPixelHint}</p>
      {result ? <p>{copy.pixelDisplay}</p> : null}
      <div
        data-testid="candidate-raster-map-selection"
        data-native-window={
          window
            ? `${window.row},${window.column},${window.rows},${window.columns}`
            : ''
        }
        data-selection-ring={JSON.stringify(ring)}
      >
        <SpatialWorkspaceMap
          publicReferences={publicReferences}
          publicReferenceState={publicReferenceState}
          active={!disabled}
          features={emptyFeatures}
          camera={camera}
          mode="2d"
          selection={null}
          copy={dictionary.spatialWorkspace}
          onCamera={setCamera}
          onSelect={() => {}}
          drawBounds={area}
          onBounds={chooseBounds}
          onCoordinate={choose}
          inspectionGeometry={geometry}
        />
      </div>
      {window ? (
        <p>
          {copy.nativeBounds}: {nativeRasterWindowBounds(window).join(', ')} m ·
          EPSG:32650
        </p>
      ) : null}
      <p>{copy.mapRecovery}</p>
    </section>
  );
}
