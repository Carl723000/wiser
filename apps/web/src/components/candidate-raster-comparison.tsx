'use client';
import { useCallback, useState } from 'react';
import type { getDictionary } from '@/lib/i18n';
import type { WorkspaceCamera } from '@/lib/spatial-workspace-view';
import type { RasterDisplayMode } from '@/lib/candidate-raster-display';
import {
  SpatialWorkspaceMap,
  type SpatialWorkspaceMapProps,
} from './spatial-workspace-map';
import styles from './candidate-raster-comparison.module.css';

type DisplayCopy = ReturnType<
  typeof getDictionary
>['dataFoundation']['candidateReader']['raster']['display'];

/** Two full geographic viewports; clipping never changes either projection or source geometry. */
export function CandidateRasterComparison({
  common,
  display,
  rightCamera,
  onRightCamera,
  sclGeometry,
  split,
  copy,
}: {
  readonly common: SpatialWorkspaceMapProps;
  readonly display: RasterDisplayMode;
  readonly rightCamera: WorkspaceCamera;
  readonly onRightCamera: (camera: WorkspaceCamera) => void;
  readonly sclGeometry: SpatialWorkspaceMapProps['inspectionGeometry'];
  readonly split: number;
  readonly copy: DisplayCopy;
}) {
  const [leftRenderer, setLeftRenderer] = useState<
    'maplibre' | 'planar' | 'pending' | null
  >(null);
  const [rightRenderer, setRightRenderer] = useState<
    'maplibre' | 'planar' | 'pending' | null
  >(null);
  const leftSurface = useCallback(
    (value: 'maplibre' | 'planar' | 'pending') => setLeftRenderer(value),
    [],
  );
  const rightSurface = useCallback(
    (value: 'maplibre' | 'planar' | 'pending') => setRightRenderer(value),
    [],
  );
  if (display === 'single') return <SpatialWorkspaceMap {...common} />;
  if (display === 'side-by-side')
    return (
      <div className={styles.columns}>
        <section aria-label={copy.tci}>
          <h5>{copy.tci}</h5>
          <SpatialWorkspaceMap {...common} />
        </section>
        <section aria-label={copy.scl}>
          <h5>{copy.scl}</h5>
          <SpatialWorkspaceMap
            {...common}
            camera={rightCamera}
            onCamera={onRightCamera}
            inspectionGeometry={sclGeometry}
          />
        </section>
      </div>
    );
  const alignedRenderer =
    leftRenderer !== null &&
    leftRenderer !== 'pending' &&
    leftRenderer === rightRenderer;
  return (
    <>
      <div className={styles.labels}>
        <span>{copy.scl}</span>
        <span>{copy.tci}</span>
      </div>
      <div
        className={styles.swipe}
        data-testid="candidate-raster-geographic-swipe"
        data-renderers-aligned={alignedRenderer}
      >
        <SpatialWorkspaceMap
          {...common}
          surfaceOnly
          onSurfaceRenderer={leftSurface}
        />
        <div
          className={styles.upper}
          data-testid="candidate-raster-swipe-upper"
          aria-hidden="true"
          inert
          style={{
            clipPath: `inset(0 ${100 - split}% 0 0)`,
            visibility: alignedRenderer ? 'visible' : 'hidden',
          }}
        >
          <SpatialWorkspaceMap
            {...common}
            surfaceOnly
            passive
            camera={rightCamera}
            onCamera={() => {}}
            onCoordinate={undefined}
            onBounds={undefined}
            drawBounds={false}
            inspectionGeometry={sclGeometry}
            onSurfaceRenderer={rightSurface}
          />
        </div>
        {alignedRenderer ? (
          <div
            aria-hidden="true"
            className={styles.divider}
            style={{ left: `${split}%` }}
          />
        ) : null}
      </div>
      {leftRenderer !== null &&
      rightRenderer !== null &&
      leftRenderer !== 'pending' &&
      rightRenderer !== 'pending' &&
      !alignedRenderer ? (
        <p role="status">{common.copy.renderFailed}</p>
      ) : null}
      {leftRenderer === 'planar' ? (
        <p role="status">{common.copy.noWebgl}</p>
      ) : null}
      <div className={styles.controls} role="group" aria-label={copy.title}>
        <button
          type="button"
          disabled={!common.active}
          onClick={() =>
            common.onCamera({
              ...common.camera,
              bearing: ((common.camera.bearing - 15 + 540) % 360) - 180,
            })
          }
        >
          {common.copy.rotateLeft}
        </button>
        <button
          type="button"
          disabled={!common.active}
          onClick={() =>
            common.onCamera({
              ...common.camera,
              bearing: ((common.camera.bearing + 15 + 540) % 360) - 180,
            })
          }
        >
          {common.copy.rotateRight}
        </button>
        {common.mode === '3d' ? (
          <>
            <button
              type="button"
              disabled={!common.active}
              onClick={() =>
                common.onCamera({
                  ...common.camera,
                  pitch: Math.min(70, common.camera.pitch + 10),
                })
              }
            >
              {common.copy.tiltUp}
            </button>
            <button
              type="button"
              disabled={!common.active}
              onClick={() =>
                common.onCamera({
                  ...common.camera,
                  pitch: Math.max(0, common.camera.pitch - 10),
                })
              }
            >
              {common.copy.tiltDown}
            </button>
          </>
        ) : null}
      </div>
    </>
  );
}
