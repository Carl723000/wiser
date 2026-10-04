import type { WorkspacePack } from './spatial-workspace-contract';
import {
  createSpatialWorkspaceView,
  filterSpatialWorkspace,
  workspaceDisplayPositions,
  type SpatialWorkspaceView,
  type WorkspaceSelection,
  type WorkspaceSourcePin,
} from './spatial-workspace-view';
import {
  encodeWorkspaceReadingUrl,
  type WorkspaceReadingUrlState,
} from './spatial-workspace-url-state';

export function defaultWorkspaceReadingState(): WorkspaceReadingUrlState {
  return {
    track: 'REAL',
    regionId: 'bth',
    needId: null,
    dateRole: null,
    monthWindow: null,
    tab: 'spatial',
    pane: 'map',
    source: null,
    selection: null,
  };
}

/** Keep permitted geometry sources available, while filtering business records by explicit track/need. */
export function scopeWorkspaceReadingPack(
  pack: WorkspacePack,
  state: WorkspaceReadingUrlState,
): WorkspacePack {
  const track = state.track ?? 'REAL';
  const sourceAllowed = (sourceId: string, versionId: string) =>
    pack.sources.some(
      (source) =>
        source.id === sourceId &&
        source.versionId === versionId &&
        source.rights.displayAllowed &&
        (source.track ?? 'REAL') === track &&
        (state.needId === null || source.needIds.includes(state.needId)),
    );
  const records = pack.records.filter(
    (record) =>
      (record.track ?? 'REAL') === track &&
      (track === 'SYNTHETIC' || record.reviewStatus !== 'synthetic-reviewed') &&
      (state.needId === null || record.needIds.includes(state.needId)) &&
      pack.sources.some(
        (source) =>
          source.id === record.sourceId &&
          source.versionId === record.versionId &&
          source.rights.displayAllowed &&
          (source.track ?? 'REAL') === track,
      ),
  );
  const recordIds = new Set(records.map((record) => record.id));
  const sourceIds = new Set(
    pack.sources
      .filter(
        (source) =>
          source.rights.displayAllowed && (source.track ?? 'REAL') === track,
      )
      .map((source) => source.id),
  );
  return {
    ...pack,
    rasterReports: pack.rasterReports.filter(
      (report) =>
        report.rights.displayAllowed &&
        sourceAllowed(report.sourceId, report.versionId) &&
        (state.regionId === null ||
          state.regionId === 'bth' ||
          report.regionIds.includes(state.regionId)),
    ),
    records,
    // Sources remain a permitted geometry/measurement dependency directory.
    // Topic membership describes the current business track, not that directory.
    topicPackages: pack.topicPackages.flatMap((topic) => {
      const currentRecords = topic.recordIds.filter((id) => recordIds.has(id));
      const currentSources = topic.sourceIds.filter((id) => sourceIds.has(id));
      return currentRecords.length || currentSources.length
        ? [{ ...topic, recordIds: currentRecords, sourceIds: currentSources }]
        : [];
    }),
  };
}

export function workspaceReadingSourcePin(
  pack: WorkspacePack,
  sourceId: string,
  versionId: string,
): WorkspaceSourcePin | null {
  const items = pack.sources.filter(
    (source) => source.id === sourceId && source.versionId === versionId,
  );
  const source = items[0];
  return items.length === 1 &&
    source?.rights.displayAllowed &&
    source.originalSha256 &&
    source.processingVersion
    ? {
        sourceId,
        versionId,
        sha256: source.originalSha256,
        processingVersion: source.processingVersion,
      }
    : null;
}

function monthBounds(window: WorkspaceReadingUrlState['monthWindow']) {
  if (!window) return { start: null, end: null };
  const year = Number(window.end.slice(0, 4));
  const month = Number(window.end.slice(5));
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  // Filtering a complete calendar month uses its inclusive boundaries. This
  // does not manufacture precision in the source's original time declaration.
  return {
    start: `${window.start}-01`,
    end: `${window.end}-${days[month - 1]}`,
  };
}

export function workspaceViewForReadingState(
  pack: WorkspacePack,
  state: WorkspaceReadingUrlState,
  previous?: SpatialWorkspaceView,
): SpatialWorkspaceView {
  const view = createSpatialWorkspaceView(pack, state.regionId ?? 'bth');
  const bounds = state.dayWindow ?? monthBounds(state.monthWindow);
  return {
    ...view,
    ...bounds,
    timeRole:
      (state.dateRole?.toLowerCase() as SpatialWorkspaceView['timeRole']) ??
      'all',
    includeUndated:
      state.includeUndated ?? (!state.dayWindow && state.monthWindow === null),
    selection: state.selection
      ? {
          recordId: state.selection.recordId,
          positionId: state.selection.position?.positionId ?? null,
        }
      : null,
    ...(previous?.regionId === view.regionId
      ? {
          camera: previous.camera,
          mode: previous.mode,
          raster: previous.raster,
        }
      : {}),
  };
}

export function workspaceReadingRecords(
  pack: WorkspacePack,
  state: WorkspaceReadingUrlState,
) {
  return filterSpatialWorkspace(
    scopeWorkspaceReadingPack(pack, state),
    workspaceViewForReadingState(pack, state),
  ).records;
}

/** A user selection pins the actual source, own rule and exact chosen position. */
export function withWorkspaceReadingRecord(
  pack: WorkspacePack,
  state: WorkspaceReadingUrlState,
  selection: WorkspaceSelection,
): WorkspaceReadingUrlState | null {
  const { dayWindow: _days, ...rest } = state;
  if (!selection)
    return {
      ...rest,
      ...(state.dayWindow ? { dayWindow: state.dayWindow } : {}),
      source: null,
      selection: null,
    };
  const records = pack.records.filter(
    (record) => record.id === selection.recordId,
  );
  const record = records[0];
  if (records.length !== 1 || !record) return null;
  const source = workspaceReadingSourcePin(
    pack,
    record.sourceId,
    record.versionId,
  );
  if (!source) return null;
  let position: NonNullable<WorkspaceReadingUrlState['selection']>['position'] =
    null;
  if (selection.positionId !== null) {
    const positions = workspaceDisplayPositions(pack, record).filter(
      (item) => item.id === selection.positionId,
    );
    const item = positions[0];
    if (
      positions.length !== 1 ||
      !item?.geometrySourceId ||
      !item.geometryVersionId
    )
      return null;
    const geometrySource = workspaceReadingSourcePin(
      pack,
      item.geometrySourceId,
      item.geometryVersionId,
    );
    if (!geometrySource) return null;
    position = { positionId: item.id, geometrySource };
  }
  const next = {
    ...state,
    source,
    selection: {
      recordId: record.id,
      processingVersion: record.processingVersion,
      position,
    },
  };
  return encodeWorkspaceReadingUrl('zh-CN', next, { pack }).status === 'valid'
    ? next
    : null;
}

export function workspaceReadingStateForView(
  pack: WorkspacePack,
  state: WorkspaceReadingUrlState,
  view: SpatialWorkspaceView,
  selection: WorkspaceSelection,
  pane: WorkspaceReadingUrlState['pane'],
): WorkspaceReadingUrlState | null {
  const monthlyBounds = monthBounds(state.monthWindow);
  const stillMonth =
    state.monthWindow !== null &&
    view.start === monthlyBounds.start &&
    view.end === monthlyBounds.end;
  const { dayWindow: _days, ...rest } = state;
  const next: WorkspaceReadingUrlState = {
    ...rest,
    regionId:
      state.regionId === null && view.regionId === 'bth' ? null : view.regionId,
    dateRole:
      view.timeRole === 'all'
        ? null
        : (view.timeRole.toUpperCase() as WorkspaceReadingUrlState['dateRole']),
    monthWindow: stillMonth ? state.monthWindow : null,
    ...(!stillMonth && (view.start !== null || view.end !== null)
      ? { dayWindow: { start: view.start, end: view.end } }
      : {}),
    pane,
  };
  const implicitUndated = !next.dayWindow && next.monthWindow === null;
  if (
    Object.hasOwn(state, 'includeUndated') ||
    view.includeUndated !== implicitUndated
  )
    next.includeUndated = view.includeUndated;
  const pinned =
    selection === null &&
    state.selection === null &&
    state.source !== null &&
    next.regionId === state.regionId &&
    next.dateRole === state.dateRole &&
    JSON.stringify(next.monthWindow) === JSON.stringify(state.monthWindow) &&
    JSON.stringify(next.dayWindow) === JSON.stringify(state.dayWindow)
      ? next
      : withWorkspaceReadingRecord(pack, next, selection);
  return pinned &&
    encodeWorkspaceReadingUrl('zh-CN', pinned, { pack }).status === 'valid'
    ? pinned
    : null;
}
