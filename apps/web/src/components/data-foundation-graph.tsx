'use client';

import type { Graph, IElementEvent } from '@antv/g6';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GraphResultDto } from '@/lib/data-foundation';
import { getDictionary, type Locale } from '@/lib/i18n';
import { visibleGraphLabels } from '@/lib/graph-label-visibility';
import {
  defaultGraphLayoutSettings,
  type GraphLayoutSettings,
} from '@/lib/graph-layout-settings';
import { layoutGraph } from '@/lib/graph-layout';
import styles from './data-foundation-graph.module.css';

export interface CanvasGraphData {
  readonly nodes: readonly {
    entityId: string;
    label: string;
    kind?: string;
    source?: string;
    overviewLabel?: boolean;
  }[];
  readonly edges: readonly {
    edgeId: string;
    fromEntityId: string;
    toEntityId: string;
    label?: string;
  }[];
}

type GraphState = 'loading' | 'ready' | 'unavailable';

export function KnowledgeGraphCanvas({
  result,
  selectedId,
  onSelect,
  locale,
  path,
  reading = false,
  layoutSettings,
  onLayoutSettingsChange,
}: {
  readonly result: CanvasGraphData;
  readonly reading?: boolean;
  readonly layoutSettings?: GraphLayoutSettings;
  readonly onLayoutSettingsChange?: (settings: GraphLayoutSettings) => void;
  readonly path?:
    | {
        readonly nodeIds: readonly string[];
        readonly edgeIds: readonly string[];
      }
    | undefined;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly locale: Locale;
}) {
  const target = useRef<HTMLDivElement>(null);
  const graph = useRef<Graph | null>(null);
  const highlights = useRef<{
    instance: Graph;
    states: Map<string, string[]>;
  } | null>(null);
  const identities = useMemo(
    () => ({
      nodes: new Set(result.nodes.map((node) => node.entityId)),
      edges: new Set(result.edges.map((edge) => edge.edgeId)),
    }),
    [result],
  );
  const pending = useRef<Promise<void>>(Promise.resolve());
  const select = useRef(onSelect);
  select.current = onSelect;
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const refreshLabels = useRef<(() => void) | null>(null);
  const [showRelationLabels, setShowRelationLabels] = useState(false);
  const relationLabels = useRef(false);
  relationLabels.current = showRelationLabels;
  useEffect(() => {
    refreshLabels.current?.();
  }, [showRelationLabels]);
  const [state, setState] = useState<GraphState>('loading');
  const [mode, setMode] = useState<'network' | 'hierarchy'>('network');
  const [direction, setDirection] = useState<'LR' | 'TB'>('LR');
  const settings = layoutSettings ?? defaultGraphLayoutSettings;
  const effectiveMode = reading
    ? 'hierarchy'
    : (layoutSettings?.layout ?? mode);
  const grouping = reading ? 'topology' : settings.grouping;
  const nodeSpacing = reading ? undefined : layoutSettings?.nodeSpacing;
  const groupSpacing = reading ? undefined : layoutSettings?.groupSpacing;
  const previousView = useRef<{
    result: CanvasGraphData;
    mode: string;
    grouping: string;
    direction: string;
    nodeSpacing: number | undefined;
    groupSpacing: number | undefined;
    zoom: number;
  } | null>(null);
  useEffect(() => {
    const container = target.current;
    if (!container) return;
    const measure = () =>
      setDirection(container.clientWidth < 560 ? 'TB' : 'LR');
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const copy = getDictionary(locale).dataFoundation.graphPage;

  useEffect(() => {
    const container = target.current;
    if (container === null) return;
    let disposed = false;
    const prior = previousView.current;
    const retainedZoom =
      prior &&
      prior.result === result &&
      prior.mode === effectiveMode &&
      prior.grouping === grouping &&
      prior.direction === direction &&
      (prior.nodeSpacing !== nodeSpacing || prior.groupSpacing !== groupSpacing)
        ? prior.zoom
        : null;
    const layoutController = new AbortController();
    let instance: Graph | null = null;
    let resize: ResizeObserver | null = null;
    let theme: MutationObserver | null = null;
    let labelFrame = 0;
    const colors = () => {
      const tokens = getComputedStyle(document.documentElement);
      return {
        fill: tokens.getPropertyValue('--accent').trim(),
        stroke: tokens.getPropertyValue('--accent-strong').trim(),
        labelFill: tokens.getPropertyValue('--text-primary').trim(),
        surface: tokens.getPropertyValue('--surface').trim(),
        edge: tokens.getPropertyValue('--border-strong').trim(),
        selected: tokens.getPropertyValue('--warning-bright').trim(),
        source:
          tokens.getPropertyValue('--success-strong').trim() ||
          tokens.getPropertyValue('--accent').trim(),
        evidence:
          tokens.getPropertyValue('--warning').trim() ||
          tokens.getPropertyValue('--accent').trim(),
      };
    };
    const fillFor = (kind: unknown, palette: ReturnType<typeof colors>) =>
      kind === 'RESOURCE' || kind === 'DOCUMENT'
        ? palette.source
        : kind === 'EVIDENCE' || kind === 'CLAIM'
          ? palette.evidence
          : palette.fill;
    const initialize = async () => {
      const {
        Graph: GraphConstructor,
        NodeEvent,
        GraphEvent,
      } = await import('@antv/g6');
      if (disposed) return;
      const positions = new Map(
        (
          await layoutGraph(
            {
              direction,
              mode: effectiveMode,
              reading,
              grouping: layoutSettings ? grouping : undefined,
              nodeSpacing,
              groupSpacing,
              nodes: result.nodes.map((node) => ({
                id: node.entityId,
                kind: node.kind,
                source: node.source,
              })),
              edges: result.edges.map((edge) => ({
                id: edge.edgeId,
                source: edge.fromEntityId,
                target: edge.toEntityId,
              })),
            },
            layoutController.signal,
          )
        ).map((node) => [node.id, node]),
      );
      if (disposed) return;
      const degree = new Map<string, number>();
      for (const edge of result.edges)
        for (const id of [edge.fromEntityId, edge.toEntityId])
          degree.set(id, (degree.get(id) ?? 0) + 1);
      const isolatedEdges = new Set(
        result.edges
          .filter(
            (edge) =>
              degree.get(edge.fromEntityId) === 1 &&
              degree.get(edge.toEntityId) === 1,
          )
          .map((edge) => edge.edgeId),
      );
      let palette = colors();
      const columns = Math.max(1, Math.ceil(Math.sqrt(result.nodes.length)));
      instance = new GraphConstructor({
        container,
        width: container.clientWidth,
        height: container.clientHeight,
        animation: false,
        ...(retainedZoom === null ? { autoFit: 'view' as const } : {}),
        zoomRange: [0.02, reading ? 1.4 : 2],
        padding: reading
          ? [36, 32, 36, 32]
          : [direction === 'TB' ? 120 : 80, 40, 40, 40],
        data: {
          nodes: result.nodes.map((node, index) => ({
            id: node.entityId,
            data: { label: node.label, kind: node.kind },
            style: {
              fill: reading ? palette.surface : fillFor(node.kind, palette),
              x: positions?.get(node.entityId)?.x ?? (index % columns) * 180,
              y:
                positions?.get(node.entityId)?.y ??
                Math.floor(index / columns) * 100,
            },
          })),
          edges: result.edges.map((edge) => ({
            id: edge.edgeId,
            source: edge.fromEntityId,
            target: edge.toEntityId,
            data: { label: edge.label ?? '' },
          })),
        },
        node: {
          type: reading ? 'rect' : 'circle',
          style: {
            size: (node) =>
              reading
                ? [196, 68]
                : typeof node.style?.size === 'number'
                  ? node.style.size
                  : 24,
            fill: (node) =>
              reading ? palette.surface : fillFor(node.data?.['kind'], palette),
            stroke: (node) =>
              reading ? fillFor(node.data?.['kind'], palette) : palette.stroke,
            radius: 10,
            labelPlacement: reading ? 'center' : 'bottom',
            lineWidth: 2,
            labelText: (node) => {
              if (node.style?.labelVisibility === 'hidden') return '';
              const label = node.data?.['label'];
              if (typeof label !== 'string') return '';
              const text = reading ? label.replace(' · ', '\n') : label;
              const limit = reading ? 70 : 36;
              return text.length > limit
                ? `${text.slice(0, limit - 1)}…`
                : text;
            },
            labelFill: () => palette.labelFill,
            labelFontSize: (node) =>
              typeof node.style?.labelFontSize === 'number'
                ? node.style.labelFontSize
                : 12,
            labelLineHeight: (node) =>
              typeof node.style?.labelLineHeight === 'number'
                ? node.style.labelLineHeight
                : 16,
            labelMaxWidth: (node) =>
              typeof node.style?.labelMaxWidth === 'number'
                ? node.style.labelMaxWidth
                : 170,
            labelWordWrap: true,
            labelMaxLines: reading || result.nodes.length <= 14 ? 3 : 2,
          },
          state: {
            selected: { stroke: () => palette.selected, lineWidth: 5 },
            path: { stroke: () => palette.selected, lineWidth: 4 },
          },
        },
        edge: {
          type: reading
            ? direction === 'TB'
              ? 'cubic-vertical'
              : 'cubic-horizontal'
            : 'line',
          state: { path: { stroke: () => palette.selected, lineWidth: 4 } },
          style: {
            stroke: () => palette.edge,
            lineWidth: (edge) =>
              typeof edge.style?.lineWidth === 'number'
                ? edge.style.lineWidth
                : 1.5,
            endArrow: true,
            labelAutoRotate: !reading,
            labelPadding: [3, 6],
            labelBackgroundRadius: 4,
            labelText: (edge) =>
              edge.style?.labelVisibility !== 'hidden' &&
              typeof edge.data?.['label'] === 'string'
                ? edge.data['label']
                : '',
            labelFill: () => palette.labelFill,
            labelFontSize: (edge) =>
              typeof edge.style?.labelFontSize === 'number'
                ? edge.style.labelFontSize
                : 11,
            labelBackground: true,
            labelBackgroundFill: () => palette.surface,
          },
        },
        behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
      });
      const active = instance;
      active.on(NodeEvent.CLICK, (event: IElementEvent) =>
        select.current(event.target.id),
      );
      await active.render();
      if (disposed) return;
      for (const canvas of container.querySelectorAll('canvas')) {
        canvas.tabIndex = -1;
        canvas.setAttribute('aria-hidden', 'true');
      }
      graph.current = active;
      let initialLabelFitPending = true;
      let renderedWidth = container.clientWidth,
        renderedHeight = container.clientHeight;
      const readableLabels = () => {
        cancelAnimationFrame(labelFrame);
        labelFrame = requestAnimationFrame(() => {
          if (disposed) return;
          const zoom = Math.max(0.02, active.getZoom());
          container.parentElement?.setAttribute('data-zoom', String(zoom));
          const detailed = zoom >= 0.65;
          const visible = visibleGraphLabels(
            result.nodes.map((node) => {
              const [x, y] = active.getElementPosition(node.entityId);
              return {
                id: node.entityId,
                x,
                y,
                preferred: Boolean(
                  node.overviewLabel || node.kind === 'RESOURCE',
                ),
              };
            }),
            zoom,
            selection.current,
          );
          active.updateNodeData(
            result.nodes.map((node) => ({
              id: node.entityId,
              style: reading
                ? {
                    size: [196, 68],
                    labelFontSize: 13,
                    labelLineHeight: 18,
                    labelMaxWidth: 174,
                    labelVisibility: 'visible',
                  }
                : {
                    size: Math.min(64, 14 / zoom),
                    labelFontSize: 12 / zoom,
                    labelLineHeight: 16 / zoom,
                    labelMaxWidth: 140 / zoom,
                    labelVisibility: visible.has(node.entityId)
                      ? 'visible'
                      : 'hidden',
                  },
            })),
          );
          active.updateEdgeData(
            result.edges.map((edge) => ({
              id: edge.edgeId,
              style: {
                lineWidth: reading ? 1.2 : 1.2 / zoom,
                labelVisibility: (
                  reading
                    ? relationLabels.current ||
                      Boolean(selection.current) ||
                      isolatedEdges.has(edge.edgeId)
                    : detailed
                )
                  ? 'visible'
                  : 'hidden',
                labelFontSize: reading ? 11 : 10 / zoom,
              },
            })),
          );
          void active
            .draw()
            .then(async () => {
              if (disposed || !initialLabelFitPending) return;
              // Auto-fit preceded screen-space label sizing; include those labels once.
              initialLabelFitPending = false;
              if (retainedZoom !== null) {
                await active.zoomTo(retainedZoom, false);
                await active.fitCenter(false);
              } else await active.fitView(undefined, false);
            })
            .catch(() => {
              if (!disposed) setState('unavailable');
            });
        });
      };
      active.on(GraphEvent.AFTER_TRANSFORM, readableLabels);
      active.on(NodeEvent.DRAG_END, readableLabels);
      refreshLabels.current = readableLabels;
      readableLabels();
      resize = new ResizeObserver(() => {
        if (
          disposed ||
          container.clientWidth === 0 ||
          container.clientHeight === 0 ||
          (container.clientWidth === renderedWidth &&
            container.clientHeight === renderedHeight)
        )
          return;
        pending.current = pending.current
          .then(async () => {
            if (disposed) return;
            renderedWidth = container.clientWidth;
            renderedHeight = container.clientHeight;
            active.resize(renderedWidth, renderedHeight);
            await active.fitView(undefined, false);
          })
          .catch(() => {
            if (!disposed) setState('unavailable');
          });
      });
      resize.observe(container);
      theme = new MutationObserver(() => {
        if (disposed) return;
        palette = colors();
        pending.current = pending.current
          .then(async () => {
            if (disposed) return;
            active.updateNodeData(
              result.nodes.map((node) => ({
                id: node.entityId,
                style: {
                  fill: reading ? palette.surface : fillFor(node.kind, palette),
                  stroke: reading
                    ? fillFor(node.kind, palette)
                    : palette.stroke,
                  labelFill: palette.labelFill,
                },
              })),
            );
            active.updateEdgeData(
              result.edges.map((edge) => ({
                id: edge.edgeId,
                style: { stroke: palette.edge },
              })),
            );
            await active.draw();
          })
          .catch(() => {
            if (!disposed) setState('unavailable');
          });
      });
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      });
      setState('ready');
    };
    const frame = requestAnimationFrame(() => {
      setState('loading');
      pending.current = initialize().catch(() => {
        if (!disposed) setState('unavailable');
      });
    });
    return () => {
      if (instance && graph.current === instance)
        previousView.current = {
          result,
          mode: effectiveMode,
          grouping,
          direction,
          nodeSpacing,
          groupSpacing,
          zoom: instance.getZoom(),
        };
      disposed = true;
      layoutController.abort();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(labelFrame);
      resize?.disconnect();
      theme?.disconnect();
      graph.current = null;
      refreshLabels.current = null;
      if (highlights.current?.instance === instance) highlights.current = null;
      void pending.current.finally(() => instance?.destroy()).catch(() => {});
    };
  }, [
    result,
    effectiveMode,
    direction,
    reading,
    grouping,
    nodeSpacing,
    groupSpacing,
  ]);

  useEffect(() => {
    const active = graph.current;
    if (active === null) return;
    refreshLabels.current?.();
    pending.current = pending.current
      .then(async () => {
        if (graph.current !== active) return;
        const previous =
          highlights.current?.instance === active
            ? highlights.current.states
            : new Map<string, string[]>();
        const next = new Map<string, string[]>();
        for (const id of path?.nodeIds ?? [])
          if (identities.nodes.has(id)) next.set(id, ['path']);
        for (const id of path?.edgeIds ?? [])
          if (identities.edges.has(id)) next.set(id, ['path']);
        if (selectedId && identities.nodes.has(selectedId))
          next.set(selectedId, [...(next.get(selectedId) ?? []), 'selected']);
        const changes: Record<string, string[]> = {};
        for (const id of new Set([...previous.keys(), ...next.keys()])) {
          const before = previous.get(id) ?? [],
            after = next.get(id) ?? [];
          if (before.join(',') !== after.join(',')) changes[id] = after;
        }
        if (Object.keys(changes).length > 0)
          await active.setElementState(changes, false);
        if (graph.current === active)
          highlights.current = { instance: active, states: next };
      })
      .catch(() => {
        if (graph.current === active) setState('unavailable');
      });
  }, [selectedId, identities, state, path]);

  function viewport(action: 'in' | 'out' | 'fit' | 'selection') {
    const active = graph.current;
    if (!active) return;
    pending.current = pending.current
      .then(async () => {
        if (graph.current !== active) return;
        if (action === 'fit') await active.fitView(undefined, false);
        else if (action === 'selection' && selectedId) {
          await active.zoomTo(1, false);
          await active.focusElement(selectedId, false);
        } else
          await active.zoomTo(
            Math.max(
              0.02,
              Math.min(2, active.getZoom() * (action === 'in' ? 1.25 : 0.8)),
            ),
            false,
          );
      })
      .catch(() => {
        if (graph.current === active) setState('unavailable');
      });
  }
  return (
    <div
      className={`${styles.canvasFrame} ${reading || layoutSettings ? styles.readingFrame : ''}`}
      data-reading={reading}
      data-node-count={result.nodes.length}
      data-edge-count={result.edges.length}
      data-testid="knowledge-graph"
      data-state={state}
      data-layout-direction={direction}
      data-layout-mode={effectiveMode}
      data-layout-grouping={grouping}
      data-node-spacing={nodeSpacing}
      data-group-spacing={groupSpacing}
    >
      <div
        className={styles.canvasControls}
        role="toolbar"
        aria-label={copy.controls}
      >
        {reading ? (
          <button
            aria-pressed={showRelationLabels}
            onClick={() => setShowRelationLabels((value) => !value)}
          >
            {copy.relationLabels}
          </button>
        ) : null}
        {!reading && !layoutSettings ? (
          <>
            <button
              type="button"
              aria-pressed={mode === 'network'}
              onClick={() => setMode('network')}
            >
              {copy.networkLayout}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'hierarchy'}
              onClick={() => setMode('hierarchy')}
            >
              {copy.hierarchyLayout}
            </button>
          </>
        ) : null}
        {!reading && layoutSettings && onLayoutSettingsChange ? (
          <>
            <label>
              {copy.layoutLabel}
              <select
                aria-label={copy.layoutLabel}
                value={settings.layout}
                onChange={(e) =>
                  onLayoutSettingsChange({
                    ...settings,
                    layout: e.target.value as GraphLayoutSettings['layout'],
                  })
                }
              >
                <option value="network">{copy.forceLayout}</option>
                <option value="hierarchy">{copy.hierarchyLayout}</option>
                <option value="circular">{copy.circularLayout}</option>
              </select>
            </label>
            <label>
              {copy.groupingLabel}
              <select
                aria-label={copy.groupingLabel}
                value={settings.grouping}
                onChange={(e) =>
                  onLayoutSettingsChange({
                    ...settings,
                    grouping: e.target.value as GraphLayoutSettings['grouping'],
                  })
                }
              >
                <option value="topology">{copy.groupTopology}</option>
                <option value="kind">{copy.groupKind}</option>
                <option value="source">{copy.groupSource}</option>
              </select>
            </label>
            <label>
              {copy.nodeSpacing}
              <select
                aria-label={copy.nodeSpacing}
                value={settings.nodeSpacing}
                onChange={(e) =>
                  onLayoutSettingsChange({
                    ...settings,
                    nodeSpacing: Number(e.target.value),
                  })
                }
              >
                {[20, 40, 60, 80, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {copy.groupSpacing}
              <select
                aria-label={copy.groupSpacing}
                value={settings.groupSpacing}
                onChange={(e) =>
                  onLayoutSettingsChange({
                    ...settings,
                    groupSpacing: Number(e.target.value),
                  })
                }
              >
                {[0, 100, 200, 300, 400].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <button
          disabled={state !== 'ready'}
          aria-label={copy.zoomIn}
          onClick={() => viewport('in')}
        >
          +
        </button>
        <button
          disabled={state !== 'ready'}
          aria-label={copy.zoomOut}
          onClick={() => viewport('out')}
        >
          −
        </button>
        <button disabled={state !== 'ready'} onClick={() => viewport('fit')}>
          {copy.fit}
        </button>
        <button
          disabled={
            state !== 'ready' ||
            !result.nodes.some((node) => node.entityId === selectedId)
          }
          onClick={() => viewport('selection')}
        >
          {copy.focusSelection}
        </button>
      </div>
      {!reading && layoutSettings ? (
        <p className={styles.layoutHint}>{copy.layoutHint}</p>
      ) : null}
      <div
        ref={target}
        className={styles.canvas}
        role="img"
        aria-label={copy.canvasLabel}
      />
      {state === 'ready' ? null : (
        <p role="status" className={styles.status}>
          {state === 'loading' ? copy.loading : copy.unavailable}
        </p>
      )}
    </div>
  );
}

export function DataFoundationGraph({
  locale,
  result,
}: {
  readonly locale: Locale;
  readonly result: GraphResultDto;
}) {
  const copy = getDictionary(locale).dataFoundation;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const onSelect = useCallback((id: string) => setSelectedId(id), []);
  const selected = result.nodes.find((node) => node.entityId === selectedId);
  if (result.nodes.length === 0) return <p>{copy.common.empty}</p>;
  return (
    <div className={styles.workspace}>
      <KnowledgeGraphCanvas
        locale={locale}
        result={result}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <aside className={styles.inspector}>
        <h2>
          {copy.graphPage.nodesTitle} <span>{result.nodes.length}</span>
        </h2>
        <p>{copy.graphPage.selectionHint}</p>
        <ul className={styles.nodes}>
          {result.nodes.map((node) => (
            <li key={node.entityId}>
              <button
                type="button"
                aria-pressed={selectedId === node.entityId}
                onClick={() => onSelect(node.entityId)}
              >
                {node.label}
              </button>
            </li>
          ))}
        </ul>
        {selected === undefined ? null : (
          <section
            data-testid="graph-inspector"
            className={styles.details}
            aria-live="polite"
          >
            <h3>{selected.label}</h3>
            <dl>
              <dt>{copy.common.versionId}</dt>
              <dd>{selected.versionId}</dd>
              <dt>{copy.common.evidenceId}</dt>
              <dd>{selected.evidenceId}</dd>
            </dl>
            <Link
              href={`/${locale}/data-foundation/catalog/${selected.dataItemId}?version=${selected.versionId}`}
            >
              {copy.graphPage.openData}
            </Link>
          </section>
        )}
        <p>
          {copy.graphPage.edgesTitle}: {result.edges.length}
        </p>
      </aside>
    </div>
  );
}
