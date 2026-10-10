'use client';
import type { PublicReferenceInput } from '@/lib/spatial-public-reference.server';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import type { SpatialWorkspaceMapProps } from './spatial-workspace-map';
import { CandidateRasterComparison } from './candidate-raster-comparison';
import {
  candidateRasterDisplay,
  initialRasterComparison,
  moveRasterCamera,
  rasterCamera,
  setRasterDisplay,
  setRasterSynchronization,
  setRasterViewMode,
  type RasterSide,
} from '@/lib/candidate-raster-display';
import comparisonStyles from './candidate-raster-comparison.module.css';
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
  const [comparison, setComparison] = useState(() =>
    initialRasterComparison(cameraFor(footprint, 10)),
  );
  const [split, setSplit] = useState(50);
  const camera = rasterCamera(comparison, 'left');
  const displayCopy = copy.display;
  const comparisonCopy = dictionary.candidateReader.comparison;
  const generation = useMemo(
    () => ({}),
    [result, window, disabled, comparison.display, comparison.mode],
  );
  const current = useRef<object | null>(null);
  useLayoutEffect(() => {
    current.current = generation;
    return () => {
      current.current = null;
    };
  }, [generation]);
  function owns() {
    return !disabled && current.current === generation;
  }
  function setCamera(next: WorkspaceCamera, side: RasterSide = 'left') {
    if (!owns()) return;
    setComparison((previous) =>
      previous.display === comparison.display &&
      previous.mode === comparison.mode
        ? moveRasterCamera(previous, side, next)
        : previous,
    );
  }
  const [area, setArea] = useState(false);
  function locate(ring: readonly (readonly number[])[], zoom: number) {
    setCamera({
      ...cameraFor(ring, zoom),
      bearing: camera.bearing,
      pitch: comparison.mode === '3d' ? camera.pitch || 50 : 0,
    });
  }
  const ring = window ? rasterWindowMapRing(window) : null;
  const windowKey = JSON.stringify(window);
  const displayData = useMemo(() => {
    if (!result || disabled || windowKey !== JSON.stringify(result.window))
      return null;
    try {
      return candidateRasterDisplay(result);
    } catch {
      return null;
    }
  }, [result, disabled, windowKey]);
  const surround: NonNullable<
    SpatialWorkspaceMapProps['inspectionGeometry']
  >['features'] = [
    {
      type: 'Feature',
      properties: { kind: 'footprint' },
      geometry: { type: 'Polygon', coordinates: [footprint] },
    },
    ...(ring
      ? [
          {
            type: 'Feature' as const,
            properties: { kind: 'selection' as const },
            geometry: { type: 'Polygon' as const, coordinates: [ring] },
          },
        ]
      : []),
  ];
  const geometry: NonNullable<SpatialWorkspaceMapProps['inspectionGeometry']> =
    {
      type: 'FeatureCollection',
      features: [...surround, ...(displayData?.tci.features ?? [])],
    };
  const sclGeometry: NonNullable<
    SpatialWorkspaceMapProps['inspectionGeometry']
  > = {
    type: 'FeatureCollection',
    features: [...surround, ...(displayData?.scl.features ?? [])],
  };
  const display = displayData ? comparison.display : 'single';
  function choose(point: readonly number[]) {
    if (!owns()) return;
    try {
      onWindow({ ...mapRasterPixel(point), rows: 1, columns: 1 });
    } catch {
      onInvalid();
    }
  }
  function chooseBounds(bounds: WorkspaceBounds) {
    if (!owns()) return;
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
            if (ring) locate(ring, 16);
          }}
        >
          {copy.viewSelection}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => locate(footprint, 10)}
        >
          {copy.viewGrid}
        </button>
      </div>
      <p>{area ? copy.selectAreaHint : copy.selectPixelHint}</p>
      <div className={styles.pager} role="group" aria-label={displayCopy.title}>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={comparison.mode === '2d'}
          onClick={() =>
            setComparison((previous) => setRasterViewMode(previous, '2d'))
          }
        >
          {dictionary.spatialWorkspace.flatView}
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={comparison.mode === '3d'}
          onClick={() =>
            setComparison((previous) => setRasterViewMode(previous, '3d'))
          }
        >
          {dictionary.spatialWorkspace.spaceView}
        </button>
        {(['single', 'side-by-side', 'swipe'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={disabled || !displayData}
            aria-pressed={display === mode}
            onClick={() =>
              setComparison((previous) => setRasterDisplay(previous, mode))
            }
          >
            {mode === 'single'
              ? displayCopy.single
              : mode === 'side-by-side'
                ? displayCopy.sideBySide
                : displayCopy.swipe}
          </button>
        ))}
      </div>
      {comparison.mode === '3d' ? (
        <p>{dictionary.spatialWorkspace.birdEyePlanar}</p>
      ) : null}
      {display === 'side-by-side' ? (
        <div className={styles.pager}>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={comparison.synchronized}
            onClick={() =>
              setComparison((previous) =>
                setRasterSynchronization(previous, true),
              )
            }
          >
            {comparisonCopy.synchronized}
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={!comparison.synchronized}
            onClick={() =>
              setComparison((previous) =>
                setRasterSynchronization(previous, false),
              )
            }
          >
            {comparisonCopy.independent}
          </button>
        </div>
      ) : null}
      {displayData ? (
        <>
          <p>{displayCopy.scope}</p>
          <p>
            {result!.sourceProduct} · {result!.sensingTime}
          </p>
          <ul
            className={comparisonStyles.legend}
            aria-label={displayCopy.legend}
          >
            {displayData.legend.map(({ code, count, color }) => (
              <li key={code}>
                <i aria-hidden="true" style={{ background: color }} />
                {code}: {count}
              </li>
            ))}
          </ul>
        </>
      ) : result && !disabled ? (
        <p role="alert">{copy.invalid}</p>
      ) : null}
      {display === 'swipe' ? (
        <>
          <p>{displayCopy.swipeScope}</p>
          <label className={comparisonStyles.split}>
            {displayCopy.split}
            <input
              type="range"
              aria-label={displayCopy.split}
              min="0"
              max="100"
              step="1"
              value={split}
              disabled={disabled}
              onChange={(event) => setSplit(Number(event.target.value))}
            />
            <output>{split}%</output>
          </label>
        </>
      ) : null}
      <div
        data-testid="candidate-raster-map-selection"
        data-native-window={
          window
            ? `${window.row},${window.column},${window.rows},${window.columns}`
            : ''
        }
        data-selection-ring={JSON.stringify(ring)}
      >
        <CandidateRasterComparison
          key={display}
          display={display}
          copy={displayCopy}
          split={split}
          sclGeometry={sclGeometry}
          rightCamera={rasterCamera(comparison, 'right')}
          onRightCamera={(next) => setCamera(next, 'right')}
          common={{
            publicReferences,
            publicReferenceState,
            active: !disabled,
            features: emptyFeatures,
            camera,
            mode: comparison.mode,
            selection: null,
            copy: dictionary.spatialWorkspace,
            onCamera: (next) => setCamera(next),
            onSelect: () => {},
            drawBounds: area,
            onBounds: chooseBounds,
            onCoordinate: choose,
            inspectionGeometry: geometry,
          }}
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
