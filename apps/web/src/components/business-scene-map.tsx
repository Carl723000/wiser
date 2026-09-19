'use client';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibre from 'maplibre-gl';
import Map, { Source, Layer, type MapRef } from 'react-map-gl/maplibre';
import { useEffect, useMemo, useRef, useState, useId } from 'react';
import type { FeatureCollection } from 'geojson';
import { ExplorationResultSchema } from '@wiser/data-contracts';
import { loadBusinessMap, businessMapBounds } from '@/lib/business-map';
import { spatialSceneAnchors } from '@/lib/business-scene-spatial';
import type { BusinessScene } from '@/lib/business-scene';
import type { SceneView } from '@/lib/business-scene-view';
import { getDictionary, type Locale } from '@/lib/i18n';
import {
  invalidatesExploration,
  type InvalidateExploration,
} from '@/lib/exploration-request';
import { AmapBasemap, type AmapBasemapHandle } from './amap-basemap';
import styles from './business-scene-canvas.module.css';
maplibre.setWorkerUrl('/vendor/maplibre/6.8.0/maplibre-gl-worker.mjs');
const mapStyle: maplibre.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [],
};
export function BusinessSceneMap({
  scene,
  queryId,
  locale,
  onInvalidated,
  width,
  settings,
  onSettings,
  focus,
  onSelect,
  onEdge,
  selectedId,
}: {
  scene: BusinessScene;
  queryId: string;
  locale: Locale;
  onInvalidated: InvalidateExploration;
  width: number;
  settings: SceneView;
  onSettings: (s: SceneView) => void;
  focus: { nodes: Set<string>; edges: Set<string> };
  onSelect: (id: string) => void;
  onEdge: (id: string) => void;
  selectedId: string | null;
}) {
  const dictionary = getDictionary(locale).knowledgeRelations;
  const copy = dictionary.scene;
  const [collection, setCollection] = useState<FeatureCollection | null>(null),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0),
    [ready, setReady] = useState(false),
    [revision, setRevision] = useState(0);
  const map = useRef<MapRef>(null),
    basemap = useRef<AmapBasemapHandle>(null),
    fitted = useRef(false),
    integer = useRef(false);
  const [palette, setPalette] = useState({ accent: '', selected: '' });
  const marker = useId().replaceAll(':', '');
  useEffect(() => {
    const update = () => {
      const style = getComputedStyle(document.documentElement);
      setPalette({
        accent: style.getPropertyValue('--accent').trim(),
        selected: style.getPropertyValue('--warning-bright').trim(),
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
    const controller = new AbortController();
    setCollection(null);
    setFailed(false);
    fitted.current = false;
    const request = async (after?: string) => {
      controller.signal.throwIfAborted();
      const response = await fetch('/api/data-foundation/explore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queryId,
          view: 'map',
          first: 200,
          ...(after ? { after } : {}),
        }),
        signal: controller.signal,
        cache: 'no-store',
      });
      controller.signal.throwIfAborted();
      if (!response.ok) {
        if (invalidatesExploration(response.status))
          onInvalidated(queryId, response.status);
        throw Error('Unavailable');
      }
      const body: unknown = await response.json();
      controller.signal.throwIfAborted();
      const value = ExplorationResultSchema.parse(body);
      if (value.queryId !== queryId || value.view !== 'map')
        throw Error('Wrong scope');
      return value;
    };
    void request()
      .then((first) => loadBusinessMap(first, request))
      .then((data) => {
        if (!controller.signal.aborted) setCollection(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCollection(null);
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, [queryId, onInvalidated, retry]);
  const anchors = useMemo(
    () =>
      spatialSceneAnchors(
        scene,
        collection ?? { type: 'FeatureCollection', features: [] },
      ),
    [scene, collection],
  );
  const anchoredGeometry = useMemo<FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: [
        ...new globalThis.Map(
          [...anchors.values()].map((a) => [a.feature.id, a.feature]),
        ).values(),
      ],
    }),
    [anchors],
  );
  const bounds = useMemo(
    () => businessMapBounds(anchoredGeometry),
    [anchoredGeometry],
  );
  const sync = () => {
    const m = map.current;
    if (!m) return;
    basemap.current?.syncCamera({
      longitude: m.getCenter().lng,
      latitude: m.getCenter().lat,
      zoom: m.getZoom(),
      pitch: 0,
      bearing: 0,
    });
    setRevision((v) => v + 1);
  };
  useEffect(() => {
    if (!ready || !collection || fitted.current) return;
    fitted.current = true;
    if (
      bounds &&
      settings.mapLon === 116 &&
      settings.mapLat === 40 &&
      settings.mapZoom === 6
    ) {
      map.current?.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        {
          padding: {
            left: 35,
            right: Math.round(width * 0.45),
            top: 60,
            bottom: 60,
          },
          maxZoom: 11,
          duration: 0,
        },
      );
    }
    sync();
  }, [
    ready,
    collection,
    bounds,
    width,
    settings.mapLon,
    settings.mapLat,
    settings.mapZoom,
  ]);
  const positions = useMemo(() => {
    const result = new globalThis.Map<string, [number, number]>();
    const local = scene.nodes.filter((n) => !anchors.has(n.id));
    const grouped = new globalThis.Map<string, typeof local>();
    for (const node of local) {
      const group = grouped.get(node.group) ?? [];
      group.push(node);
      grouped.set(node.group, group);
    }
    const groupList = [...grouped].sort(([a], [b]) => a.localeCompare(b, 'en'));
    for (const [i, [, nodes]] of groupList.entries()) {
      const x = width * 0.68 + (i % 2) * width * 0.2,
        y = 75 + Math.floor(i / 2) * 61;
      const radius = Math.min(width * 0.075, 23);
      nodes.forEach((n, j) => {
        const angle = j * 2.399963229728653,
          r = radius * Math.sqrt((j + 1) / nodes.length);
        result.set(n.id, [x + Math.cos(angle) * r, y + Math.sin(angle) * r]);
      });
    }
    const located = [...anchors];
    for (const [i, [id, anchor]] of located.entries()) {
      const p = map.current?.project(anchor.labelPoint);
      if (p) {
        const angle = (2 * Math.PI * i) / Math.max(1, located.length);
        result.set(id, [
          p.x + Math.cos(angle) * 90,
          p.y + Math.sin(angle) * 90,
        ]);
      }
    }
    return result;
  }, [scene, anchors, width, revision]);
  const saveCamera = () => {
    const m = map.current;
    if (m)
      onSettings({
        ...settings,
        mapLon: m.getCenter().lng,
        mapLat: m.getCenter().lat,
        mapZoom: m.getZoom(),
      });
  };
  const initial = useRef({
    longitude: settings.mapLon,
    latitude: settings.mapLat,
    zoom: settings.mapZoom,
    bearing: 0,
    pitch: 0,
  });
  const hasFocus = focus.nodes.size > 0;
  return (
    <div
      className={styles.spatial}
      data-testid="business-spatial-scene"
      data-state={failed ? 'failed' : collection ? 'ready' : 'loading'}
      data-anchor-count={anchors.size}
    >
      <div className={styles.toolbar}>
        <button onClick={() => map.current?.zoomIn({ duration: 0 })}>
          {copy.zoomIn}
        </button>
        <button onClick={() => map.current?.zoomOut({ duration: 0 })}>
          {copy.zoomOut}
        </button>
        <button
          onClick={() => {
            if (bounds)
              map.current?.fitBounds(
                [
                  [bounds[0], bounds[1]],
                  [bounds[2], bounds[3]],
                ],
                { padding: 80, maxZoom: 11, duration: 0 },
              );
          }}
        >
          {copy.reset}
        </button>
        <button
          disabled={!selectedId || !anchors.has(selectedId)}
          onClick={() => {
            const a = anchors.get(selectedId!);
            if (a)
              map.current?.jumpTo({
                center: a.labelPoint,
                zoom: Math.max(map.current.getZoom(), 10),
              });
          }}
        >
          {copy.locate}
        </button>
      </div>
      {failed ? (
        <p role="alert">
          {copy.mapFailed}{' '}
          <button onClick={() => setRetry((v) => v + 1)}>{copy.retry}</button>
        </p>
      ) : !collection ? (
        <p role="status">{copy.loading}</p>
      ) : null}
      <div className={styles.spatialCanvas}>
        <AmapBasemap
          ref={basemap}
          locale={locale}
          onIntegerZoom={() => {
            integer.current = true;
            const m = map.current;
            if (m) m.jumpTo({ zoom: Math.round(m.getZoom()) });
          }}
        />
        <Map
          ref={map}
          mapLib={maplibre}
          initialViewState={initial.current}
          mapStyle={mapStyle}
          style={{ width: '100%', height: 650 }}
          dragRotate={false}
          pitchWithRotate={false}
          touchPitch={false}
          onLoad={() => {
            setReady(true);
            sync();
          }}
          onMove={() => {
            if (integer.current && map.current) {
              const z = map.current.getZoom();
              if (z !== Math.round(z)) {
                map.current.jumpTo({ zoom: Math.round(z) });
                return;
              }
            }
            sync();
          }}
          onMoveEnd={saveCamera}
        >
          {collection && palette.accent ? (
            <Source
              id="business-scene-geometries"
              type="geojson"
              data={anchoredGeometry}
            >
              <Layer
                id="business-scene-areas"
                type="fill"
                filter={['==', ['geometry-type'], 'Polygon']}
                paint={{ 'fill-color': palette.accent, 'fill-opacity': 0.08 }}
              />
              <Layer
                id="business-scene-outlines"
                type="line"
                filter={['!=', ['geometry-type'], 'Point']}
                paint={{ 'line-color': palette.accent, 'line-width': 2 }}
              />
              <Layer
                id="business-scene-points"
                type="circle"
                filter={['==', ['geometry-type'], 'Point']}
                paint={{ 'circle-color': palette.accent, 'circle-radius': 5 }}
              />
            </Source>
          ) : null}
        </Map>
        {ready && collection ? (
          <svg
            className={styles.spatialOverlay}
            viewBox={`0 0 ${width} 650`}
            width="100%"
            height={650}
            role="img"
            aria-label={copy.forms.space}
          >
            <defs>
              <marker
                id={marker}
                viewBox="0 0 8 8"
                refX="8"
                refY="4"
                markerWidth="4"
                markerHeight="4"
                orient="auto"
              >
                <path d="M0 0 L8 4 L0 8" fill="var(--accent)" />
              </marker>
            </defs>
            <rect
              x={width * 0.57}
              y={0}
              width={width * 0.43}
              height={650}
              fill="var(--surface)"
              opacity={0.96}
            />
            <text x={width * 0.6} y={28} className={styles.groupLabel}>
              {copy.unlocated}
            </text>
            {[...anchors].map(([id, a]) => {
              const origin = map.current?.project(a.labelPoint),
                position = positions.get(id);
              return origin && position ? (
                <line
                  key={id}
                  x1={origin.x}
                  y1={origin.y}
                  x2={position[0]}
                  y2={position[1]}
                  stroke="var(--text-secondary)"
                  strokeDasharray="3 3"
                />
              ) : null;
            })}
            {scene.edges.map((e) => {
              const a = positions.get(e.from),
                b = positions.get(e.to);
              if (!a || !b) return null;
              const active = focus.edges.has(e.id);
              return (
                <line
                  key={e.id}
                  data-edge-id={e.id}
                  data-highlighted={active}
                  x1={a[0]}
                  y1={a[1]}
                  x2={b[0]}
                  y2={b[1]}
                  stroke={active ? 'var(--warning-bright)' : 'var(--accent)'}
                  strokeWidth={active ? 2.5 : 1}
                  opacity={hasFocus ? (active ? 1 : 0.12) : 0.3}
                  markerEnd={`url(#${marker})`}
                  onClick={() => onEdge(e.id)}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                />
              );
            })}
            {scene.nodes.map((n) => {
              const p = positions.get(n.id);
              if (!p) return null;
              const anchored = anchors.has(n.id),
                active = focus.nodes.has(n.id);
              return (
                <g
                  key={n.id}
                  data-node-id={n.id}
                  data-anchored={anchored}
                  onClick={() => onSelect(n.id)}
                  opacity={hasFocus ? (active ? 1 : 0.25) : 1}
                  style={{ pointerEvents: 'all', cursor: 'pointer' }}
                >
                  <circle
                    cx={p[0]}
                    cy={p[1]}
                    r={anchored ? 7 : 3}
                    fill={
                      n.id === selectedId
                        ? 'var(--warning-bright)'
                        : 'var(--accent)'
                    }
                  />
                  <title>
                    {n.label} · {anchored ? copy.located : copy.unlocated}
                  </title>
                  {anchored || n.id === selectedId ? (
                    <text
                      x={p[0] + 10}
                      y={p[1] - 10}
                      className={styles.nodeLabel}
                    >
                      {n.label.length > 23
                        ? n.label.slice(0, 23) + '…'
                        : n.label}
                    </text>
                  ) : null}
                </g>
              );
            })}{' '}
            {[
              ...new Set(
                scene.nodes
                  .filter((n) => !anchors.has(n.id))
                  .map((n) => n.group),
              ),
            ]
              .sort()
              .map((key, i) => {
                const title =
                  (copy.groups as Record<string, string>)[key] ??
                  (dictionary.kinds as Record<string, string>)[key] ??
                  copy.unclassified;
                return (
                  <text
                    key={key}
                    x={width * 0.6 + (i % 2) * width * 0.2}
                    y={42 + Math.floor(i / 2) * 61}
                    className={styles.spatialGroupLabel}
                  >
                    {title}
                  </text>
                );
              })}
          </svg>
        ) : null}
      </div>
      <p className={styles.hint}>
        {copy.located} · {anchors.size} / {scene.nodes.length} · {copy.mapHint}
      </p>
      {collection && !anchors.size ? <p>{copy.mapEmpty}</p> : null}
    </div>
  );
}
