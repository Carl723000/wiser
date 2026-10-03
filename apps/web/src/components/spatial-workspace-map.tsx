'use client';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibre from 'maplibre-gl';
import Map, { Layer, Source, type MapRef } from 'react-map-gl/maplibre';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, Geometry, Position } from 'geojson';
import type {
  WorkspaceBounds,
  WorkspaceRasterReport,
} from '@/lib/spatial-workspace-contract';
import type { SpatialWorkspaceCopy } from '@/lib/spatial-workspace-copy';
import {
  projectWorkspaceCoordinate,
  defaultWorkspaceRaster,
  workspaceGeometryAnchor,
  workspaceRecordKinds,
  type WorkspaceCamera,
  type WorkspaceMapFeatures,
  type WorkspaceSelection,
  type WorkspaceRasterSettings,
} from '@/lib/spatial-workspace-view';
import styles from './spatial-workspace.module.css';

maplibre.setWorkerUrl('/vendor/maplibre/6.11.2/maplibre-gl-worker.mjs');
const offlineStyle: maplibre.StyleSpecification = {
  version: 8,
  projection: { type: 'mercator' },
  sources: {},
  layers: [],
};
const interactiveLayers = [
  'workspace-areas',
  'workspace-lines',
  'workspace-points',
];
const grid: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    ...Array.from({ length: 29 }, (_, i) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [106 + i * 0.5, 30],
          [106 + i * 0.5, 46],
        ],
      },
    })),
    ...Array.from({ length: 33 }, (_, i) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [106, 30 + i * 0.5],
          [122, 30 + i * 0.5],
        ],
      },
    })),
  ],
};

export interface SpatialWorkspaceMapProps {
  features: WorkspaceMapFeatures;
  camera: WorkspaceCamera;
  mode: '2d' | '3d';
  selection: WorkspaceSelection;
  copy: SpatialWorkspaceCopy;
  onCamera: (camera: WorkspaceCamera) => void;
  onSelect: (selection: NonNullable<WorkspaceSelection>) => void;
  bounds?: WorkspaceBounds | null;
  drawBounds?: boolean;
  onBounds?: (bounds: WorkspaceBounds) => void;
  rasterReports?: readonly WorkspaceRasterReport[];
  rasterSettings?: WorkspaceRasterSettings;
  onRasterChange?: (settings: WorkspaceRasterSettings) => void;
  /** Optional deterministic rendering-capability override for browser acceptance. */
  webGLAvailable?: boolean;
}
type ScreenFrame = { matrix: number[]; width: number; height: number };
function hasWebGL() {
  if (typeof window === 'undefined' || !window.WebGL2RenderingContext)
    return false;
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}
function area(bounds: WorkspaceBounds | null | undefined): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: bounds
      ? [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [bounds[0], bounds[1]],
                  [bounds[2], bounds[1]],
                  [bounds[2], bounds[3]],
                  [bounds[0], bounds[3]],
                  [bounds[0], bounds[1]],
                ],
              ],
            },
          },
        ]
      : [],
  };
}
function rectangle(
  a: readonly number[],
  b: readonly number[],
): WorkspaceBounds {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ];
}
function mercator(position: readonly number[]) {
  const latitude = (Math.min(85, Math.max(-85, position[1])) * Math.PI) / 180;
  return [
    (position[0] + 180) / 360,
    (1 - Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / Math.PI) / 2,
  ];
}
function planarProjection(
  camera: WorkspaceCamera,
  width: number,
  height: number,
) {
  const center = mercator([camera.longitude, camera.latitude]);
  const scale = 512 * 2 ** camera.zoom,
    radians = (-camera.bearing * Math.PI) / 180,
    c = Math.cos(radians),
    s = Math.sin(radians);
  return {
    project: (position: readonly number[]) => {
      const [x, y] = mercator(position),
        dx = (x - center[0]) * scale,
        dy = (y - center[1]) * scale;
      return [width / 2 + c * dx - s * dy, height / 2 + s * dx + c * dy];
    },
    unproject: (x: number, y: number) => {
      const dx = x - width / 2,
        dy = y - height / 2,
        mx = center[0] + (c * dx + s * dy) / scale,
        my = center[1] + (-s * dx + c * dy) / scale;
      return [
        mx * 360 - 180,
        (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI,
      ];
    },
  };
}
/** Quantize presentation pixels only; source coordinates and map math remain full precision. */
function screenCoordinate(value: number, precision = 3) {
  return String(Number(value.toFixed(precision)));
}
function geometryPaths(
  geometry: Geometry,
  project: (value: Position) => number[],
): { path: string; fill: boolean }[] {
  const line = (points: Position[], close = false) =>
    points
      .map(
        (point, i) =>
          `${i ? 'L' : 'M'}${project(point)
            .map((value) => screenCoordinate(value))
            .join(' ')}`,
      )
      .join(' ') + (close ? ' Z' : '');
  const point = (position: Position) => {
    const [x, y] = project(position);
    return `M${screenCoordinate(x - 4)} ${screenCoordinate(y)}a4 4 0 1 0 8 0a4 4 0 1 0 -8 0`;
  };
  switch (geometry.type) {
    case 'Point':
      return [{ path: point(geometry.coordinates), fill: true }];
    case 'MultiPoint':
      return geometry.coordinates.map((position) => ({
        path: point(position),
        fill: true,
      }));
    case 'LineString':
      return [{ path: line(geometry.coordinates), fill: false }];
    case 'MultiLineString':
      return geometry.coordinates.map((positions) => ({
        path: line(positions),
        fill: false,
      }));
    case 'Polygon':
      return [
        {
          path: geometry.coordinates
            .map((positions) => line(positions, true))
            .join(' '),
          fill: true,
        },
      ];
    case 'MultiPolygon':
      return geometry.coordinates.map((polygon) => ({
        path: polygon.map((positions) => line(positions, true)).join(' '),
        fill: true,
      }));
    case 'GeometryCollection':
      return geometry.geometries.flatMap((part) =>
        geometryPaths(part, project),
      );
  }
}

export function SpatialWorkspaceMap({
  features,
  camera,
  mode,
  selection,
  copy,
  onCamera,
  onSelect,
  bounds = null,
  drawBounds = false,
  onBounds,
  rasterReports = [],
  rasterSettings = defaultWorkspaceRaster,
  onRasterChange,
  webGLAvailable,
}: SpatialWorkspaceMapProps) {
  const map = useRef<MapRef>(null),
    container = useRef<HTMLDivElement>(null),
    drawStart = useRef<number[] | null>(null);
  const id = useId().replaceAll(':', '');
  const [ready, setReady] = useState(false),
    [available, setAvailable] = useState<boolean | null>(
      webGLAvailable ?? null,
    ),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  const [frame, setFrame] = useState<ScreenFrame | null>(null),
    [size, setSize] = useState({ width: 800, height: 460 }),
    [pendingBounds, setPendingBounds] = useState<WorkspaceBounds | null>(null);
  const [hits, setHits] = useState<WorkspaceMapFeatures['features']>([]);
  const verifiedRaster = rasterReports.filter(
    (report) =>
      report.rights.displayAllowed &&
      report.wgs84Bounds &&
      report.products.some(
        (product) =>
          product.readable &&
          product.hashMatches &&
          product.thumbnailUrl &&
          /^\/spatial-workspace-media\/(b03|b8a|scl|tci)-wgs84\.png$/.test(
            product.thumbnailUrl,
          ),
      ),
  );
  const rasters = rasterSettings.enabled
    ? verifiedRaster.flatMap((report) => {
        const product = report.products.find(
          (item) =>
            item.band === rasterSettings.band &&
            item.readable &&
            item.hashMatches &&
            item.thumbnailUrl &&
            /^\/spatial-workspace-media\/(b03|b8a|scl|tci)-wgs84\.png$/.test(
              item.thumbnailUrl,
            ),
        );
        const extent = report.wgs84Bounds;
        if (!product?.thumbnailUrl || !extent) return [];
        const coordinates: [
          [number, number],
          [number, number],
          [number, number],
          [number, number],
        ] = [
          [extent[0], extent[3]],
          [extent[2], extent[3]],
          [extent[2], extent[1]],
          [extent[0], extent[1]],
        ];
        return [{ report, product, coordinates, url: product.thumbnailUrl }];
      })
    : [];
  const [colors, setColors] = useState({
    accent: '#087f8c',
    border: '#95b1b7',
    selected: '#9a6215',
    surface: '#edf5f6',
    kinds: ['#087f8c', '#a94b4b', '#9a6215', '#3f8068', '#95b1b7', '#006a77'],
  });
  useEffect(() => {
    setAvailable(webGLAvailable ?? hasWebGL());
  }, [webGLAvailable]);
  useEffect(() => {
    const update = () => {
      const css = getComputedStyle(document.documentElement),
        value = (token: string, fallback: string) =>
          css.getPropertyValue(token).trim() || fallback;
      setColors({
        accent: value('--accent', '#087f8c'),
        border: value('--border-strong', '#95b1b7'),
        selected: value('--warning-bright', '#9a6215'),
        surface: value('--canvas', '#edf5f6'),
        kinds: [
          '--accent',
          '--danger',
          '--warning',
          '--success',
          '--border-strong',
          '--accent-strong',
        ].map((token) => value(token, '#087f8c')),
      });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (width) setSize({ width, height: 460 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setHits((current) =>
      current.filter((hit) =>
        features.features.some((feature) => feature.id === hit.id),
      ),
    );
  }, [features]);
  useEffect(() => {
    if (!ready || failed || !available) return;
    const native = map.current?.getMap();
    if (!native) return;
    const layerId = `workspace-camera-${id}`;
    let scheduled = 0,
      disposed = false,
      last = '';
    const custom: maplibre.CustomLayerInterface = {
      id: layerId,
      type: 'custom',
      renderingMode: '3d',
      render(_gl, options) {
        const canvas = native.getCanvas(),
          matrix = Array.from(options.defaultProjectionData.mainMatrix),
          width = canvas.clientWidth,
          height = canvas.clientHeight;
        const signature = `${width}:${height}:${matrix.join(',')}`;
        if (disposed || !width || !height || signature === last) return;
        last = signature;
        if (scheduled) cancelAnimationFrame(scheduled);
        scheduled = requestAnimationFrame(() => {
          if (!disposed) setFrame({ matrix, width, height });
        });
      },
    };
    native.addLayer(custom);
    native.triggerRepaint();
    const canvas = native.getCanvas(),
      lost = (event: Event) => {
        event.preventDefault();
        setFailed(true);
        setReady(false);
        setFrame(null);
      };
    canvas.addEventListener?.('webglcontextlost', lost);
    return () => {
      disposed = true;
      if (scheduled) cancelAnimationFrame(scheduled);
      canvas.removeEventListener?.('webglcontextlost', lost);
      if (native.getLayer(layerId)) native.removeLayer(layerId);
    };
  }, [ready, failed, available, id, retry]);

  const colorExpression = useMemo<maplibre.ExpressionSpecification>(
    () => [
      'match',
      ['get', 'kind'],
      'observation',
      colors.kinds[0],
      'event',
      colors.kinds[1],
      'policy',
      colors.kinds[2],
      'research',
      colors.kinds[3],
      'spatial',
      colors.kinds[4],
      'raster',
      colors.kinds[5],
      colors.accent,
    ],
    [colors],
  );
  const selectedFilter: maplibre.ExpressionSpecification = selection
    ? [
        'all',
        ['==', ['get', 'recordId'], selection.recordId],
        ['==', ['get', 'positionId'], selection.positionId ?? ''],
      ]
    : ['==', ['get', 'recordId'], ''];
  const projected = useMemo(() => {
    if (!frame || !ready || mode !== '3d') return [];
    const grouped = new Set<string>();
    return features.features.flatMap((feature) => {
      const selected =
        selection?.recordId === feature.properties.recordId &&
        selection.positionId === feature.properties.positionId;
      if (
        camera.zoom < 6.5 &&
        grouped.has(feature.properties.kind) &&
        !selected
      )
        return [];
      grouped.add(feature.properties.kind);
      const anchor = workspaceGeometryAnchor(feature.geometry);
      if (!anchor) return [];
      const base = maplibre.MercatorCoordinate.fromLngLat(anchor),
        categoryIndex = workspaceRecordKinds.indexOf(feature.properties.kind);
      // Category spacing is a drawing convention, never an elevation claim.
      const category = maplibre.MercatorCoordinate.fromLngLat(
        anchor,
        (categoryIndex + 1) * 6000,
      );
      const ground = projectWorkspaceCoordinate(
          frame.matrix,
          [base.x, base.y, base.z],
          frame.width,
          frame.height,
        ),
        card = projectWorkspaceCoordinate(
          frame.matrix,
          [category.x, category.y, category.z],
          frame.width,
          frame.height,
        );
      if (
        !ground ||
        !card ||
        card.x < -100 ||
        card.x > frame.width + 100 ||
        card.y < -50 ||
        card.y > frame.height + 50
      )
        return [];
      const expected = map.current?.getMap().project(anchor);
      const error = expected
        ? Math.hypot(ground.x - expected.x, ground.y - expected.y)
        : null;
      return [{ feature, ground, card, selected, error }];
    });
  }, [frame, features, ready, mode, selection, camera.zoom]);
  const planar = planarProjection(camera, size.width, size.height);
  const finishDraw = (point: number[]) => {
    if (!drawStart.current) return;
    const result = rectangle(drawStart.current, point);
    drawStart.current = null;
    setPendingBounds(null);
    if (result[0] !== result[2] && result[1] !== result[3]) onBounds?.(result);
  };
  const changeCamera = (change: Partial<WorkspaceCamera>) =>
    onCamera({ ...camera, ...change });
  const pan = 360 / 2 ** camera.zoom / 4;
  const choose = (feature: WorkspaceMapFeatures['features'][number]) => {
    onSelect({
      recordId: feature.properties.recordId,
      positionId: feature.properties.positionId,
    });
    setHits([]);
  };
  const flat = !available || failed;
  return (
    <div className={styles.mapPanel}>
      <div className={styles.mapToolbar} aria-label={copy.mapTitle}>
        {(
          [
            [
              copy.zoomIn,
              () => changeCamera({ zoom: Math.min(16, camera.zoom + 0.5) }),
            ],
            [
              copy.zoomOut,
              () => changeCamera({ zoom: Math.max(3, camera.zoom - 0.5) }),
            ],
            [
              copy.rotateLeft,
              () =>
                changeCamera({
                  bearing: ((camera.bearing - 15 + 540) % 360) - 180,
                }),
            ],
            [
              copy.rotateRight,
              () =>
                changeCamera({
                  bearing: ((camera.bearing + 15 + 540) % 360) - 180,
                }),
            ],
            [
              copy.panWest,
              () =>
                changeCamera({
                  longitude: Math.max(-180, camera.longitude - pan),
                }),
            ],
            [
              copy.panEast,
              () =>
                changeCamera({
                  longitude: Math.min(180, camera.longitude + pan),
                }),
            ],
            [
              copy.panNorth,
              () =>
                changeCamera({ latitude: Math.min(80, camera.latitude + pan) }),
            ],
            [
              copy.panSouth,
              () =>
                changeCamera({
                  latitude: Math.max(-80, camera.latitude - pan),
                }),
            ],
          ] as [string, () => void][]
        ).map(([label, action]) => (
          <button type="button" key={label} onClick={action}>
            {label}
          </button>
        ))}
        {mode === '3d' && !flat ? (
          <>
            <button
              type="button"
              onClick={() =>
                changeCamera({ pitch: Math.min(70, camera.pitch + 10) })
              }
            >
              {copy.tiltUp}
            </button>
            <button
              type="button"
              onClick={() =>
                changeCamera({ pitch: Math.max(0, camera.pitch - 10) })
              }
            >
              {copy.tiltDown}
            </button>
          </>
        ) : null}
      </div>
      {verifiedRaster.length ? (
        <div className={styles.rasterControls}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={rasterSettings.enabled}
              onChange={(event) =>
                onRasterChange?.({
                  ...rasterSettings,
                  enabled: event.target.checked,
                })
              }
            />
            {copy.rasterLayer ?? copy.kinds.raster}
          </label>
          <label>
            {copy.rasterBand ?? copy.rasterTitle}
            <select
              value={rasterSettings.band}
              onChange={(event) =>
                onRasterChange?.({
                  ...rasterSettings,
                  band: event.target.value as WorkspaceRasterSettings['band'],
                })
              }
            >
              {(['TCI', 'B03', 'B8A', 'SCL'] as const)
                .filter((band) =>
                  verifiedRaster.some((report) =>
                    report.products.some(
                      (product) =>
                        product.band === band &&
                        product.readable &&
                        product.hashMatches,
                    ),
                  ),
                )
                .map((band) => (
                  <option key={band} value={band}>
                    {band}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {copy.rasterOpacity ?? copy.value}
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={rasterSettings.opacity}
              onChange={(event) =>
                onRasterChange?.({
                  ...rasterSettings,
                  opacity: Number(event.target.value),
                })
              }
            />
          </label>
          <button
            type="button"
            onClick={() => {
              const extent = verifiedRaster[0]?.wgs84Bounds;
              if (extent)
                changeCamera({
                  longitude: (extent[0] + extent[2]) / 2,
                  latitude: (extent[1] + extent[3]) / 2,
                  zoom: Math.min(
                    12,
                    Math.max(
                      6,
                      8 -
                        Math.log2(
                          Math.max(
                            0.01,
                            extent[2] - extent[0],
                            extent[3] - extent[1],
                          ),
                        ),
                    ),
                  ),
                });
            }}
          >
            {copy.locatePosition} · {copy.kinds.raster}
          </button>
        </div>
      ) : null}
      {flat ? (
        <p role="status">
          {failed ? copy.renderFailed : copy.noWebgl}
          {failed ? (
            <button
              type="button"
              onClick={() => {
                setFailed(false);
                setFrame(null);
                setReady(false);
                setRetry((value) => value + 1);
              }}
            >
              {copy.retryMap}
            </button>
          ) : null}
        </p>
      ) : null}
      <div
        ref={container}
        className={styles.mapCanvas}
        data-testid="spatial-geographic-map"
        data-camera={JSON.stringify(camera)}
        data-renderer={flat ? 'planar' : 'maplibre'}
      >
        {available && !failed ? (
          <Map
            key={retry}
            ref={map}
            mapLib={maplibre}
            mapStyle={offlineStyle}
            {...camera}
            pitch={mode === '2d' ? 0 : camera.pitch}
            style={{ width: '100%', height: 460 }}
            attributionControl={false}
            dragRotate
            pitchWithRotate
            touchPitch={mode === '3d'}
            dragPan={!drawBounds}
            boxZoom={false}
            maxPitch={70}
            minZoom={3}
            maxZoom={16}
            renderWorldCopies={false}
            interactiveLayerIds={interactiveLayers}
            onLoad={() => setReady(true)}
            onError={() => {
              setFailed(true);
              setReady(false);
              setFrame(null);
            }}
            onMove={({ viewState }) =>
              onCamera({
                longitude: viewState.longitude,
                latitude: viewState.latitude,
                zoom: viewState.zoom,
                bearing: viewState.bearing,
                pitch: mode === '2d' ? 0 : viewState.pitch,
              })
            }
            onMouseDown={(event) => {
              if (drawBounds) {
                drawStart.current = [event.lngLat.lng, event.lngLat.lat];
                setPendingBounds(null);
              }
            }}
            onMouseMove={(event) => {
              if (drawBounds && drawStart.current)
                setPendingBounds(
                  rectangle(drawStart.current, [
                    event.lngLat.lng,
                    event.lngLat.lat,
                  ]),
                );
            }}
            onMouseUp={(event) => {
              if (drawBounds) finishDraw([event.lngLat.lng, event.lngLat.lat]);
            }}
            onClick={(event) => {
              if (drawBounds) return;
              const nearby =
                map.current?.queryRenderedFeatures(
                  [
                    [event.point.x - 6, event.point.y - 6],
                    [event.point.x + 6, event.point.y + 6],
                  ],
                  { layers: interactiveLayers },
                ) ?? [];
              const keys = new Set(
                [...(event.features ?? []), ...nearby].map((feature) =>
                  JSON.stringify([
                    feature.properties?.recordId,
                    feature.properties?.positionId,
                  ]),
                ),
              );
              const picked = features.features.filter((feature) =>
                keys.has(
                  JSON.stringify([
                    feature.properties.recordId,
                    feature.properties.positionId,
                  ]),
                ),
              );
              if (picked.length === 1) choose(picked[0]);
              else setHits(picked);
            }}
          >
            <Source id="workspace-grid" type="geojson" data={grid}>
              <Layer
                id="workspace-graticule"
                type="line"
                paint={{
                  'line-color': colors.border,
                  'line-width': 0.6,
                  'line-opacity': 0.35,
                }}
              />
            </Source>
            {rasters.map((raster) => (
              <Source
                key={`${raster.report.id}:${raster.product.band}`}
                id={`workspace-image-${raster.report.id}-${raster.product.band}`}
                type="image"
                url={raster.url}
                coordinates={raster.coordinates}
              >
                <Layer
                  id={`workspace-raster-${raster.report.id}-${raster.product.band}`}
                  type="raster"
                  paint={{
                    'raster-opacity': rasterSettings.opacity,
                    'raster-resampling':
                      raster.product.band === 'SCL' ? 'nearest' : 'linear',
                    'raster-fade-duration': 0,
                  }}
                />
              </Source>
            ))}
            <Source id="workspace-records" type="geojson" data={features}>
              <Layer
                id="workspace-areas"
                type="fill"
                filter={['==', ['geometry-type'], 'Polygon']}
                paint={{ 'fill-color': colorExpression, 'fill-opacity': 0.15 }}
              />
              <Layer
                id="workspace-lines"
                type="line"
                filter={['!=', ['geometry-type'], 'Point']}
                paint={{ 'line-color': colorExpression, 'line-width': 2 }}
              />
              <Layer
                id="workspace-points"
                type="circle"
                filter={['==', ['geometry-type'], 'Point']}
                paint={{
                  'circle-color': colorExpression,
                  'circle-radius': 5,
                  'circle-stroke-width': 1,
                  'circle-stroke-color': colors.surface,
                }}
              />
              <Layer
                id="workspace-selected-lines"
                type="line"
                filter={[
                  'all',
                  selectedFilter,
                  ['!=', ['geometry-type'], 'Point'],
                ]}
                paint={{ 'line-color': colors.selected, 'line-width': 4 }}
              />
              <Layer
                id="workspace-selected-points"
                type="circle"
                filter={[
                  'all',
                  selectedFilter,
                  ['==', ['geometry-type'], 'Point'],
                ]}
                paint={{ 'circle-color': colors.selected, 'circle-radius': 8 }}
              />
            </Source>
            <Source
              id="workspace-bounds"
              type="geojson"
              data={area(pendingBounds ?? bounds)}
            >
              <Layer
                id="workspace-bounds-line"
                type="line"
                paint={{
                  'line-color': colors.selected,
                  'line-width': 2,
                  'line-dasharray': [3, 2],
                }}
              />
            </Source>
          </Map>
        ) : (
          <svg
            width="100%"
            height="460"
            viewBox={`0 0 ${size.width} ${size.height}`}
            aria-label={copy.planarView}
            className={styles.planar}
            onPointerDown={(event) => {
              if (!drawBounds) return;
              const box = event.currentTarget.getBoundingClientRect(),
                point = planar.unproject(
                  ((event.clientX - box.left) * size.width) /
                    (box.width || size.width),
                  ((event.clientY - box.top) * 460) / (box.height || 460),
                );
              drawStart.current = point;
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!drawBounds || !drawStart.current) return;
              const box = event.currentTarget.getBoundingClientRect();
              setPendingBounds(
                rectangle(
                  drawStart.current,
                  planar.unproject(
                    ((event.clientX - box.left) * size.width) /
                      (box.width || size.width),
                    ((event.clientY - box.top) * 460) / (box.height || 460),
                  ),
                ),
              );
            }}
            onPointerUp={(event) => {
              if (!drawBounds) return;
              const box = event.currentTarget.getBoundingClientRect();
              finishDraw(
                planar.unproject(
                  ((event.clientX - box.left) * size.width) /
                    (box.width || size.width),
                  ((event.clientY - box.top) * 460) / (box.height || 460),
                ),
              );
            }}
          >
            {grid.features.flatMap((feature, i) =>
              feature.geometry
                ? geometryPaths(feature.geometry, planar.project).map(
                    ({ path }, j) => (
                      <path
                        key={`grid-${i}-${j}`}
                        d={path}
                        fill="none"
                        stroke={colors.border}
                        strokeOpacity="0.3"
                      />
                    ),
                  )
                : [],
            )}
            {rasters.map((raster) => {
              const topLeft = planar.project(raster.coordinates[0]),
                topRight = planar.project(raster.coordinates[1]),
                bottomLeft = planar.project(raster.coordinates[3]);
              return (
                <image
                  key={`${raster.report.id}:${raster.product.band}`}
                  href={raster.url}
                  x="0"
                  y="0"
                  width="1000"
                  height="1000"
                  preserveAspectRatio="none"
                  opacity={rasterSettings.opacity}
                  pointerEvents="none"
                  transform={`matrix(${screenCoordinate((topRight[0] - topLeft[0]) / 1000, 6)} ${screenCoordinate((topRight[1] - topLeft[1]) / 1000, 6)} ${screenCoordinate((bottomLeft[0] - topLeft[0]) / 1000, 6)} ${screenCoordinate((bottomLeft[1] - topLeft[1]) / 1000, 6)} ${screenCoordinate(topLeft[0])} ${screenCoordinate(topLeft[1])})`}
                />
              );
            })}
            {features.features.map((feature) => (
              <g
                key={feature.id}
                role="button"
                tabIndex={0}
                aria-label={`${feature.properties.label} · ${copy.kinds[feature.properties.kind]} · ${feature.properties.positionId}`}
                data-planar-geometry={feature.id}
                onClick={() => {
                  if (!drawBounds) choose(feature);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    choose(feature);
                  }
                }}
              >
                <title>{`${feature.properties.label} · ${feature.properties.sourceId} · ${feature.properties.versionId}`}</title>
                {geometryPaths(feature.geometry, planar.project).map(
                  ({ path, fill }, index) => (
                    <path
                      key={index}
                      d={path}
                      fill={
                        fill
                          ? colors.kinds[
                              workspaceRecordKinds.indexOf(
                                feature.properties.kind,
                              )
                            ]
                          : 'none'
                      }
                      fillOpacity="0.2"
                      fillRule="evenodd"
                      stroke={
                        selection?.recordId === feature.properties.recordId &&
                        selection.positionId === feature.properties.positionId
                          ? colors.selected
                          : colors.kinds[
                              workspaceRecordKinds.indexOf(
                                feature.properties.kind,
                              )
                            ]
                      }
                      strokeWidth={
                        selection?.recordId === feature.properties.recordId &&
                        selection.positionId === feature.properties.positionId
                          ? 4
                          : 2
                      }
                    />
                  ),
                )}
              </g>
            ))}
            {area(pendingBounds ?? bounds).features.flatMap((feature) =>
              feature.geometry
                ? geometryPaths(feature.geometry, planar.project).map(
                    ({ path }, i) => (
                      <path
                        key={i}
                        d={path}
                        fill="none"
                        stroke={colors.selected}
                        strokeWidth="2"
                        strokeDasharray="6 4"
                      />
                    ),
                  )
                : [],
            )}
          </svg>
        )}
        {!flat && frame && mode === '3d' ? (
          <>
            <svg
              aria-hidden="true"
              className={styles.anchorOverlay}
              width="100%"
              height="460"
              viewBox={`0 0 ${frame.width} ${frame.height}`}
            >
              {projected.map(({ feature, ground, card, error }) => (
                <line
                  key={feature.id}
                  x1={screenCoordinate(ground.x)}
                  y1={screenCoordinate(ground.y)}
                  x2={screenCoordinate(card.x)}
                  y2={screenCoordinate(card.y)}
                  stroke={
                    colors.kinds[
                      workspaceRecordKinds.indexOf(feature.properties.kind)
                    ]
                  }
                  strokeDasharray="3 3"
                  data-ground-anchor-error={error ?? undefined}
                  data-record-id={feature.properties.recordId}
                />
              ))}
            </svg>
            {projected.map(({ feature, card, selected }) => (
              <button
                type="button"
                key={feature.id}
                className={styles.evidenceMarker}
                style={{
                  left: `${(card.x / frame.width) * 100}%`,
                  top: `${(card.y / frame.height) * 100}%`,
                }}
                aria-pressed={selected}
                onClick={() => choose(feature)}
                title={`${feature.properties.label} · ${feature.properties.sourceId} · ${feature.properties.versionId}`}
              >
                {copy.kinds[feature.properties.kind]} ·{' '}
                {feature.properties.label}
              </button>
            ))}
          </>
        ) : null}
        <span className={styles.mapReference}>
          {copy.offlineReference} · WGS84
          <br />
          {camera.longitude.toFixed(3)}° E · {camera.latitude.toFixed(3)}° N
        </span>
      </div>
      {hits.length > 1 ? (
        <div
          className={styles.overlapPicker}
          role="group"
          aria-label={copy.overlapPick}
        >
          <p>{copy.overlapPick}</p>
          {hits.map((feature) => (
            <button
              type="button"
              key={feature.id}
              onClick={() => choose(feature)}
            >
              {feature.properties.label} · {feature.properties.sourceId} ·{' '}
              {feature.properties.versionId} · {feature.properties.positionId}
            </button>
          ))}
        </div>
      ) : null}
      {mode === '3d' && !flat ? (
        <p className={styles.hint}>{copy.categoryHeightHint}</p>
      ) : null}
      {mode === '3d' &&
      camera.zoom < 6.5 &&
      features.features.length > projected.length &&
      !flat ? (
        <p className={styles.hint}>
          {copy.aggregationSummary.replace(
            '{count}',
            String(features.features.length - projected.length),
          )}
        </p>
      ) : null}
      <p className={styles.hint}>
        {copy.referenceHint} {copy.smallScaleHint}
      </p>
    </div>
  );
}
