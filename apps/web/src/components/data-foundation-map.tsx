'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import {
  setWorkerUrl,
  Map as MapLibreMap,
  NavigationControl,
  type StyleSpecification,
  type FilterSpecification,
} from 'maplibre-gl';
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react';

import type {
  MapFeatureCollectionDto,
  StacExtentDto,
} from '@/lib/data-foundation';

import type { Geometry } from 'geojson';
import type { PublicReferenceInput } from '@/lib/spatial-public-reference.server';
import {
  publicReferenceKinds,
  type PublicReferenceVisibility,
} from '@/lib/spatial-public-reference';
import styles from './data-foundation-map.module.css';
import { requireIntegerMapZoom } from '@/lib/map-integer-zoom';
import { DataRasterDisplay } from './data-raster-display';
import { rasterDisplayUrl, type RasterDisplay } from '@/lib/raster-display';
import { AmapBasemap, type AmapBasemapHandle } from './amap-basemap';
import {
  amapCoordinates,
  toAmap,
  type MapCoordinateSystem,
} from '@/lib/amap-coordinates';
import { getDictionary, type Locale } from '@/lib/i18n';
import { registerAmapRaster } from '@/lib/amap-raster-protocol';
import { mapDisplayBounds } from '@/lib/data-foundation-map-bounds';
import type { CandidateDisplayFeatures } from '@/lib/ingestion-candidate-reader';
import {
  authorityCamera,
  displayCamera,
  supportedReadingCamera,
  type MapCamera,
} from '@/lib/amap-camera';
import { createCandidateMapCameraController } from '@/lib/candidate-map-controlled-camera';

setWorkerUrl('/vendor/maplibre/6.11.2/maplibre-gl-worker.mjs');

type Position = [number, number, ...number[]];
export interface DataFoundationMapReadingHandle {
  camera: () => MapCamera | undefined;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid map geometry.');
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Invalid map geometry.');
  }
  return value;
}

function position(value: unknown): Position {
  const values = array(value);
  const first = values[0];
  const second = values[1];
  if (first === undefined || second === undefined) {
    throw new TypeError('Invalid map geometry.');
  }
  return [number(first), number(second), ...values.slice(2).map(number)];
}

function positions(value: unknown): Position[] {
  return array(value).map(position);
}

function rings(value: unknown): Position[][] {
  return array(value).map(positions);
}

function polygons(value: unknown): Position[][][] {
  return array(value).map(rings);
}

function geoJsonData(
  features: MapFeatureCollectionDto | CandidateDisplayFeatures,
  crs: MapCoordinateSystem,
) {
  return {
    type: 'FeatureCollection' as const,
    features: features.features.map((feature) => {
      const coordinates = amapCoordinates(feature.geometry.coordinates, crs);
      const geometry = (() => {
        switch (feature.geometry.type) {
          case 'Point':
            return {
              type: 'Point' as const,
              coordinates: position(coordinates),
            };
          case 'MultiPoint':
          case 'LineString':
            return {
              type: feature.geometry.type,
              coordinates: positions(coordinates),
            };
          case 'MultiLineString':
          case 'Polygon':
            return {
              type: feature.geometry.type,
              coordinates: rings(coordinates),
            };
          case 'MultiPolygon':
            return {
              type: 'MultiPolygon' as const,
              coordinates: polygons(coordinates),
            };
        }
      })();
      return {
        type: 'Feature' as const,
        id: feature.id,
        geometry,
        properties: feature.properties,
      };
    }),
  };
}

function stacData(extents: readonly StacExtentDto[]) {
  return {
    type: 'FeatureCollection' as const,
    features: extents.map((extent) => {
      const [minimumX, minimumY, maximumX, maximumY] = extent.bbox;
      return {
        type: 'Feature' as const,
        id: extent.itemId,
        properties: {
          versionId: extent.versionId,
          dataItemId: extent.dataItemId,
        },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              toAmap([minimumX, minimumY]),
              toAmap([maximumX, minimumY]),
              toAmap([maximumX, maximumY]),
              toAmap([minimumX, maximumY]),
              toAmap([minimumX, minimumY]),
            ],
          ],
        },
      };
    }),
  };
}

type MapLayer = 'authority' | 'stac' | 'vector' | 'raster';

interface MapLayerLabels {
  readonly layersLabel: string;
  readonly authorityLayer: string;
  readonly stacLayer: string;
  readonly vectorLayer: string;
  readonly rasterLayer: string;
  readonly selectedVersion: string;
  readonly noSelectedVersion: string;
  readonly displayCrs: string;
  readonly controls: {
    readonly toggleAttribution: string;
    readonly title: string;
    readonly resetBearing: string;
    readonly zoomIn: string;
    readonly zoomOut: string;
    readonly windowsHelp: string;
    readonly macHelp: string;
    readonly mobileHelp: string;
  };
}

export function DataFoundationMap({
  locale,
  ariaLabel,
  displayCrs,
  features,
  labels,
  rasterTileUrl,
  requestedBounds,
  selectedVersion,
  selectedName,
  stacExtents,
  vectorTileUrl,
  onSelectRecord,
  selectedRecordId,
  initialReadingCamera,
  readingCamera,
  readingCameraOwner,
  readingHandle,
  onReadingCamera,
  publicReferences,
  publicReferenceState,
}: {
  readonly locale: Locale;
  readonly ariaLabel: string;
  readonly displayCrs: 'EPSG:4326' | 'EPSG:4490';
  readonly features: MapFeatureCollectionDto | CandidateDisplayFeatures;
  readonly labels: MapLayerLabels;
  readonly rasterTileUrl?: string;
  readonly requestedBounds?: readonly [number, number, number, number];
  readonly selectedVersion?: string;
  readonly selectedName?: string;
  readonly stacExtents: readonly StacExtentDto[];
  readonly vectorTileUrl?: string;
  /** Reading-only callback; no identity or permission is inferred from a map hit. */
  readonly onSelectRecord?: (recordId: string) => void;
  /** Optional drawing focus, restricted to a record in the current collection. */
  readonly selectedRecordId?: string | null;
  /** Authority-coordinate reading state, independent of source geometries. */
  readonly initialReadingCamera?: MapCamera;
  /** Optional controlled authority-coordinate camera; does not recreate the map. */
  readonly readingCamera?: MapCamera;
  /** Caller-owned complete reading identity; replacing it invalidates old gestures. */
  readonly readingCameraOwner?: string;
  /** Capture the existing native reading view before temporarily unmounting it. */
  readonly readingHandle?: Ref<DataFoundationMapReadingHandle>;
  readonly onReadingCamera?: (camera: MapCamera) => void;
} & PublicReferenceInput) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const basemap = useRef<AmapBasemapHandle>(null);
  const onlineEnhancement = useRef<HTMLDivElement>(null);
  const amapCopy = getDictionary(locale).dataFoundation.amap;
  const mapCopy = getDictionary(locale).dataFoundation.mapPage;
  const referenceCopy = getDictionary(locale).dataFoundation.spatialWorkspace;
  const [tilted, setTilted] = useState(
    () =>
      (supportedReadingCamera(readingCamera ?? initialReadingCamera)?.pitch ??
        0) !== 0,
  );
  const [onlineAligned, setOnlineAligned] = useState(
    () =>
      (supportedReadingCamera(readingCamera ?? initialReadingCamera)?.pitch ??
        0) === 0 &&
      (supportedReadingCamera(readingCamera ?? initialReadingCamera)?.bearing ??
        0) === 0,
  );
  const [referenceVisibility, setReferenceVisibility] =
    useState<PublicReferenceVisibility>({
      administrative: true,
      watercourse: true,
      'reference-reach': true,
      'reference-anchor': true,
    });
  const rasterCopy = getDictionary(locale).rasterDisplay;
  const rasterRef = useRef<ReturnType<typeof registerAmapRaster> | null>(null);
  const displayRef = useRef<RasterDisplay | null>(null);
  const sourceTemplate = useRef(rasterTileUrl);
  const [rasterState, setRasterState] = useState<
    'loading' | 'ready' | 'failed'
  >('loading');
  const rasterFailed = useRef(false);
  const [integerZoom, setIntegerZoom] = useState(false);
  const integerZoomRef = useRef(false);
  const selectRecordRef = useRef(onSelectRecord);
  selectRecordRef.current = onSelectRecord;
  const readingCameraRef = useRef(readingCamera ?? initialReadingCamera);
  readingCameraRef.current = readingCamera ?? initialReadingCamera;
  const controlledCameraRef = useRef(readingCamera);
  controlledCameraRef.current = readingCamera;
  const readingOwnerRef = useRef(readingCameraOwner);
  readingOwnerRef.current = readingCameraOwner;
  const cameraController = useRef<ReturnType<
    typeof createCandidateMapCameraController
  > | null>(null);
  const reportReadingCameraRef = useRef(onReadingCamera);
  const captureReadingCamera = useRef<(() => MapCamera | undefined) | null>(
    null,
  );
  useImperativeHandle(
    readingHandle,
    () => ({ camera: () => captureReadingCamera.current?.() }),
    [],
  );
  reportReadingCameraRef.current = onReadingCamera;
  const drawingFocusUsed = useRef(false);
  function applyDisplay(display: RasterDisplay | null) {
    displayRef.current = display;
    const map = mapRef.current;
    if (!map || !rasterTileUrl) return;
    const replace = () => {
      if (mapRef.current !== map) return;
      const style = map.getStyle();
      const source = style.sources['governed-raster'];
      const index = style.layers.findIndex(
        (layer) => layer.id === 'governed-raster-layer',
      );
      const layer = style.layers[index];
      if (source?.type !== 'raster' || !layer) return;
      const next = registerAmapRaster(
        rasterDisplayUrl(rasterTileUrl, displayRef.current),
      );
      const previous = rasterRef.current;
      // Detach the old source before stopping its worker, so late failures cannot
      // change the new attempt's state. Other layers and the camera stay intact.
      map.removeLayer(layer.id);
      map.removeSource('governed-raster');
      previous?.dispose();
      rasterRef.current = next;
      rasterFailed.current = false;
      setRasterState('loading');
      map.addSource('governed-raster', { ...source, tiles: [next.url] });
      map.addLayer(layer, style.layers[index + 1]?.id);
    };
    if (map.isStyleLoaded()) replace();
    else map.once('load', replace);
  }

  const [rasterOpacity, setRasterOpacity] = useState(78);
  const [visible, setVisible] = useState<Readonly<Record<MapLayer, boolean>>>(
    () => ({
      authority: true,
      stac: stacExtents.length > 0,
      vector: vectorTileUrl !== undefined,
      raster: rasterTileUrl !== undefined,
    }),
  );

  useEffect(() => {
    if (container.current === null) return;
    const color = (name: string, fallback: string) =>
      getComputedStyle(container.current!).getPropertyValue(name).trim() ||
      fallback;
    if (sourceTemplate.current !== rasterTileUrl) {
      sourceTemplate.current = rasterTileUrl;
      displayRef.current = null;
      rasterFailed.current = false;
      setRasterState('loading');
    }
    const raster = rasterTileUrl
      ? registerAmapRaster(rasterDisplayUrl(rasterTileUrl, displayRef.current))
      : null;
    rasterRef.current = raster;
    const sources: StyleSpecification['sources'] = {
      authority: { type: 'geojson', data: geoJsonData(features, displayCrs) },
    };
    if (publicReferences?.features.length) {
      const transform = (geometry: Geometry): Geometry =>
        geometry.type === 'GeometryCollection'
          ? { ...geometry, geometries: geometry.geometries.map(transform) }
          : ({
              ...geometry,
              coordinates: amapCoordinates(geometry.coordinates, 'EPSG:4326'),
            } as Geometry);
      sources['public-reference'] = {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: publicReferences.features.map((feature) => ({
            ...feature,
            geometry: transform(feature.geometry),
          })),
        },
      };
    }
    if (stacExtents.length > 0) {
      sources['stac-extents'] = {
        type: 'geojson',
        data: stacData(stacExtents),
      };
    }
    if (vectorTileUrl !== undefined) {
      sources['governed-vector'] = {
        type: 'vector',
        tiles: [
          vectorTileUrl.replace(
            '/tiles/vector/versions/',
            '/tiles/vector/amap/versions/',
          ),
        ],
        minzoom: 0,
        maxzoom: 22,
      };
    }
    if (rasterTileUrl !== undefined) {
      sources['governed-raster'] = {
        type: 'raster',
        tiles: [raster!.url],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 22,
      };
    }
    const visibility = (layer: MapLayer) =>
      visible[layer] ? ('visible' as const) : ('none' as const);
    const layers: StyleSpecification['layers'] = [];
    if (publicReferences?.features.length) {
      const referenceLayout = (kind: keyof PublicReferenceVisibility) => ({
        visibility: referenceVisibility[kind]
          ? ('visible' as const)
          : ('none' as const),
      });
      const border = color('--border-strong', '#516d74'),
        accent = color('--accent-bright', '#5cc7d2'),
        warning = color('--warning-bright', '#dfa33e');
      layers.push(
        {
          id: 'public-reference-administrative-fill',
          type: 'fill',
          source: 'public-reference',
          filter: ['==', ['get', 'kind'], 'administrative'],
          layout: referenceLayout('administrative'),
          paint: { 'fill-color': border, 'fill-opacity': 0.08 },
        },
        {
          id: 'public-reference-administrative-line',
          type: 'line',
          source: 'public-reference',
          filter: ['==', ['get', 'kind'], 'administrative'],
          layout: referenceLayout('administrative'),
          paint: {
            'line-color': border,
            'line-width': 1,
            'line-dasharray': [2, 2],
          },
        },
        {
          id: 'public-reference-watercourse',
          type: 'line',
          source: 'public-reference',
          filter: ['==', ['get', 'kind'], 'watercourse'],
          layout: referenceLayout('watercourse'),
          paint: { 'line-color': accent, 'line-width': 1.5 },
        },
        {
          id: 'public-reference-reach',
          type: 'line',
          source: 'public-reference',
          filter: ['==', ['get', 'kind'], 'reference-reach'],
          layout: referenceLayout('reference-reach'),
          paint: {
            'line-color': warning,
            'line-width': 1.5,
            'line-dasharray': [3, 2],
          },
        },
        {
          id: 'public-reference-anchor',
          type: 'circle',
          source: 'public-reference',
          filter: ['==', ['get', 'kind'], 'reference-anchor'],
          layout: referenceLayout('reference-anchor'),
          paint: {
            'circle-radius': 4,
            'circle-color': warning,
            'circle-opacity': 0,
            'circle-stroke-color': warning,
            'circle-stroke-width': 1.5,
          },
        },
      );
    }
    if (rasterTileUrl !== undefined) {
      layers.push({
        id: 'governed-raster-layer',
        type: 'raster',
        source: 'governed-raster',
        layout: { visibility: visibility('raster') },
        paint: { 'raster-opacity': 0.78 },
      });
    }
    if (stacExtents.length > 0) {
      layers.push(
        {
          id: 'stac-extents-fill',
          type: 'fill',
          source: 'stac-extents',
          layout: { visibility: visibility('stac') },
          paint: {
            'fill-color': color('--warning-bright', '#dfa33e'),
            'fill-opacity': 0.08,
          },
        },
        {
          id: 'stac-extents-line',
          type: 'line',
          source: 'stac-extents',
          layout: { visibility: visibility('stac') },
          paint: {
            'line-color': color('--warning-bright', '#dfa33e'),
            'line-width': 2,
            'line-dasharray': [3, 2],
          },
        },
      );
    }
    if (vectorTileUrl !== undefined) {
      layers.push(
        {
          id: 'governed-vector-fill',
          type: 'fill',
          source: 'governed-vector',
          'source-layer': 'authority',
          filter: ['==', ['geometry-type'], 'Polygon'],
          layout: { visibility: visibility('vector') },
          paint: {
            'fill-color': color('--accent-bright', '#5cc7d2'),
            'fill-opacity': 0.18,
          },
        },
        {
          id: 'governed-vector-line',
          type: 'line',
          source: 'governed-vector',
          'source-layer': 'authority',
          layout: { visibility: visibility('vector') },
          paint: {
            'line-color': color('--accent-bright', '#5cc7d2'),
            'line-width': 2.6,
          },
        },
        {
          id: 'governed-vector-point',
          type: 'circle',
          source: 'governed-vector',
          'source-layer': 'authority',
          filter: ['==', ['geometry-type'], 'Point'],
          layout: { visibility: visibility('vector') },
          paint: {
            'circle-color': color('--accent-bright', '#5cc7d2'),
            'circle-radius': 4.5,
          },
        },
      );
    }
    layers.push(
      {
        id: 'authority-polygons',
        type: 'fill',
        source: 'authority',
        filter: ['==', ['geometry-type'], 'Polygon'],
        layout: { visibility: visibility('authority') },
        paint: {
          'fill-color': color('--accent-fill', '#087886'),
          'fill-opacity': 0.28,
        },
      },
      {
        id: 'authority-lines',
        type: 'line',
        source: 'authority',
        filter: [
          'in',
          ['geometry-type'],
          ['literal', ['LineString', 'Polygon']],
        ],
        layout: { visibility: visibility('authority') },
        paint: {
          'line-color': color('--accent-bright', '#5cc7d2'),
          'line-opacity': 0.92,
          'line-width': 2.1,
        },
      },
      {
        id: 'authority-points',
        type: 'circle',
        source: 'authority',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { visibility: visibility('authority') },
        paint: {
          'circle-color': color('--warning-bright', '#dfa33e'),
          'circle-radius': 5,
          'circle-stroke-color': color('--text-on-strong', '#eff9fa'),
          'circle-stroke-width': 1.5,
        },
      },
      {
        id: 'reader-selected-area',
        type: 'fill',
        source: 'authority',
        filter: ['literal', false],
        layout: { visibility: visibility('authority') },
        paint: {
          'fill-color': color('--warning-bright', '#dfa33e'),
          'fill-opacity': 0.4,
        },
      },
      {
        id: 'reader-selected-line',
        type: 'line',
        source: 'authority',
        filter: ['literal', false],
        layout: { visibility: visibility('authority') },
        paint: {
          'line-color': color('--warning-bright', '#dfa33e'),
          'line-width': 4.2,
        },
      },
      {
        id: 'reader-selected-point',
        type: 'circle',
        source: 'authority',
        filter: ['literal', false],
        layout: { visibility: visibility('authority') },
        paint: {
          'circle-color': color('--warning-bright', '#dfa33e'),
          'circle-radius': 8,
          'circle-stroke-color': color('--text-on-strong', '#eff9fa'),
          'circle-stroke-width': 2,
        },
      },
    );
    const style: StyleSpecification = { version: 8, sources, layers };
    const restoredCamera = supportedReadingCamera(readingCameraRef.current);
    const restoredDisplay = restoredCamera && displayCamera(restoredCamera);
    setTilted((restoredDisplay?.pitch ?? 0) !== 0);
    setOnlineAligned(
      (restoredDisplay?.pitch ?? 0) === 0 &&
        (restoredDisplay?.bearing ?? 0) === 0,
    );
    const map = new MapLibreMap({
      container: container.current,
      style,
      center: restoredDisplay
        ? [restoredDisplay.longitude, restoredDisplay.latitude]
        : [105, 35],
      zoom: restoredDisplay?.zoom ?? 2.3,
      minZoom: 1,
      maxZoom: 21,
      bearing: restoredDisplay?.bearing ?? 0,
      pitch: restoredDisplay?.pitch ?? 0,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 85,
      attributionControl: false,
      cooperativeGestures: true,
      locale: {
        'AttributionControl.ToggleAttribution':
          labels.controls.toggleAttribution,
        'Map.Title': labels.controls.title,
        'NavigationControl.ResetBearing': labels.controls.resetBearing,
        'NavigationControl.ZoomIn': labels.controls.zoomIn,
        'NavigationControl.ZoomOut': labels.controls.zoomOut,
        'CooperativeGesturesHandler.WindowsHelpText':
          labels.controls.windowsHelp,
        'CooperativeGesturesHandler.MacHelpText': labels.controls.macHelp,
        'CooperativeGesturesHandler.MobileHelpText': labels.controls.mobileHelp,
      },
    });
    mapRef.current = map;
    const readCamera = () => {
      const center = map.getCenter();
      return authorityCamera({
        longitude: center.lng,
        latitude: center.lat,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      });
    };
    const capture = () => (mapRef.current === map ? readCamera() : undefined);
    captureReadingCamera.current = capture;
    const controller = createCandidateMapCameraController({
      current: () => mapRef.current === map,
      read: readCamera,
      jump: (camera, data) => {
        const display = displayCamera(camera);
        // Suspend the planar enhancement before MapLibre emits its first frame.
        if (
          (display.pitch !== 0 || display.bearing !== 0) &&
          onlineEnhancement.current
        )
          onlineEnhancement.current.hidden = true;
        map.jumpTo(
          {
            center: [display.longitude, display.latitude],
            zoom: display.zoom,
            bearing: display.bearing,
            pitch: display.pitch,
          },
          data,
        );
      },
      scrollZooming: () => map.scrollZoom.isZooming(),
      report: (camera) => reportReadingCameraRef.current?.(camera),
    });
    cameraController.current = controller;
    controller.setControlled(
      controlledCameraRef.current,
      readingOwnerRef.current,
    );
    const inputTypes = [
      'wheel',
      'keydown',
      'click',
      'dblclick',
      'mousedown',
      'mouseup',
      'mousemove',
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
    ] as const;
    const captureInput = (event: Event) => {
      const target = event.target;
      controller.input(
        event,
        target instanceof Node && container.current?.contains(target) === true,
      );
    };
    // Capture precedes native handlers; document also covers drag releases
    // outside the canvas. Each instance keeps its own input qualifications.
    for (const type of inputTypes)
      document.addEventListener(type, captureInput, true);
    const members = new Set(
      features.features.flatMap((feature) =>
        'recordId' in feature.properties &&
        typeof feature.properties.recordId === 'string'
          ? [feature.properties.recordId.toLowerCase()]
          : [],
      ),
    );
    map.on('click', (event) => {
      if (
        mapRef.current !== map ||
        !selectRecordRef.current ||
        members.size === 0
      )
        return;
      const hit = map
        .queryRenderedFeatures(event.point, {
          layers: ['authority-polygons', 'authority-lines', 'authority-points'],
        })
        .find(
          (feature) =>
            typeof feature.properties['recordId'] === 'string' &&
            members.has(String(feature.properties['recordId']).toLowerCase()),
        );
      const id: unknown = hit?.properties['recordId'];
      if (typeof id === 'string') selectRecordRef.current?.(id);
    });
    if (integerZoomRef.current) requireIntegerMapZoom(map);
    map.on('error', (event) => {
      if ('sourceId' in event && event.sourceId === 'governed-raster') {
        rasterFailed.current = true;
        setRasterState('failed');
      }
    });
    map.on('sourcedata', (event) => {
      if (event.sourceId === 'governed-raster' && !rasterFailed.current)
        setRasterState(event.isSourceLoaded ? 'ready' : 'loading');
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    const suspendOnline = () => {
      if (mapRef.current !== map) return;
      // Native animated camera input may precede React's next commit. Hide its
      // planar enhancement immediately, before the next rendered camera frame.
      if (onlineEnhancement.current) onlineEnhancement.current.hidden = true;
      setOnlineAligned(false);
    };
    const sync = () => {
      if (mapRef.current !== map) return;
      const pitch = map.getPitch();
      const bearing = map.getBearing();
      const aligned = pitch === 0 && bearing === 0;
      if (!aligned) suspendOnline();
      setTilted(pitch !== 0);
      setOnlineAligned(aligned);
      if (!aligned) return;
      const center = map.getCenter();
      basemap.current?.syncCamera({
        longitude: center.lng,
        latitude: center.lat,
        zoom: map.getZoom(),
        bearing: 0,
        pitch: 0,
      });
      if (basemap.current && onlineEnhancement.current)
        onlineEnhancement.current.hidden = false;
    };
    map.on('rotatestart', suspendOnline);
    map.on('pitchstart', suspendOnline);
    map.on('move', (event) => {
      sync();
      controller.move(event);
    });
    map.on('resize', sync);
    map.on('load', sync);
    map.on('moveend', (event) => {
      if (mapRef.current !== map) return;
      sync();
      controller.end(event);
    });
    map.once('load', () => {
      if (
        mapRef.current !== map ||
        restoredCamera ||
        controller.hasControlledCamera()
      )
        return;
      const bounds = mapDisplayBounds(
        features.features.map((feature) => feature.geometry.coordinates),
        stacExtents.map((extent) => extent.bbox),
        displayCrs,
        requestedBounds,
      );
      if (bounds !== undefined) {
        map.fitBounds([...bounds], { padding: 52, maxZoom: 11, duration: 0 });
      }
    });
    const updateTheme = () => {
      if (!map.loaded()) return;
      const update = (id: string, property: string, value: string) => {
        if (map.getLayer(id) === undefined) return;
        switch (property) {
          case 'background-color':
            map.setPaintProperty(id, 'background-color', value);
            break;
          case 'fill-color':
            map.setPaintProperty(id, 'fill-color', value);
            break;
          case 'line-color':
            map.setPaintProperty(id, 'line-color', value);
            break;
          case 'circle-color':
            map.setPaintProperty(id, 'circle-color', value);
            break;
          case 'circle-stroke-color':
            map.setPaintProperty(id, 'circle-stroke-color', value);
            break;
        }
      };
      update(
        'authority-background',
        'background-color',
        color('--surface-strong', '#071a21'),
      );
      update(
        'public-reference-administrative-fill',
        'fill-color',
        color('--border-strong', '#516d74'),
      );
      update(
        'public-reference-administrative-line',
        'line-color',
        color('--border-strong', '#516d74'),
      );
      update(
        'public-reference-watercourse',
        'line-color',
        color('--accent-bright', '#5cc7d2'),
      );
      update(
        'public-reference-reach',
        'line-color',
        color('--warning-bright', '#dfa33e'),
      );
      update(
        'public-reference-anchor',
        'circle-stroke-color',
        color('--warning-bright', '#dfa33e'),
      );
      update(
        'authority-polygons',
        'fill-color',
        color('--accent-fill', '#087886'),
      );
      update(
        'authority-lines',
        'line-color',
        color('--accent-bright', '#5cc7d2'),
      );
      update(
        'authority-points',
        'circle-color',
        color('--warning-bright', '#dfa33e'),
      );
      update(
        'authority-points',
        'circle-stroke-color',
        color('--text-on-strong', '#eff9fa'),
      );
      update(
        'stac-extents-line',
        'line-color',
        color('--warning-bright', '#dfa33e'),
      );
      update(
        'reader-selected-area',
        'fill-color',
        color('--warning-bright', '#dfa33e'),
      );
      update(
        'reader-selected-line',
        'line-color',
        color('--warning-bright', '#dfa33e'),
      );
      update(
        'reader-selected-point',
        'circle-color',
        color('--warning-bright', '#dfa33e'),
      );
      update(
        'reader-selected-point',
        'circle-stroke-color',
        color('--text-on-strong', '#eff9fa'),
      );
    };
    map.on('load', updateTheme);
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    map.once('remove', () => themeObserver.disconnect());
    return () => {
      controller.dispose();
      for (const type of inputTypes)
        document.removeEventListener(type, captureInput, true);
      if (cameraController.current === controller)
        cameraController.current = null;
      if (captureReadingCamera.current === capture)
        captureReadingCamera.current = null;
      mapRef.current = null;
      map.remove();
      rasterRef.current?.dispose();
      rasterRef.current = null;
    };
  }, [
    features,
    labels.controls,
    rasterTileUrl,
    requestedBounds,
    stacExtents,
    vectorTileUrl,
    displayCrs,
    publicReferences,
  ]);
  useLayoutEffect(() => {
    cameraController.current?.setControlled(readingCamera, readingCameraOwner);
  }, [readingCamera, readingCameraOwner]);
  useEffect(() => {
    const instance = mapRef.current;
    if (!instance) return;
    if (selectedRecordId === undefined && !drawingFocusUsed.current) return;
    drawingFocusUsed.current = true;
    const selected = selectedRecordId?.toLowerCase();
    const member =
      selected &&
      features.features.some(
        (feature) =>
          typeof feature.properties['recordId'] === 'string' &&
          feature.properties['recordId'].toLowerCase() === selected,
      );
    const update = () => {
      for (const [id, kind] of [
        ['reader-selected-area', 'Polygon'],
        ['reader-selected-line', 'LineString'],
        ['reader-selected-point', 'Point'],
      ] as const) {
        const filter: FilterSpecification = member
          ? [
              'all',
              kind === 'LineString'
                ? [
                    'in',
                    ['geometry-type'],
                    ['literal', ['LineString', 'Polygon']],
                  ]
                : ['==', ['geometry-type'], kind],
              [
                '==',
                ['downcase', ['to-string', ['get', 'recordId']]],
                selected,
              ],
            ]
          : ['literal', false];
        if (instance.getLayer(id)) instance.setFilter(id, filter);
      }
    };
    update();
    instance.on('load', update);
    return () => {
      instance.off('load', update);
    };
  }, [features, selectedRecordId]);
  useEffect(() => {
    const instance = mapRef.current;
    if (!instance) return;
    const update = () => {
      for (const [group, ids] of Object.entries({
        authority: [
          'authority-polygons',
          'authority-lines',
          'authority-points',
          'reader-selected-area',
          'reader-selected-line',
          'reader-selected-point',
        ],
        stac: ['stac-extents-fill', 'stac-extents-line'],
        vector: [
          'governed-vector-fill',
          'governed-vector-line',
          'governed-vector-point',
        ],
        raster: ['governed-raster-layer'],
      }))
        for (const id of ids)
          if (instance.getLayer(id))
            instance.setLayoutProperty(
              id,
              'visibility',
              visible[group as MapLayer] ? 'visible' : 'none',
            );
    };
    update();
    instance.on('load', update);
    return () => {
      instance.off('load', update);
    };
  }, [visible]);
  useEffect(() => {
    const instance = mapRef.current;
    if (!instance) return;
    const update = () => {
      if (instance.getLayer('governed-raster-layer'))
        instance.setPaintProperty(
          'governed-raster-layer',
          'raster-opacity',
          rasterOpacity / 100,
        );
    };
    update();
    instance.on('load', update);
    return () => {
      instance.off('load', update);
    };
  }, [rasterOpacity, rasterTileUrl]);

  useEffect(() => {
    const instance = mapRef.current;
    if (!instance) return;
    const update = () => {
      for (const [kind, ids] of Object.entries({
        administrative: [
          'public-reference-administrative-fill',
          'public-reference-administrative-line',
        ],
        watercourse: ['public-reference-watercourse'],
        'reference-reach': ['public-reference-reach'],
        'reference-anchor': ['public-reference-anchor'],
      })) {
        for (const id of ids)
          if (instance.getLayer(id))
            instance.setLayoutProperty(
              id,
              'visibility',
              referenceVisibility[kind as keyof PublicReferenceVisibility]
                ? 'visible'
                : 'none',
            );
      }
    };
    update();
    instance.on('load', update);
    return () => {
      instance.off('load', update);
    };
  }, [publicReferences, referenceVisibility]);
  const changePerspective = (pitch: number) => {
    const map = mapRef.current;
    if (!map) return;
    // Hide the planar SDK before changing pitch; jumpTo has no animation even under reduced motion.
    setTilted(pitch !== 0);
    if ((pitch !== 0 || map.getBearing() !== 0) && onlineEnhancement.current)
      onlineEnhancement.current.hidden = true;
    setOnlineAligned(pitch === 0 && map.getBearing() === 0);
    cameraController.current?.perspective(() => map.jumpTo({ pitch }));
  };

  useLayoutEffect(() => {
    const instance = mapRef.current;
    if (!onlineAligned || !instance || !basemap.current) return;
    const center = instance.getCenter();
    basemap.current.syncCamera({
      longitude: center.lng,
      latitude: center.lat,
      zoom: instance.getZoom(),
      bearing: 0,
      pitch: 0,
    });
    if (onlineEnhancement.current) onlineEnhancement.current.hidden = false;
  }, [onlineAligned]);

  const controls: readonly {
    readonly id: MapLayer;
    readonly label: string;
    readonly available: boolean;
  }[] = [
    { id: 'authority', label: labels.authorityLayer, available: true },
    {
      id: 'stac',
      label: labels.stacLayer,
      available: stacExtents.length > 0,
    },
    {
      id: 'vector',
      label: labels.vectorLayer,
      available: vectorTileUrl !== undefined,
    },
    {
      id: 'raster',
      label: labels.rasterLayer,
      available: rasterTileUrl !== undefined,
    },
  ];

  return (
    <section className={styles.frame}>
      <div className={styles.layerControls} aria-label={labels.layersLabel}>
        <fieldset>
          <legend>{labels.layersLabel}</legend>
          {controls.map((control) => (
            <label key={control.id} data-available={control.available}>
              <input
                type="checkbox"
                checked={control.available && visible[control.id]}
                disabled={!control.available}
                onChange={(event) =>
                  setVisible((current) => ({
                    ...current,
                    [control.id]: event.target.checked,
                  }))
                }
              />
              <span>{control.label}</span>
            </label>
          ))}
        </fieldset>
        <div className={styles.perspectiveControls}>
          <button
            type="button"
            aria-pressed={!tilted}
            onClick={() => changePerspective(0)}
          >
            {referenceCopy.flatView}
          </button>
          <button
            type="button"
            aria-pressed={tilted}
            onClick={() => changePerspective(50)}
          >
            {referenceCopy.spaceView}
          </button>
          {tilted ? <p role="status">{referenceCopy.birdEyePlanar}</p> : null}
          {!onlineAligned ? (
            <p role="status">{referenceCopy.onlineReferencePaused}</p>
          ) : null}
        </div>
        {publicReferences?.features.length ? (
          <fieldset>
            <legend>{referenceCopy.publicReferenceLayers}</legend>
            {publicReferenceKinds.map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={referenceVisibility[kind] ?? false}
                  disabled={
                    !publicReferences.features.some(
                      (feature) => feature.properties.kind === kind,
                    )
                  }
                  onChange={(event) =>
                    setReferenceVisibility((previous) => ({
                      ...previous,
                      [kind]: event.target.checked,
                    }))
                  }
                />
                <span>{referenceCopy.publicReferenceKinds[kind]}</span>
              </label>
            ))}
            <p>{referenceCopy.publicReferenceLimit}</p>
            <details>
              <summary>{referenceCopy.publicReferenceEvidence}</summary>
              {publicReferences.manifest ? (
                <p>
                  {referenceCopy.publicReferenceManifestSummary
                    .replace('{version}', publicReferences.manifest.version)
                    .replace(
                      '{files}',
                      String(publicReferences.manifest.files.length),
                    )
                    .replace(
                      '{total}',
                      String(publicReferences.features.length),
                    )
                    .replace(
                      '{shown}',
                      String(
                        publicReferences.features.filter(
                          (feature) =>
                            referenceVisibility[feature.properties.kind],
                        ).length,
                      ),
                    )}
                </p>
              ) : null}
              {publicReferences.manifest?.files.map((file) => (
                <p key={file.id}>
                  {file.id} · {referenceCopy.publicReferenceManifestFeatures}:{' '}
                  {file.featureCount} · {file.license.attribution}
                  <br />
                  {referenceCopy.publicReferenceFileHash}:{' '}
                  <code>{file.sha256}</code>
                  <br />
                  {referenceCopy.publicReferenceOriginalHash}:{' '}
                  <code>{file.originalSha256.join(', ')}</code>
                </p>
              ))}
              {publicReferences.features.map((feature) => (
                <p key={feature.id}>
                  {feature.properties.label} ·{' '}
                  <a
                    href={feature.properties.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {referenceCopy.publicReferenceSource}
                  </a>
                </p>
              ))}
            </details>
          </fieldset>
        ) : publicReferenceState === 'invalid' ||
          publicReferenceState === 'unavailable' ? (
          <p role="status">{referenceCopy.publicReferenceUnavailable}</p>
        ) : null}
        {rasterTileUrl ? (
          <div className={styles.rasterControls}>
            <label>
              <span>{mapCopy.rasterOpacity}</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={rasterOpacity}
                disabled={!visible.raster}
                onChange={(event) =>
                  setRasterOpacity(Number(event.target.value))
                }
              />
            </label>
            <output>{rasterOpacity}%</output>
            <p>{mapCopy.rasterMeaning}</p>
            {visible.raster ? (
              <p role="status">
                {rasterCopy[rasterState]}{' '}
                {rasterState === 'failed' ? (
                  <button onClick={() => applyDisplay(displayRef.current)}>
                    {rasterCopy.retry}
                  </button>
                ) : null}
              </p>
            ) : null}
            <DataRasterDisplay
              key={rasterTileUrl}
              locale={locale}
              onApply={applyDisplay}
            />
          </div>
        ) : null}
        <dl>
          <div>
            <dt>{labels.selectedVersion}</dt>
            <dd title={selectedVersion}>
              {selectedName ?? labels.noSelectedVersion}
            </dd>
          </div>
          <div>
            <dt>{amapCopy.coordinateLabel}</dt>
            <dd>{amapCopy.aligned}</dd>
          </div>
        </dl>
        {integerZoom ? <p role="status">{rasterCopy.integerZoom}</p> : null}
      </div>
      <div
        className={styles.map}
        role="region"
        aria-label={ariaLabel}
        data-testid="data-foundation-map"
      >
        <div
          ref={onlineEnhancement}
          hidden={!onlineAligned}
          className={styles.onlineEnhancement}
          data-testid="online-map-enhancement"
        >
          {onlineAligned ? (
            <AmapBasemap
              ref={basemap}
              locale={locale}
              onIntegerZoom={() => {
                if (integerZoomRef.current) return;
                integerZoomRef.current = true;
                setIntegerZoom(true);
                if (mapRef.current) requireIntegerMapZoom(mapRef.current);
              }}
            />
          ) : null}
        </div>
        <div ref={container} className={styles.overlay} />
        {publicReferences?.features.some(
          (feature) => referenceVisibility[feature.properties.kind],
        ) ? (
          <div className={styles.referenceAttribution}>
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              {
                publicReferences.features.find(
                  (feature) => referenceVisibility[feature.properties.kind],
                )?.properties.attribution
              }
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
