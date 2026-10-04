'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import type {
  RegionId,
  WorkspacePack,
  WorkspaceRecord,
} from '@/lib/spatial-workspace-contract';
import type { SpatialWorkspaceCopy } from '@/lib/spatial-workspace-copy';
import type { PublicReferences } from '@/lib/spatial-public-reference';
import type { WorkspaceReadingUrlState } from '@/lib/spatial-workspace-url-state';
import {
  workspaceViewForReadingState,
  workspaceReadingStateForView,
} from '@/lib/spatial-workspace-reading-view';
import {
  captureSpatialWorkspaceView,
  createSpatialWorkspaceView,
  exportWorkspaceTopic,
  filterSpatialWorkspace,
  parseWorkspaceBounds,
  restoreSpatialWorkspaceView,
  sanitizeWorkspaceSelection,
  switchSpatialWorkspaceRegion,
  validWorkspaceTimeFilter,
  workspaceDisplayPositions,
  workspaceEvidenceUrl,
  workspaceGeometryBounds,
  workspaceObjectDossier,
  workspaceRasterOverlays,
  workspaceScopeInvalidations,
  workspaceRecordKinds,
  workspaceRegionCamera,
  workspaceRegionIds,
  type SpatialWorkspaceView,
  type WorkspaceInvalidation,
  type WorkspaceSelection,
} from '@/lib/spatial-workspace-view';
import { SpatialWorkspaceComparison } from './spatial-workspace-comparison';
import { SpatialWorkspaceDossier } from './spatial-workspace-dossier';
import { SpatialWorkspaceMap } from './spatial-workspace-map';
import { SpatialWorkspaceRecords } from './spatial-workspace-records';
import styles from './spatial-workspace.module.css';

const noInvalidations: readonly WorkspaceInvalidation[] = [];
const readingPanes = ['map', 'results', 'evidence'] as const;
type ReadingPane = (typeof readingPanes)[number];
type SavedScene = {
  id: string;
  name: string;
  createdAt: string;
  view: unknown;
};
const defaultStorageKey = 'wiser-spatial-workspace-goal100-v1';
function savedScenes(value: string | null): SavedScene[] {
  if (!value || value.length > 512000) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    const items: unknown[] = Array.isArray(parsed) ? parsed : [];
    return items
      .filter(
        (item): item is SavedScene =>
          item !== null &&
          typeof item === 'object' &&
          'id' in item &&
          typeof item.id === 'string' &&
          'name' in item &&
          typeof item.name === 'string' &&
          'createdAt' in item &&
          typeof item.createdAt === 'string' &&
          'view' in item,
      )
      .slice(0, 20);
  } catch {
    return [];
  }
}
export interface SpatialWorkspaceProps {
  pack: WorkspacePack;
  locale: Locale;
  copy: SpatialWorkspaceCopy;
  regionId?: RegionId;
  onRegionChange?: (id: RegionId) => void;
  selectedRecordId?: string | null;
  onSelectRecord?: (id: string | null) => void;
  invalidations?: readonly WorkspaceInvalidation[];
  sourceHref?: (sourceId: string, versionId: string) => string;
  storageKey?: string;
  publicReferences?: PublicReferences | null;
  publicReferenceState?: 'absent' | 'ready' | 'invalid' | 'unavailable';
  readingState?: WorkspaceReadingUrlState;
  onReadingStateChange?: (state: WorkspaceReadingUrlState) => void;
}
export function SpatialWorkspace({
  pack,
  locale,
  copy,
  regionId,
  onRegionChange: legacyOnRegionChange,
  selectedRecordId,
  onSelectRecord: legacyOnSelectRecord,
  invalidations = noInvalidations,
  sourceHref,
  storageKey = defaultStorageKey,
  publicReferences = null,
  publicReferenceState = 'absent',
  readingState,
  onReadingStateChange,
}: SpatialWorkspaceProps) {
  // Controlled navigation has one atomic callback. Separate legacy callbacks
  // must not race a matrix selection through a mounted hidden map.
  const onRegionChange = readingState ? undefined : legacyOnRegionChange;
  const onSelectRecord = readingState ? undefined : legacyOnSelectRecord;
  const userChangedReading = useRef(false);
  const emittedReadingKey = useRef<string | null>(null);
  const readingKey = JSON.stringify(readingState);
  const appliedReadingKey = useRef(readingKey);
  const readingId = useId();
  const [narrow, setNarrow] = useState(false);
  const [readingPane, setReadingPane] = useState<ReadingPane>(
    readingState?.pane ?? (selectedRecordId ? 'evidence' : 'map'),
  );
  const readingTabs = useRef<HTMLDivElement>(null);
  const paneElements = useRef<Partial<Record<ReadingPane, HTMLDivElement>>>({});
  const paneButtons = useRef<Partial<Record<ReadingPane, HTMLButtonElement>>>(
    {},
  );
  const focusPane = useRef(false);
  const showPane = (pane: ReadingPane, focusContent = false) => {
    userChangedReading.current = true;
    focusPane.current = focusContent && narrow;
    setReadingPane(pane);
  };
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 1100px), (max-height: 500px)');
    const update = () => {
      if (query.matches) {
        const focused = readingPanes.find((pane) =>
          paneElements.current[pane]?.contains(document.activeElement),
        );
        if (focused) setReadingPane(focused);
      } else if (readingTabs.current?.contains(document.activeElement))
        focusPane.current = true;
      setNarrow(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!focusPane.current) return;
    focusPane.current = false;
    paneElements.current[readingPane]?.focus();
  });
  const [view, setInternalView] = useState(() =>
      readingState
        ? workspaceViewForReadingState(pack, readingState)
        : createSpatialWorkspaceView(pack, regionId),
    ),
    [boundsText, setBoundsText] = useState(''),
    [boundsInvalid, setBoundsInvalid] = useState(false),
    [drawBounds, setDrawBounds] = useState(false);
  const setView: typeof setInternalView = (next) => {
    userChangedReading.current = true;
    setInternalView(next);
  };
  const [scenes, setScenes] = useState<SavedScene[]>([]),
    [sceneName, setSceneName] = useState(''),
    [message, setMessage] = useState(''),
    [saveFailed, setSaveFailed] = useState(false);
  const current = useRef(view);
  current.current = view;
  const callbacks = useRef({ onRegionChange, onSelectRecord });
  callbacks.current = { onRegionChange, onSelectRecord };
  const filtered = useMemo(
    () => filterSpatialWorkspace(pack, view, invalidations),
    [pack, view, invalidations],
  );
  const eligibleRecords = useMemo(() => {
    if (!view.comparison.enabled) return filtered.records;
    const scopes = [view.comparison.left, view.comparison.right];
    const records = scopes.flatMap(
      (scope) =>
        filterSpatialWorkspace(
          pack,
          { ...view, ...scope, bounds: null, topicId: null },
          invalidations,
        ).records,
    );
    return [...new Map(records.map((record) => [record.id, record])).values()];
  }, [pack, view, filtered.records, invalidations]);
  const selection = sanitizeWorkspaceSelection(
    pack,
    view.selection,
    eligibleRecords,
    invalidations,
    view.sourcePins,
  );
  const scopeNotices = view.comparison.enabled
    ? [
        ...new Map(
          [view.comparison.left, view.comparison.right]
            .flatMap((scope) =>
              workspaceScopeInvalidations(
                pack,
                { ...view, ...scope, bounds: null, topicId: null },
                invalidations,
              ),
            )
            .map((item) => [JSON.stringify(item), item]),
        ).values(),
      ]
    : workspaceScopeInvalidations(pack, view, invalidations);
  // Region and record are one external navigation event. Independent effects
  // can overwrite each other's queued state when a matrix updates both props.
  const invalidationKey = JSON.stringify(invalidations);
  useEffect(() => {
    if (!readingState || readingKey === appliedReadingKey.current) return;
    appliedReadingKey.current = readingKey;
    if (readingKey === emittedReadingKey.current) {
      // Consume only the acknowledgement of this local write. A later browser
      // forward to the same URL is an external restoration, not another ack.
      emittedReadingKey.current = null;
      return;
    }
    emittedReadingKey.current = null;
    userChangedReading.current = false;
    const next = workspaceViewForReadingState(
      pack,
      readingState,
      current.current,
    );
    setInternalView(next);
    setReadingPane(readingState.pane ?? 'map');
    setBoundsText('');
    setBoundsInvalid(false);
    setDrawBounds(false);
  }, [readingKey, pack]);
  useEffect(() => {
    if (readingState) return;
    const previous = current.current;
    const meaningfulInvalidations = JSON.parse(
      invalidationKey,
    ) as WorkspaceInvalidation[];
    let next =
      regionId && regionId !== previous.regionId
        ? switchSpatialWorkspaceRegion(previous, pack, regionId)
        : previous;
    if (selectedRecordId === null && next.selection)
      next = { ...next, selection: null };
    if (selectedRecordId) {
      const dossier = workspaceObjectDossier(
        pack,
        selectedRecordId,
        meaningfulInvalidations,
      );
      if (!dossier) {
        if (next.selection)
          next = { ...next, selection: null, expandedSources: [] };
        callbacks.current.onSelectRecord?.(null);
      } else if (next.selection?.recordId !== selectedRecordId) {
        const record = dossier.selected;
        const target =
          next.regionId === 'bth' || record.regionIds.includes(next.regionId)
            ? next.regionId
            : (record.regionIds.find((id) => id !== 'bth') ?? 'bth');
        if (target !== next.regionId) {
          next = switchSpatialWorkspaceRegion(next, pack, target);
          callbacks.current.onRegionChange?.(target);
        }
        next = {
          ...next,
          search: '',
          start: null,
          end: null,
          timeRole: 'all',
          kinds: [...workspaceRecordKinds],
          bounds: null,
          topicId: null,
          sourcePins: null,
          selection: {
            recordId: selectedRecordId,
            positionId: dossier.positions[0]?.id ?? null,
          },
        };
        setReadingPane('evidence');
      }
    }
    if (next !== previous) {
      setView(next);
      setBoundsText(next.bounds?.join(',') ?? '');
      setBoundsInvalid(false);
      setDrawBounds(false);
    }
  }, [
    regionId,
    selectedRecordId,
    pack,
    invalidationKey,
    Boolean(readingState),
  ]);
  useEffect(() => {
    if (readingState) return;
    if (
      (regionId && regionId !== view.regionId) ||
      (selectedRecordId !== undefined &&
        selectedRecordId !== view.selection?.recordId &&
        !(selectedRecordId === null && !view.selection))
    )
      return;
    if (view.selection && !selection) {
      setView((previous) => ({
        ...previous,
        selection: null,
        expandedSources: [],
      }));
      callbacks.current.onSelectRecord?.(null);
    } else if (
      view.selection &&
      selection &&
      view.selection.positionId !== selection.positionId
    )
      setView((previous) => ({ ...previous, selection }));
  }, [
    view.selection,
    selection,
    view.regionId,
    regionId,
    selectedRecordId,
    Boolean(readingState),
  ]);
  useEffect(() => {
    if (!readingState || !onReadingStateChange || !userChangedReading.current)
      return;
    userChangedReading.current = false;
    const next = workspaceReadingStateForView(
      pack,
      readingState,
      view,
      selection,
      readingPane,
    );
    if (!next) return;
    const key = JSON.stringify(next);
    if (key === readingKey) return;
    emittedReadingKey.current = key;
    onReadingStateChange(next);
  }, [view, selection, readingPane, readingKey, pack, onReadingStateChange]);
  useEffect(() => {
    const load = () => {
      try {
        setScenes(savedScenes(localStorage.getItem(storageKey)));
      } catch {
        setSaveFailed(true);
      }
    };
    load();
    const changed = (event: StorageEvent) => {
      if (event.key === storageKey) load();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [storageKey]);
  const changeRegion = (id: RegionId) => {
    showPane('map');
    setView(switchSpatialWorkspaceRegion(view, pack, id));
    setBoundsText('');
    setBoundsInvalid(false);
    setDrawBounds(false);
    onRegionChange?.(id);
    onSelectRecord?.(null);
  };
  const selectRecord = (
    picked: NonNullable<WorkspaceSelection>,
    locate = false,
  ) => {
    const record = pack.records.find((item) => item.id === picked.recordId);
    if (
      !record ||
      !workspaceObjectDossier(
        pack,
        picked.recordId,
        invalidations,
        view.sourcePins,
      )
    )
      return;
    let camera = view.camera;
    if (locate && picked.positionId) {
      const position = workspaceDisplayPositions(
        pack,
        record,
        invalidations,
        view.sourcePins,
      ).find((item) => item.id === picked.positionId);
      const extent = position?.geometry
        ? workspaceGeometryBounds(position.geometry)
        : null;
      if (extent)
        camera = {
          ...camera,
          longitude: (extent[0] + extent[2]) / 2,
          latitude: (extent[1] + extent[3]) / 2,
          zoom: Math.min(
            12,
            Math.max(
              6,
              8 -
                Math.log2(
                  Math.max(0.01, extent[2] - extent[0], extent[3] - extent[1]),
                ),
            ),
          ),
        };
    }
    setView({ ...view, selection: picked, camera });
    showPane(locate ? 'map' : 'evidence', true);
    onSelectRecord?.(picked.recordId);
  };
  const writeScenes = (next: SavedScene[]) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setScenes(next);
      setSaveFailed(false);
      return true;
    } catch {
      setSaveFailed(true);
      return false;
    }
  };
  const save = () => {
    const captured = captureSpatialWorkspaceView(
      pack,
      { ...view, selection },
      invalidations,
    );
    const scene = {
      id: crypto.randomUUID(),
      name: sceneName.trim().slice(0, 100) || copy.regions[view.regionId],
      createdAt: new Date().toISOString(),
      view: captured,
    };
    if (writeScenes([scene, ...scenes].slice(0, 20))) {
      setMessage(copy.saved);
      setSceneName('');
    }
  };
  const restore = (scene: SavedScene) => {
    const restored = restoreSpatialWorkspaceView(
      pack,
      scene.view,
      invalidations,
    );
    if (!restored) {
      setMessage(copy.invalidSaved);
      return;
    }
    setView(restored.view);
    showPane(restored.view.selection ? 'evidence' : 'map', true);
    setBoundsText(restored.view.bounds?.join(',') ?? '');
    setBoundsInvalid(false);
    setDrawBounds(false);
    onRegionChange?.(restored.view.regionId);
    onSelectRecord?.(restored.view.selection?.recordId ?? null);
    const labels = {
      stale: copy.stale,
      revoked: copy.revoked,
      missing: copy.sourceMissing,
    };
    setMessage(
      restored.notices.length
        ? `${copy.restoredWithChanges} ${restored.notices.map((notice) => `${labels[notice.state]}: ${notice.sourceId}`).join(' · ')}`
        : copy.restored,
    );
  };
  const openTopic = (id: string) => {
    const topic = pack.topicPackages.find((item) => item.id === id);
    if (!topic) return;
    const target = topic.regionIds[0] ?? 'bth';
    setView({
      ...switchSpatialWorkspaceRegion(view, pack, target),
      topicId: id,
    });
    showPane('map', true);
    setBoundsText('');
    setBoundsInvalid(false);
    setDrawBounds(false);
    onRegionChange?.(target);
    onSelectRecord?.(null);
  };
  const exportTopic = (id: string) => {
    const value = exportWorkspaceTopic(pack, id, invalidations);
    if (!value) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: 'application/json',
        }),
      ),
      anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wiser-topic-${id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage(copy.exported);
  };
  const resetFilters = () => {
    showPane('map');
    const next = createSpatialWorkspaceView(pack, view.regionId);
    setView({ ...next, mode: view.mode, camera: view.camera });
    setBoundsText('');
    setBoundsInvalid(false);
    setDrawBounds(false);
    onSelectRecord?.(null);
  };
  const sourceKeys = new Set(
    filtered.features.features.map((feature) => {
      const record = pack.records.find(
        (item) => item.id === feature.properties.recordId,
      );
      const position = record?.positions.find(
        (item) => item.id === feature.properties.positionId,
      );
      return JSON.stringify([
        position?.geometrySourceId,
        position?.geometryVersionId,
      ]);
    }),
  );
  const attribution = pack.sources.filter((source) =>
    sourceKeys.has(JSON.stringify([source.id, source.versionId])),
  );
  const region = pack.regions.find((item) => item.id === view.regionId);
  const regionType =
    region?.type === 'administrative' ||
    region?.type === 'basin' ||
    region?.type === 'composite'
      ? copy.regionTypes[region.type]
      : copy.unknown;
  const recordSelection = (
    record: WorkspaceRecord,
  ): NonNullable<WorkspaceSelection> => {
    const positions = workspaceDisplayPositions(
      pack,
      record,
      invalidations,
      view.sourcePins,
    );
    return {
      recordId: record.id,
      positionId:
        selection?.recordId === record.id &&
        positions.some((position) => position.id === selection.positionId)
          ? selection.positionId
          : (positions[0]?.id ?? null),
    };
  };
  const recordScope = JSON.stringify([
    view.regionId,
    view.start,
    view.end,
    view.timeRole,
    view.includeUndated,
    view.kinds,
    view.search,
    view.bounds,
    view.topicId,
    view.excludedRecordIds,
    view.sourcePins,
  ]);
  const tableProps = {
    pack,
    copy,
    scope: recordScope,
    selection,
    invalidations,
    sourcePins: view.sourcePins,
  };
  return (
    <div
      className={styles.workspace}
      lang={locale}
      data-testid="spatial-workspace"
    >
      <header className={styles.heading}>
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <span className={styles.status}>{copy.localOnly}</span>
      </header>
      <nav className={styles.regionNavigation} aria-label={copy.region}>
        {narrow ? (
          <label>
            {copy.region}
            <select
              value={view.regionId}
              onChange={(event) => changeRegion(event.target.value as RegionId)}
            >
              {workspaceRegionIds.map((id) => (
                <option key={id} value={id}>
                  {copy.regions[id]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          workspaceRegionIds.map((id) => (
            <button
              type="button"
              key={id}
              aria-current={view.regionId === id ? 'page' : undefined}
              onClick={() => changeRegion(id)}
            >
              {copy.regions[id]}
            </button>
          ))
        )}
      </nav>
      <div className={styles.breadcrumb}>
        <button type="button" onClick={() => changeRegion('bth')}>
          {copy.backToOverview}
        </button>
        <span>
          › {copy.regions[view.regionId]} · {regionType}
        </span>
        {selection ? (
          <>
            <span>
              ›{' '}
              {
                pack.records.find((record) => record.id === selection.recordId)
                  ?.objectLabel
              }
            </span>
            <button
              type="button"
              onClick={() => {
                setView({ ...view, selection: null });
                onSelectRecord?.(null);
              }}
            >
              {copy.backToRegion}
            </button>
          </>
        ) : null}
      </div>
      <details className={styles.filters} open={!narrow}>
        <summary>{copy.filters}</summary>
        <div className={styles.filterGrid}>
          <label>
            {copy.recordSearch}
            <input
              type="search"
              value={view.search}
              onChange={(event) =>
                setView({ ...view, search: event.target.value })
              }
            />
          </label>
          <label>
            {copy.from}
            <input
              type="date"
              value={view.start ?? ''}
              onChange={(event) =>
                setView({ ...view, start: event.target.value || null })
              }
            />
          </label>
          <label>
            {copy.to}
            <input
              type="date"
              value={view.end ?? ''}
              onChange={(event) =>
                setView({ ...view, end: event.target.value || null })
              }
            />
          </label>
          <label>
            {copy.timeRole}
            <select
              value={view.timeRole}
              onChange={(event) =>
                setView({
                  ...view,
                  timeRole: event.target
                    .value as SpatialWorkspaceView['timeRole'],
                })
              }
            >
              <option value="all">{copy.allTimeRoles}</option>
              {Object.entries(copy.timeRoles).map(([role, label]) => (
                <option key={role} value={role}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!validWorkspaceTimeFilter(view.start, view.end) ? (
          <p role="alert">{copy.timeInvalid ?? copy.timeHint}</p>
        ) : null}
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={view.includeUndated}
            onChange={(event) =>
              setView({ ...view, includeUndated: event.target.checked })
            }
          />
          {copy.includeUndated}
        </label>
        <p className={styles.hint}>{copy.timeHint}</p>
        <fieldset className={styles.layerFilters}>
          <legend>{copy.layers}</legend>
          {workspaceRecordKinds.map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={view.kinds.includes(kind)}
                onChange={(event) =>
                  setView({
                    ...view,
                    kinds: event.target.checked
                      ? [...view.kinds, kind]
                      : view.kinds.filter((item) => item !== kind),
                  })
                }
              />
              {copy.kinds[kind]}
            </label>
          ))}
        </fieldset>
        <div className={styles.boundsControls}>
          <label>
            {copy.bbox}
            <input
              value={boundsText}
              inputMode="decimal"
              onChange={(event) => {
                setBoundsText(event.target.value);
                setBoundsInvalid(false);
              }}
              aria-invalid={boundsInvalid}
              placeholder="116,39,117,40"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              const bounds = parseWorkspaceBounds(boundsText);
              if (!bounds) {
                setBoundsInvalid(true);
                return;
              }
              setView({ ...view, bounds });
              setBoundsInvalid(false);
            }}
          >
            {copy.applyBounds}
          </button>
          <button
            type="button"
            disabled={!view.bounds && !boundsText}
            onClick={() => {
              setBoundsText('');
              setBoundsInvalid(false);
              setView({ ...view, bounds: null });
            }}
          >
            {copy.clearBounds}
          </button>
          <button
            type="button"
            aria-pressed={drawBounds}
            disabled={view.comparison.enabled}
            onClick={() => {
              setDrawBounds(!drawBounds);
              if (!drawBounds)
                setView({
                  ...view,
                  mode: '2d',
                  camera: { ...view.camera, pitch: 0, bearing: 0 },
                });
            }}
          >
            {drawBounds ? copy.stopDrawing : copy.drawBounds}
          </button>
          <button type="button" onClick={resetFilters}>
            {copy.clearFilters}
          </button>
        </div>
        {boundsInvalid ? <p role="alert">{copy.bboxInvalid}</p> : null}
        <p className={styles.hint}>
          {drawBounds ? copy.drawBoundsHint : copy.bboxHint}
        </p>
      </details>
      <div className={styles.counts} aria-live="polite">
        <span data-testid="spatial-source-count">
          {copy.sourceCount.replace('{count}', String(filtered.sourceCount))}
        </span>
        <span data-testid="spatial-record-count">
          {copy.recordCount.replace('{count}', String(filtered.recordCount))}
        </span>
        <span data-testid="spatial-geometry-count">
          {copy.geometryCount.replace(
            '{count}',
            String(filtered.geometryCount),
          )}
        </span>
        <span>
          {copy.unlocatedCount.replace(
            '{count}',
            String(filtered.unlocatedRecords.length),
          )}
        </span>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          aria-pressed={view.mode === '2d'}
          onClick={() =>
            setView({
              ...view,
              mode: '2d',
              camera: { ...view.camera, pitch: 0 },
            })
          }
        >
          {copy.flatView}
        </button>
        <button
          type="button"
          aria-pressed={view.mode === '3d'}
          onClick={() => {
            setDrawBounds(false);
            setView({
              ...view,
              mode: '3d',
              camera: { ...view.camera, pitch: 50 },
            });
          }}
        >
          {copy.spaceView}
        </button>
        <button
          type="button"
          onClick={() =>
            setView({
              ...view,
              camera: {
                ...workspaceRegionCamera(pack, view.regionId),
                pitch: view.mode === '3d' ? 50 : 0,
              },
            })
          }
        >
          {copy.resetCamera}
        </button>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            aria-label={copy.comparisonTitle}
            checked={view.comparison.enabled}
            onChange={(event) => {
              setDrawBounds(false);
              setView({
                ...view,
                comparison: {
                  ...view.comparison,
                  enabled: event.target.checked,
                  left: {
                    regionId: view.regionId,
                    start: view.start,
                    end: view.end,
                  },
                },
              });
            }}
          />
          {copy.enableComparison ?? copy.comparisonTitle}
        </label>
      </div>
      {narrow ? (
        <div
          className={styles.readingTabs}
          role="tablist"
          aria-label={copy.readingPanel}
          ref={readingTabs}
        >
          {readingPanes.map((pane, index) => (
            <button
              key={pane}
              type="button"
              role="tab"
              id={`${readingId}-tab-${pane}`}
              aria-controls={`${readingId}-panel-${pane}`}
              aria-selected={readingPane === pane}
              tabIndex={readingPane === pane ? 0 : -1}
              ref={(element) => {
                if (element) paneButtons.current[pane] = element;
              }}
              onClick={() => showPane(pane)}
              onKeyDown={(event) => {
                const target =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? readingPanes.length - 1
                      : event.key === 'ArrowRight'
                        ? (index + 1) % readingPanes.length
                        : event.key === 'ArrowLeft'
                          ? (index + readingPanes.length - 1) %
                            readingPanes.length
                          : null;
                if (target === null) return;
                event.preventDefault();
                const next = readingPanes[target];
                showPane(next);
                paneButtons.current[next]?.focus();
              }}
            >
              {copy.readingPanes[pane]}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className={
          view.comparison.enabled ? styles.comparisonLayout : styles.mainLayout
        }
      >
        <div className={styles.mapAndRecords}>
          <div
            className={styles.readingPane}
            role={narrow ? 'tabpanel' : undefined}
            id={`${readingId}-panel-map`}
            aria-labelledby={narrow ? `${readingId}-tab-map` : undefined}
            hidden={narrow && readingPane !== 'map'}
            tabIndex={-1}
            ref={(element) => {
              if (element) paneElements.current.map = element;
            }}
          >
            {view.comparison.enabled ? (
              <SpatialWorkspaceComparison
                active={!narrow || readingPane === 'map'}
                pack={pack}
                view={view}
                copy={copy}
                onChange={setView}
                onSelect={selectRecord}
                invalidations={invalidations}
                publicReferences={publicReferences}
                publicReferenceState={publicReferenceState}
              />
            ) : (
              <section aria-label={copy.mapTitle}>
                <h2>{copy.mapTitle}</h2>
                <SpatialWorkspaceMap
                  active={!narrow || readingPane === 'map'}
                  features={filtered.features}
                  publicReferences={publicReferences}
                  publicReferenceState={publicReferenceState}
                  rasterReports={workspaceRasterOverlays(
                    pack,
                    view,
                    invalidations,
                  )}
                  rasterSettings={view.raster}
                  onRasterChange={(raster) =>
                    setView((previous) => ({ ...previous, raster }))
                  }
                  camera={view.camera}
                  mode={view.mode}
                  selection={selection}
                  copy={copy}
                  onCamera={(camera) =>
                    setView((previous) => ({ ...previous, camera }))
                  }
                  onSelect={selectRecord}
                  bounds={view.bounds}
                  drawBounds={drawBounds}
                  onBounds={(bounds) => {
                    setView({ ...view, bounds });
                    setBoundsText(
                      bounds.map((value) => Number(value.toFixed(6))).join(','),
                    );
                    setDrawBounds(false);
                    setBoundsInvalid(false);
                  }}
                />
              </section>
            )}
            {attribution.length ? (
              <details className={styles.attribution}>
                <summary>{copy.sourceAttribution}</summary>
                {attribution.map((source) => (
                  <details
                    key={`${source.id}:${source.versionId}`}
                    open={view.expandedSources.includes(source.id)}
                    onToggle={(event) => {
                      const expanded = event.currentTarget.open;
                      setView((previous) => ({
                        ...previous,
                        expandedSources: expanded
                          ? [
                              ...new Set([
                                ...previous.expandedSources,
                                source.id,
                              ]),
                            ]
                          : previous.expandedSources.filter(
                              (id) => id !== source.id,
                            ),
                      }));
                    }}
                  >
                    <summary>
                      {source.title} · {source.versionId}
                    </summary>
                    <p>
                      {source.provider} · {source.rights.note}
                    </p>
                    {source.coverageNote ? <p>{source.coverageNote}</p> : null}
                    {workspaceEvidenceUrl(source.evidenceUrl) ? (
                      <a
                        href={workspaceEvidenceUrl(source.evidenceUrl)!}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {copy.openOriginal}
                      </a>
                    ) : null}
                  </details>
                ))}
              </details>
            ) : null}
          </div>
          <div
            className={styles.readingPane}
            role={narrow ? 'tabpanel' : undefined}
            id={`${readingId}-panel-results`}
            aria-labelledby={narrow ? `${readingId}-tab-results` : undefined}
            hidden={narrow && readingPane !== 'results'}
            tabIndex={-1}
            ref={(element) => {
              if (element) paneElements.current.results = element;
            }}
          >
            {filtered.locatedRecords.length || !filtered.records.length ? (
              <section
                className={styles.records}
                aria-label={copy.recordsTitle}
              >
                <h2>{copy.recordsTitle}</h2>
                <SpatialWorkspaceRecords
                  {...tableProps}
                  records={filtered.locatedRecords}
                  label={copy.recordsTitle}
                  onSelect={(record) => selectRecord(recordSelection(record))}
                />
              </section>
            ) : null}
            {filtered.unlocatedRecords.length ? (
              <section
                className={styles.records}
                aria-label={copy.unlocatedTitle}
              >
                <h2>{copy.unlocatedTitle}</h2>
                <p className={styles.hint}>{copy.unlocatedHint}</p>
                <SpatialWorkspaceRecords
                  {...tableProps}
                  records={filtered.unlocatedRecords}
                  label={copy.unlocatedTitle}
                  onSelect={(record) => selectRecord(recordSelection(record))}
                />
              </section>
            ) : null}
            {filtered.outsideRecords.length ? (
              <details className={styles.records}>
                <summary>
                  {copy.outsideBounds} · {filtered.outsideRecords.length}
                </summary>
                <p className={styles.hint}>{copy.outsideSelect}</p>
                <SpatialWorkspaceRecords
                  {...tableProps}
                  records={filtered.outsideRecords}
                  label={copy.outsideBounds}
                  onSelect={(record) => {
                    setView({
                      ...view,
                      bounds: null,
                      selection: recordSelection(record),
                    });
                    setBoundsText('');
                    showPane('evidence', true);
                    onSelectRecord?.(record.id);
                  }}
                />
              </details>
            ) : null}
          </div>
        </div>
        <div
          className={styles.readingPane}
          role={narrow ? 'tabpanel' : undefined}
          id={`${readingId}-panel-evidence`}
          aria-labelledby={narrow ? `${readingId}-tab-evidence` : undefined}
          hidden={narrow && readingPane !== 'evidence'}
          tabIndex={-1}
          ref={(element) => {
            if (element) paneElements.current.evidence = element;
          }}
        >
          <SpatialWorkspaceDossier
            pack={pack}
            recordId={selection?.recordId ?? null}
            positionId={selection?.positionId}
            copy={copy}
            invalidations={invalidations}
            sourcePins={view.sourcePins}
            notices={scopeNotices}
            onSelectRecord={(id) =>
              selectRecord({ recordId: id, positionId: null })
            }
            onSelectPosition={(recordId, positionId) =>
              selectRecord({ recordId, positionId }, true)
            }
            sourceHref={sourceHref}
          />
        </div>
      </div>
      <div className={styles.bottomLayout}>
        <section className={styles.saved} aria-label={copy.saveTitle}>
          <h2>{copy.saveTitle}</h2>
          <p className={styles.hint}>{copy.localOnly}</p>
          <label>
            {copy.sceneName}
            <input
              value={sceneName}
              maxLength={100}
              onChange={(event) => setSceneName(event.target.value)}
            />
          </label>
          <button type="button" onClick={save}>
            {copy.saveView}
          </button>
          {saveFailed ? <p role="alert">{copy.saveFailed}</p> : null}
          {!scenes.length ? (
            <p>{copy.savedEmpty}</p>
          ) : (
            <ul className={styles.savedList}>
              {scenes.map((scene) => (
                <li key={scene.id}>
                  <span>{scene.name}</span>
                  <div className={styles.actions}>
                    <button type="button" onClick={() => restore(scene)}>
                      {copy.restoreView}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        writeScenes(
                          scenes.filter((item) => item.id !== scene.id),
                        )
                      }
                    >
                      {copy.removeView}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={styles.topics} aria-label={copy.topicTitle}>
          <h2>{copy.topicTitle}</h2>
          <p className={styles.hint}>{copy.exportHint}</p>
          {pack.topicPackages.map((topic) => (
            <details key={topic.id} open={view.topicId === topic.id}>
              <summary>{topic.title}</summary>
              <p>
                <strong>{copy.topicQuestion}: </strong>
                {topic.question}
              </p>
              <p>
                <strong>{copy.topicGaps}: </strong>
                {topic.gaps.join('；') || copy.unknown}
              </p>
              <div className={styles.actions}>
                <button type="button" onClick={() => openTopic(topic.id)}>
                  {copy.openTopic}
                </button>
                <button type="button" onClick={() => exportTopic(topic.id)}>
                  {copy.exportTopic}
                </button>
              </div>
            </details>
          ))}
        </section>
      </div>
      {message ? (
        <p role="status" className={styles.message}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
