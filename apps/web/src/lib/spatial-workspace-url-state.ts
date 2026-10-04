import type { ProjectReadinessTrack } from '@wiser/data-core/project-readiness';
import type { Locale } from './i18n';
import type { RegionId, WorkspacePack } from './spatial-workspace-contract';
import type { ReadinessSelection } from './spatial-readiness-facts';
import { NEED_IDS } from './spatial-readiness';
import {
  createSpatialWorkspaceView,
  filterSpatialWorkspace,
  validWorkspaceTimeFilter,
  workspaceNativeTime,
  workspaceDisplayPositions,
  workspaceRegionIds,
  type WorkspaceInvalidation,
  type WorkspaceSourcePin,
} from './spatial-workspace-view';

/** Private reading state; never an API query or an authorization grant. */
export interface WorkspaceReadingUrlState {
  /** Omitted legacy state follows REAL; SYNTHETIC is always an explicit choice. */
  track?: ProjectReadinessTrack;
  regionId: RegionId | null;
  needId: string | null;
  dateRole: ReadinessSelection['dateRole'] | 'ACQUISITION' | 'UNKNOWN' | null;
  monthWindow: ReadinessSelection['window'];
  /** Exact filtering boundaries; not a declaration of observation precision. */
  dayWindow?: { start: string | null; end: string | null };
  includeUndated?: boolean;
  tab: 'spatial' | 'readiness' | 'raster' | null;
  pane: 'map' | 'results' | 'evidence' | null;
  source: WorkspaceSourcePin | null;
  selection: {
    recordId: string;
    processingVersion: string;
    position: {
      positionId: string;
      geometrySource: WorkspaceSourcePin;
    } | null;
  } | null;
}
export interface WorkspaceReadingUrlContext {
  /** Already permitted input for this route, never a fallback after failed Auth. */
  pack: WorkspacePack;
  invalidations?: readonly WorkspaceInvalidation[];
}
export type WorkspaceReadingSearchParams =
  URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;
export type WorkspaceReadingUrlFailure =
  | 'parameters'
  | 'duplicate'
  | 'unknown-parameter'
  | 'size'
  | 'scope'
  | 'month-window'
  | 'day-window'
  | 'source'
  | 'record'
  | 'position'
  | 'target';
export type WorkspaceReadingUrlResult =
  | { status: 'absent' }
  | { status: 'invalid'; reason: WorkspaceReadingUrlFailure }
  | { status: 'valid'; state: WorkspaceReadingUrlState };
export type WorkspaceReadingHrefResult =
  | { status: 'invalid'; reason: WorkspaceReadingUrlFailure }
  | { status: 'valid'; href: string };

const parameterNames = new Set([
  'track',
  'region',
  'need',
  'dateRole',
  'monthStart',
  'monthEnd',
  'dayStart',
  'dayEnd',
  'includeUndated',
  'tab',
  'pane',
  'source',
  'version',
  'sourceHash',
  'sourceRule',
  'record',
  'recordRule',
  'position',
  'geometrySource',
  'geometryVersion',
  'geometryHash',
  'geometryRule',
]);
const needIds = new Set(NEED_IDS);
const sourceNames = ['source', 'version', 'sourceHash', 'sourceRule'] as const;
const geometryNames = [
  'geometrySource',
  'geometryVersion',
  'geometryHash',
  'geometryRule',
] as const;
const maximumQuerySize = 8192;
const invalid = (reason: WorkspaceReadingUrlFailure) =>
  ({ status: 'invalid', reason }) as const;

function parameters(
  input: WorkspaceReadingSearchParams,
): URLSearchParams | ReturnType<typeof invalid> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return invalid('parameters');
  if (
    !(input instanceof URLSearchParams) &&
    Object.getPrototypeOf(input) !== Object.prototype &&
    Object.getPrototypeOf(input) !== null
  )
    return invalid('parameters');
  const result = new URLSearchParams();
  const entries =
    input instanceof URLSearchParams ? input.entries() : Object.entries(input);
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (Array.isArray(value) || result.has(key)) return invalid('duplicate');
    if (typeof value !== 'string') return invalid('parameters');
    if (value.length > maximumQuerySize) return invalid('size');
    if (
      !key ||
      !value ||
      [...key, ...value].some(
        (character) =>
          character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
      )
    )
      return invalid('parameters');
    if (!parameterNames.has(key)) return invalid('unknown-parameter');
    result.set(key, value);
  }
  return result.toString().length > maximumQuerySize ? invalid('size') : result;
}

function pin(
  params: URLSearchParams,
  names: readonly [string, string, string, string],
): WorkspaceSourcePin | null {
  const values = names.map((name) => params.get(name));
  if (values.some((value) => value === null)) return null;
  return {
    sourceId: values[0]!,
    versionId: values[1]!,
    sha256: values[2]!,
    processingVersion: values[3]!,
  };
}

function currentSource(
  reference: WorkspaceSourcePin,
  { pack, invalidations = [] }: WorkspaceReadingUrlContext,
  track?: ProjectReadinessTrack,
) {
  const sources = pack.sources.filter(
    (source) =>
      source.id === reference.sourceId &&
      source.versionId === reference.versionId,
  );
  const source = sources[0];
  if (
    sources.length !== 1 ||
    !source?.rights.displayAllowed ||
    (track !== undefined && (source.track ?? 'REAL') !== track) ||
    source.originalSha256 !== reference.sha256 ||
    source.processingVersion !== reference.processingVersion ||
    invalidations.some(
      (item) =>
        item.sourceId === reference.sourceId &&
        (!item.versionId || item.versionId === reference.versionId) &&
        item.affectedRecordIds === undefined,
    )
  )
    return null;
  return source;
}

function monthOrdinal(value: string): number | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(value);
  if (!match || match[1] === '0000') return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

function calendarDay(value: string): boolean {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u.exec(value);
  if (!match || match[1] === '0000') return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
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
  return Number(match[3]) <= days[month - 1];
}

export function decodeWorkspaceReadingUrl(
  input: WorkspaceReadingSearchParams,
  context: WorkspaceReadingUrlContext,
): WorkspaceReadingUrlResult {
  const params = parameters(input);
  if (!(params instanceof URLSearchParams)) return params;
  if (params.size === 0) return { status: 'absent' };

  const suppliedTrack = params.get('track');
  const track = suppliedTrack ?? 'REAL';
  const region = params.get('region');
  const need = params.get('need');
  const dateRole = params.get('dateRole');
  const tab = params.get('tab');
  const pane = params.get('pane');
  const undated = params.get('includeUndated');
  if (
    !['REAL', 'SYNTHETIC'].includes(track) ||
    (undated !== null && !['true', 'false'].includes(undated)) ||
    (region !== null &&
      (!workspaceRegionIds.includes(region as RegionId) ||
        context.pack.regions.filter((item) => item.id === region).length !==
          1)) ||
    (need !== null && !needIds.has(need)) ||
    (dateRole !== null &&
      ![
        'PUBLICATION',
        'OBSERVATION',
        'EVENT',
        'ACQUISITION',
        'UNKNOWN',
      ].includes(dateRole)) ||
    (tab !== null && !['spatial', 'readiness', 'raster'].includes(tab)) ||
    (pane !== null && !['map', 'results', 'evidence'].includes(pane))
  )
    return invalid('scope');

  const start = params.get('monthStart');
  const end = params.get('monthEnd');
  const dayStart = params.get('dayStart');
  const dayEnd = params.get('dayEnd');
  const hasDays = dayStart !== null || dayEnd !== null;
  if (hasDays && (start !== null || end !== null)) return invalid('day-window');
  if (
    hasDays &&
    ((dayStart !== null && !calendarDay(dayStart)) ||
      (dayEnd !== null && !calendarDay(dayEnd)) ||
      (dayStart !== null && dayEnd !== null && dayStart > dayEnd))
  )
    return invalid('day-window');
  let monthWindow: ReadinessSelection['window'] = null;
  if (start !== null || end !== null) {
    if (start === null || end === null || dateRole === null)
      return invalid('month-window');
    const first = monthOrdinal(start);
    const last = monthOrdinal(end);
    if (
      first === null ||
      last === null ||
      last - first >= 1200 ||
      !validWorkspaceTimeFilter(start, end)
    )
      return invalid('month-window');
    monthWindow = { start, end };
  }
  const state: WorkspaceReadingUrlState = {
    ...(suppliedTrack !== null
      ? { track: track as ProjectReadinessTrack }
      : {}),
    regionId: region as RegionId | null,
    needId: need,
    dateRole: dateRole as WorkspaceReadingUrlState['dateRole'],
    monthWindow,
    ...(hasDays ? { dayWindow: { start: dayStart, end: dayEnd } } : {}),
    ...(undated !== null ? { includeUndated: undated === 'true' } : {}),
    tab: tab as WorkspaceReadingUrlState['tab'],
    pane: pane as WorkspaceReadingUrlState['pane'],
    source: null,
    selection: null,
  };

  if (sourceNames.some((name) => params.has(name))) {
    state.source = pin(params, sourceNames);
    if (
      !state.source ||
      !currentSource(state.source, context, track as ProjectReadinessTrack)
    )
      return invalid('source');
  }
  const positionSupplied =
    params.has('position') || geometryNames.some((name) => params.has(name));
  const recordSupplied = params.has('record') || params.has('recordRule');
  if (positionSupplied && !recordSupplied) return invalid('position');
  if (recordSupplied) {
    const recordId = params.get('record');
    const processingVersion = params.get('recordRule');
    if (!state.source || recordId === null || processingVersion === null)
      return invalid('record');
    const records = context.pack.records.filter(
      (record) =>
        record.id === recordId &&
        record.sourceId === state.source?.sourceId &&
        record.versionId === state.source.versionId &&
        record.processingVersion === processingVersion,
    );
    const record = records[0];
    if (
      records.length !== 1 ||
      !record ||
      (record.track ?? 'REAL') !== track ||
      (record.reviewStatus === 'synthetic-reviewed' && track !== 'SYNTHETIC') ||
      context.invalidations?.some(
        (item) =>
          item.sourceId === record.sourceId &&
          (!item.versionId || item.versionId === record.versionId) &&
          (!item.affectedRecordIds ||
            item.affectedRecordIds.includes(record.id)),
      )
    )
      return invalid('record');
    // The total-context filter below does not restore a missing scope as a UI default.
    const view = createSpatialWorkspaceView(
      context.pack,
      state.regionId ?? 'bth',
    );
    view.start = state.dayWindow?.start ?? monthWindow?.start ?? null;
    view.end = state.dayWindow?.end ?? monthWindow?.end ?? null;
    view.timeRole =
      (state.dateRole?.toLowerCase() as typeof view.timeRole) ?? 'all';
    view.includeUndated =
      state.includeUndated ?? (monthWindow === null && !hasDays);
    if (
      (need !== null && !record.needIds.includes(need)) ||
      (state.dateRole !== null &&
        record.time.role !== view.timeRole &&
        !(
          state.includeUndated === true &&
          record.time.role === 'unknown' &&
          workspaceNativeTime(record) === null
        )) ||
      !filterSpatialWorkspace(
        { ...context.pack, records: [record] },
        view,
        context.invalidations,
      ).records.includes(record)
    )
      return invalid('scope');
    state.selection = { recordId, processingVersion, position: null };
    if (positionSupplied) {
      const positionId = params.get('position');
      const geometrySource = pin(params, geometryNames);
      if (
        positionId === null ||
        !geometrySource ||
        !currentSource(geometrySource, context) ||
        record.positions.filter((position) => position.id === positionId)
          .length !== 1
      )
        return invalid('position');
      const positions = workspaceDisplayPositions(
        context.pack,
        record,
        context.invalidations,
      ).filter(
        (position) =>
          position.id === positionId &&
          position.geometrySourceId === geometrySource.sourceId &&
          position.geometryVersionId === geometrySource.versionId,
      );
      if (positions.length !== 1) return invalid('position');
      state.selection.position = { positionId, geometrySource };
    }
  } else if (state.source) {
    const source = currentSource(
      state.source,
      context,
      track as ProjectReadinessTrack,
    )!;
    if (
      (region !== null &&
        region !== 'bth' &&
        !source.regionIds.includes(region as RegionId)) ||
      (need !== null && !source.needIds.includes(need))
    )
      return invalid('scope');
  }
  return { status: 'valid', state };
}

function exactFields(
  value: unknown,
  names: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function appendFields(
  params: URLSearchParams,
  value: unknown,
  fields: Readonly<Record<string, string>>,
  nullable = false,
) {
  if (!exactFields(value, Object.keys(fields))) return false;
  for (const [field, parameter] of Object.entries(fields)) {
    const item = value[field];
    if (item === null && nullable) continue;
    if (typeof item !== 'string') return false;
    params.set(parameter, item);
  }
  return true;
}
function appendPin(
  params: URLSearchParams,
  value: unknown,
  names: readonly string[],
) {
  return appendFields(params, value, {
    sourceId: names[0],
    versionId: names[1],
    sha256: names[2],
    processingVersion: names[3],
  });
}

export function encodeWorkspaceReadingUrl(
  locale: Locale,
  state: WorkspaceReadingUrlState,
  context: WorkspaceReadingUrlContext,
  target: 'workspace' | 'source' = 'workspace',
): WorkspaceReadingHrefResult {
  if (
    !['zh-CN', 'en'].includes(locale) ||
    !['workspace', 'source'].includes(target)
  )
    return invalid('target');
  const stateFields = [
    'regionId',
    'needId',
    'dateRole',
    'monthWindow',
    'tab',
    'pane',
    'source',
    'selection',
  ];
  const optionalStateFields = ['track', 'dayWindow', 'includeUndated'].filter(
    (key) => Object.hasOwn(state, key),
  );
  if (!exactFields(state, [...stateFields, ...optionalStateFields]))
    return invalid('parameters');
  if (target === 'source' && state.source === null) return invalid('target');
  const params = new URLSearchParams();
  if (Object.hasOwn(state, 'track')) {
    if (typeof state.track !== 'string') return invalid('parameters');
    params.set('track', state.track);
  }
  if (Object.hasOwn(state, 'includeUndated')) {
    if (typeof state.includeUndated !== 'boolean') return invalid('parameters');
    params.set('includeUndated', String(state.includeUndated));
  }
  if (
    !appendFields(
      params,
      {
        regionId: state.regionId,
        needId: state.needId,
        dateRole: state.dateRole,
        tab: state.tab,
        pane: state.pane,
      },
      {
        regionId: 'region',
        needId: 'need',
        dateRole: 'dateRole',
        tab: 'tab',
        pane: 'pane',
      },
      true,
    )
  )
    return invalid('parameters');
  if (
    state.monthWindow !== null &&
    !appendFields(params, state.monthWindow, {
      start: 'monthStart',
      end: 'monthEnd',
    })
  )
    return invalid('parameters');
  if (Object.hasOwn(state, 'dayWindow')) {
    if (
      !exactFields(state.dayWindow, ['start', 'end']) ||
      (state.dayWindow.start === null && state.dayWindow.end === null)
    )
      return invalid('day-window');
    if (
      !appendFields(
        params,
        state.dayWindow,
        { start: 'dayStart', end: 'dayEnd' },
        true,
      )
    )
      return invalid('parameters');
  }
  if (state.source !== null && !appendPin(params, state.source, sourceNames))
    return invalid('parameters');
  if (state.selection !== null) {
    if (
      !exactFields(state.selection, [
        'recordId',
        'processingVersion',
        'position',
      ])
    )
      return invalid('parameters');
    if (
      !appendFields(
        params,
        {
          recordId: state.selection.recordId,
          processingVersion: state.selection.processingVersion,
        },
        { recordId: 'record', processingVersion: 'recordRule' },
      )
    )
      return invalid('parameters');
    if (state.selection.position !== null) {
      if (
        !exactFields(state.selection.position, [
          'positionId',
          'geometrySource',
        ]) ||
        typeof state.selection.position.positionId !== 'string' ||
        !appendPin(
          params,
          state.selection.position.geometrySource,
          geometryNames,
        )
      )
        return invalid('parameters');
      params.set('position', state.selection.position.positionId);
    }
  }
  const result = decodeWorkspaceReadingUrl(params, context);
  if (result.status === 'invalid') return result;
  const query = params.toString();
  return {
    status: 'valid',
    href: `/${locale}/data-foundation/spatial-workspace${target === 'source' ? '/source' : ''}${query ? `?${query}` : ''}`,
  };
}
