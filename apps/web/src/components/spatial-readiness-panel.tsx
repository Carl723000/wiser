'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  readinessRecordKey,
  type ProjectReadinessInput,
  type ReadinessValueKind,
} from '@wiser/data-core/project-readiness';
import {
  buildReadiness,
  NEED_IDS,
  type NeedState,
  type ReadinessCounts,
  type ReadinessGrain,
  type ReadinessQuestionId,
  type UseId,
} from '../lib/spatial-readiness';
import {
  fixedSourceKey,
  materialReference,
  type ReadinessSelection,
} from '../lib/spatial-readiness-facts';
import type {
  Material,
  RegionId,
  WorkspacePack,
  WorkspaceRecord,
} from '../lib/spatial-workspace-contract';
import {
  buildReadinessMatrix,
  MATRIX_REGIONS,
  type MatrixAxis,
} from '../lib/spatial-readiness-matrix';
import { ContextHelp } from './context-help';
import {
  buildMonthlyReadout,
  type MonthlyReadoutEntry,
} from '../lib/spatial-monthly-readout';
import styles from './spatial-readiness-panel.module.css';

export interface ReadinessCopy {
  title: string;
  scopeNote: string;
  unknown: string;
  help: string;
  counts: Record<keyof ReadinessCounts, string>;
  questionLabels: Record<ReadinessQuestionId, string>;
  detailLabels: Record<string, string>;
  needLabels: Record<string, string>;
  needHeading: string;
  needLabel: string;
  stateLabel: string;
  sourcesLabel: string;
  recordsLabel: string;
  states: Record<NeedState, string>;
  inspect: string;
  selectNeed: string;
  factsUnavailable: string;
  usesHeading: string;
  useReasons: string;
  unknownUseReason: string;
  useRuleVersion: string;
  useReasonCodes: string;
  useLabels: Record<UseId, string>;
  useEligible: string;
  useBlocked: string;
  reportWindowsLabel: string;
  missingWindowsLabel: string;
  fieldNamesLabel: string;
  statusLabels: Record<keyof Material['status'], string>;
  gapLabel: string;
  none: string;
  staleLabel: string;
  questionStates: Record<'KNOWN' | 'PARTIAL' | 'UNKNOWN', string>;
  grains: Record<ReadinessGrain, string>;
  selectionHeading: string;
  activeScope: string;
  startMonth: string;
  endMonth: string;
  dateRole: string;
  dateRoles: Record<ReadinessSelection['dateRole'], string>;
  applyWindow: string;
  clearWindow: string;
  windowError: string;
  windowHelp: string;
  closeDetails: string;
  more: string;
  noDetails: string;
  emptyValue: string;
  owner: string;
  unassigned: string;
  processor: string;
  notRegistered: string;
  nextAction: string;
  fieldType: string;
  unit: string;
  technicalDetails: string;
  evidence: string;
  coverageModes: Record<'raw' | 'approved' | 'hypothetical', string>;
  hypotheticalNote: string;
  presentMonth: string;
  missingMonth: string;
  monthlyValuesTitle: string;
  monthlyValuesScroll: string;
  monthlyNull: string;
  monthlyMissingReason: string;
  monthlyCoverageUnknown: string;
  monthlyUnknownTime: string;
  monthlyBindingUnavailable: string;
  monthlyReferenceUnavailable: string;
  monthlyOutsideWindow: string;
  monthlyMoreMonths: string;
  monthlyMoreValues: string;
  monthlyMonthsCount: string;
  monthlyValuesCount: string;
  monthlyNumericNumber: string;
  monthlyNumericText: string;
  monthlyValueKinds: Record<ReadinessValueKind, string>;
  taskKinds: Record<'CLEANING' | 'QUALITY_CONTROL', string>;
  factStates: Record<string, string>;
  matrixTitle: string;
  matrixHelp: string;
  matrixUse: string;
  matrixWindowRecords: string;
  matrixAxes: Record<MatrixAxis, string>;
  matrixRegions: Record<RegionId, string>;
  usePendingReview: string;
}
export interface SpatialReadinessPanelProps {
  pack: WorkspacePack;
  regionId: RegionId;
  staleRecordIds?: readonly string[];
  facts?: ProjectReadinessInput | null;
  onSelectRecord?: (id: string) => void;
  onSelectRegion?: (id: RegionId) => void;
  selection?: ReadinessSelection;
  onSelectionChange?: (selection: ReadinessSelection) => void;
  onSelectScope?: (regionId: RegionId, selection: ReadinessSelection) => void;
  sourceHref?: (sourceId: string, versionId: string) => string;
  copy: ReadinessCopy;
}

const pageSize = 40;
const emptyStaleRecordIds: readonly string[] = Object.freeze([]);
export function SpatialReadinessPanel({
  pack,
  regionId,
  staleRecordIds = emptyStaleRecordIds,
  facts = null,
  onSelectRecord,
  onSelectRegion,
  selection,
  onSelectionChange,
  onSelectScope,
  sourceHref,
  copy,
}: SpatialReadinessPanelProps) {
  const [localNeedId, setNeedId] = useState('K5-001');
  const needId = selection?.needId ?? localNeedId;
  const [matrixUse, setMatrixUse] = useState<UseId>('archive');
  const [matrixSelection, setMatrixSelection] = useState<{
    base: RegionId;
    selected: RegionId;
  } | null>(null);
  const activeRegion = onSelectRegion
    ? regionId
    : matrixSelection?.base === regionId
      ? matrixSelection.selected
      : regionId;
  const [localWindow, setWindow] = useState(facts?.requirement.window ?? null);
  const window = selection ? selection.window : localWindow;
  const [startMonth, setStartMonth] = useState(window?.start ?? '');
  const [endMonth, setEndMonth] = useState(window?.end ?? '');
  const [localDateRole, setDateRole] = useState<ReadinessSelection['dateRole']>(
    facts?.requirement.dateRole ?? 'PUBLICATION',
  );
  const dateRole = selection?.dateRole ?? localDateRole;
  const track = selection?.track ?? 'REAL';
  useEffect(() => {
    if (!selection) return;
    setStartMonth(selection.window?.start ?? '');
    setEndMonth(selection.window?.end ?? '');
    setWindowError(false);
  }, [selection?.window?.start, selection?.window?.end]);
  function changeSelection(next: ReadinessSelection) {
    if (selection && onSelectionChange) onSelectionChange(next);
    else {
      setNeedId(next.needId);
      setDateRole(next.dateRole);
      setWindow(next.window);
    }
  }
  const [windowError, setWindowError] = useState(false);
  const [opened, setOpened] = useState<{
    id: ReadinessQuestionId;
    needId: string;
    regionId: RegionId;
    scope: string;
  } | null>(null);
  const [limit, setLimit] = useState(pageSize);
  const [monthLimit, setMonthLimit] = useState(12);
  const [valueLimit, setValueLimit] = useState(pageSize);
  const [coverageMode, setCoverageMode] = useState<
    'raw' | 'approved' | 'hypothetical'
  >('raw');
  const inspector = useRef<HTMLElement>(null);
  const result = useMemo(
    () =>
      buildReadiness(pack, activeRegion, staleRecordIds, facts, {
        needId,
        window,
        dateRole,
        track,
      }),
    [
      pack,
      activeRegion,
      staleRecordIds,
      facts,
      needId,
      window,
      dateRole,
      track,
    ],
  );
  const matrix = useMemo(
    () =>
      buildReadinessMatrix(pack, staleRecordIds, facts, {
        window,
        dateRole,
        track,
      }),
    [pack, staleRecordIds, facts, window, dateRole, track],
  );
  const label = (code: string) => copy.detailLabels[code] ?? copy.unknown;
  const reasonList = (reasons: readonly string[]) =>
    reasons.length ? (
      <div role="list" aria-label={copy.useReasons}>
        {reasons.map((code, index) => (
          <p role="listitem" key={`${index}:${code}`}>
            {Object.hasOwn(copy.detailLabels, code)
              ? copy.detailLabels[code]
              : copy.unknownUseReason}
          </p>
        ))}
      </div>
    ) : null;
  const useTechnicalDetails = (
    reasons: readonly string[],
    ruleVersion: string,
  ) => (
    <dl>
      <dt>{copy.useRuleVersion}</dt>
      <dd>
        <code>{ruleVersion}</code>
      </dd>
      <dt>{copy.useReasonCodes}</dt>
      <dd>
        {reasons.length
          ? reasons.map((code, index) => (
              <p key={`${index}:${code}`}>
                <code>{code}</code>
              </p>
            ))
          : copy.none}
      </dd>
    </dl>
  );
  // A detail list cannot survive a changed source/version/readability or fact set.
  const scope = JSON.stringify([
    window,
    dateRole,
    track,
    facts?.requirement.version,
    pack.processingVersion,
    pack.sources.map((source) => [
      source.id,
      source.versionId,
      source.originalSha256,
      source.rights.displayAllowed,
    ]),
    staleRecordIds,
    result.project.records,
    result.project.checks,
    result.project.fields,
    result.project.tasks,
    result.project.useChecks,
  ]);
  const selected =
    opened?.needId === needId &&
    opened.regionId === activeRegion &&
    opened.scope === scope
      ? result.questions.find((question) => question.id === opened.id)
      : null;
  const rows = result.project.monthly[coverageMode];
  const currentRecordById = useMemo(() => {
    const records = new Map<string, WorkspaceRecord | null>();
    for (const record of result.records) {
      records.set(record.id, records.has(record.id) ? null : record);
    }
    return records;
  }, [result.records]);
  const currentSourceByVersion = useMemo(() => {
    const sources = new Map<string, Material | null>();
    for (const source of pack.sources) {
      if (!source.rights.displayAllowed) continue;
      const key = JSON.stringify([source.id, source.versionId]);
      sources.set(key, sources.has(key) ? null : source);
    }
    return sources;
  }, [pack.sources]);
  const monthlyRows = useMemo(
    () => buildMonthlyReadout(result.project, coverageMode),
    [result.project, coverageMode],
  );
  const maximumMonths = monthlyRows.reduce(
    (count, row) => Math.max(count, row.cells.length),
    0,
  );
  const maximumValues = monthlyRows.reduce(
    (count, row) =>
      Math.max(
        count,
        row.unknownTimeEntries.length,
        row.unresolvedRecordKeys.length +
          row.unknownTimeEntries.length +
          row.cells.reduce((count, cell) => count + cell.entries.length, 0),
        ...row.cells.map((cell) => cell.entries.length),
      ),
    0,
  );
  function open(id: ReadinessQuestionId) {
    setOpened({ id, needId, regionId: activeRegion, scope });
    setLimit(pageSize);
    setMonthLimit(12);
    setValueLimit(pageSize);
    setCoverageMode('raw');
    // The section remains in the document; keyboard users can continue at its heading.
    if (typeof requestAnimationFrame === 'function')
      requestAnimationFrame(() => inspector.current?.focus());
  }
  function applyWindow() {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/;
    const ordinal = (value: string) =>
      Number(value.slice(0, 4)) * 12 + Number(value.slice(5));
    if (
      !month.test(startMonth) ||
      !month.test(endMonth) ||
      startMonth > endMonth ||
      ordinal(endMonth) - ordinal(startMonth) >= 1200
    ) {
      setWindowError(true);
      return;
    }
    setWindowError(false);
    changeSelection({
      track,
      needId,
      dateRole,
      window: { start: startMonth, end: endMonth },
    });
  }
  function recordButton(id: string, expectedRecordKey?: string) {
    const record = currentRecordById.get(id);
    if (!record) return null;
    const source = currentSourceByVersion.get(
      JSON.stringify([record.sourceId, record.versionId]),
    );
    if (
      !source ||
      (expectedRecordKey !== undefined &&
        readinessRecordKey({ id, source: materialReference(source) }) !==
          expectedRecordKey)
    )
      return null;
    const fact = result.project.records.find((item) => item.id === id);
    return (
      <button
        key={id}
        type="button"
        onClick={() => onSelectRecord?.(id)}
        disabled={!onSelectRecord}
      >
        <strong>{record.objectLabel}</strong>
        <span>
          {source.title} · {fact?.time.value ?? copy.unknown} · {record.metric}{' '}
          ·{' '}
          {record.value === null
            ? copy.unknown
            : record.value === ''
              ? copy.emptyValue
              : record.value}
        </span>
      </button>
    );
  }
  function shownCount(template: string, shown: number, total: number) {
    return template
      .replace('{shown}', String(shown))
      .replace('{total}', String(total));
  }
  function monthlyValue(entry: MonthlyReadoutEntry) {
    // The existing callback accepts one workspace ID. Never choose a first
    // match when that ID or its original-source binding is ambiguous.
    const record = currentRecordById.get(entry.record.id);
    const source = record
      ? currentSourceByVersion.get(
          JSON.stringify([record.sourceId, record.versionId]),
        )
      : undefined;
    const resolved =
      record &&
      source &&
      readinessRecordKey({
        id: record.id,
        source: materialReference(source),
      }) === entry.recordKey &&
      readinessRecordKey(entry.record) === entry.recordKey;
    const content = (
      <>
        <strong>
          {entry.value.raw === null
            ? copy.monthlyNull
            : entry.value.raw === ''
              ? copy.emptyValue
              : entry.value.raw}
        </strong>
        <span>
          {copy.monthlyValueKinds[entry.value.kind]}
          {entry.value.kind === 'NUMERIC' && (
            <>
              {' '}
              ·{' '}
              {typeof entry.value.raw === 'number'
                ? copy.monthlyNumericNumber
                : copy.monthlyNumericText}
            </>
          )}
        </span>
        {resolved && <span>{source.title}</span>}
      </>
    );
    return (
      <li key={entry.recordKey} data-readout-value-kind={entry.value.kind}>
        {resolved ? (
          <button
            type="button"
            onClick={() => onSelectRecord?.(record.id)}
            disabled={!onSelectRecord}
          >
            {content}
          </button>
        ) : (
          <div>
            {content}
            <p data-testid="readiness-monthly-unresolved-selection">
              {copy.monthlyBindingUnavailable}
            </p>
          </div>
        )}
        {resolved && sourceHref && (
          <a href={sourceHref(source.id, source.versionId)}>{copy.evidence}</a>
        )}
        <details>
          <summary>{copy.technicalDetails}</summary>
          <dl>
            <dt>{copy.grains.WORK}</dt>
            <dd>{entry.record.source.workId}</dd>
            <dt>{copy.grains.VERSION}</dt>
            <dd>{entry.record.source.versionId}</dd>
            <dt>{copy.grains.ASSET}</dt>
            <dd>{entry.record.source.assetId}</dd>
            <dt>{copy.grains.RECORD}</dt>
            <dd>{entry.record.id}</dd>
            <dt>{copy.evidence}</dt>
            <dd>
              {entry.record.evidence.map((evidence, index) => (
                <p key={`${index}:${evidence.locator}`}>
                  {evidence.locator} · {evidence.excerpt}
                </p>
              ))}
            </dd>
          </dl>
        </details>
      </li>
    );
  }
  return (
    <section className={styles.panel} aria-label={copy.title}>
      <h2>
        {copy.title}{' '}
        <ContextHelp label={copy.help}>{copy.scopeNote}</ContextHelp>
      </h2>
      <section className={styles.matrix} aria-label={copy.matrixTitle}>
        <h3>
          {copy.matrixTitle}{' '}
          <ContextHelp label={copy.help}>{copy.matrixHelp}</ContextHelp>
        </h3>
        <p>
          {copy.sourcesLabel}: {matrix.totals.sources} · {copy.recordsLabel}:{' '}
          {matrix.totals.records}
        </p>
        <label>
          {copy.matrixUse}
          <select
            aria-label={copy.matrixUse}
            value={matrixUse}
            onChange={(event) => setMatrixUse(event.target.value as UseId)}
          >
            {Object.entries(copy.useLabels).map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.matrixScroll} tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{copy.needLabel}</th>
                {MATRIX_REGIONS.map((id) => (
                  <th key={id} scope="col">
                    {copy.matrixRegions[id]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NEED_IDS.map((id) => (
                <tr key={id}>
                  <th scope="row">
                    {id}
                    <small>{copy.needLabels[id] ?? copy.unknown}</small>
                  </th>
                  {MATRIX_REGIONS.map((region) => {
                    const cell = matrix.cells.find(
                      (item) => item.regionId === region && item.needId === id,
                    )!;
                    const use = cell.uses.find(
                      (item) => item.id === matrixUse,
                    )!;
                    return (
                      <td key={region}>
                        <button
                          type="button"
                          data-matrix-region={region}
                          data-matrix-need={id}
                          aria-pressed={
                            activeRegion === region && needId === id
                          }
                          aria-label={`${copy.matrixRegions[region]} · ${id} · ${copy.needLabels[id] ?? copy.unknown} · ${copy.recordsLabel}: ${cell.counts.records} · ${copy.factStates[use.state] ?? copy.unknown}`}
                          onFocus={(event) => {
                            const button = event.currentTarget;
                            const scroller =
                              button.closest('table')?.parentElement;
                            const header = button
                              .closest('tr')
                              ?.querySelector('th[scope="row"]');
                            if (!scroller || !header) return;
                            const container = scroller.getBoundingClientRect();
                            const left = Math.max(
                              container.left + scroller.clientLeft,
                              header.getBoundingClientRect().right,
                            );
                            const right =
                              container.left +
                              scroller.clientLeft +
                              scroller.clientWidth;
                            const target = button.getBoundingClientRect();
                            if (target.left < left + 4)
                              scroller.scrollLeft += target.left - left - 4;
                            else if (target.right > right - 4)
                              scroller.scrollLeft += target.right - right + 4;
                          }}
                          onClick={() => {
                            if (onSelectScope) {
                              onSelectScope(region, {
                                track,
                                needId: id,
                                window,
                                dateRole,
                              });
                              setOpened(null);
                              return;
                            }
                            if (!onSelectRegion)
                              setMatrixSelection({
                                base: regionId,
                                selected: region,
                              });
                            changeSelection({
                              track,
                              needId: id,
                              window,
                              dateRole,
                            });
                            setOpened(null);
                            onSelectRegion?.(region);
                          }}
                        >
                          <strong>
                            {cell.counts.records}{' '}
                            <small>{copy.recordsLabel}</small>
                          </strong>
                          {window && (
                            <span>
                              {copy.matrixWindowRecords}:{' '}
                              {cell.windowRecordIds.length}
                            </span>
                          )}
                          <span className={styles.matrixAxes}>
                            {(Object.keys(cell.axes) as MatrixAxis[]).map(
                              (axis) => (
                                <span
                                  key={axis}
                                  data-state={cell.axes[axis].state}
                                  title={`${copy.matrixAxes[axis]}: ${copy.questionStates[cell.axes[axis].state as keyof typeof copy.questionStates] ?? copy.factStates[cell.axes[axis].state] ?? copy.unknown}`}
                                >
                                  {copy.matrixAxes[axis]} ·{' '}
                                  {cell.axes[axis].state === 'UNKNOWN'
                                    ? copy.unknown
                                    : (copy.questionStates[
                                        cell.axes[axis]
                                          .state as keyof typeof copy.questionStates
                                      ] ??
                                      copy.factStates[cell.axes[axis].state] ??
                                      copy.unknown)}
                                </span>
                              ),
                            )}
                          </span>
                          <span data-use-state={use.state}>
                            {copy.factStates[use.state] ?? copy.unknown}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <fieldset className={styles.selection}>
        <legend>{copy.selectionHeading}</legend>
        <label>
          {copy.needLabel}
          <select
            aria-label={copy.needLabel}
            value={needId}
            onChange={(event) =>
              changeSelection({
                track,
                needId: event.target.value,
                window,
                dateRole,
              })
            }
          >
            {NEED_IDS.map((id) => (
              <option key={id} value={id}>
                {id} · {copy.needLabels[id] ?? copy.unknown}
              </option>
            ))}
          </select>
        </label>
        <label>
          {copy.startMonth}
          <input
            type="month"
            value={startMonth}
            onChange={(event) => setStartMonth(event.target.value)}
          />
        </label>
        <label>
          {copy.endMonth}
          <input
            type="month"
            value={endMonth}
            onChange={(event) => setEndMonth(event.target.value)}
          />
        </label>
        <label>
          {copy.dateRole}
          <select
            aria-label={copy.dateRole}
            value={dateRole}
            onChange={(event) =>
              changeSelection({
                track,
                needId,
                window,
                dateRole: event.target.value as ReadinessSelection['dateRole'],
              })
            }
          >
            {Object.entries(copy.dateRoles).map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={applyWindow}>
          {copy.applyWindow}
        </button>
        <button
          type="button"
          onClick={() => {
            changeSelection({ track, needId, dateRole, window: null });
            setStartMonth('');
            setEndMonth('');
            setWindowError(false);
          }}
        >
          {copy.clearWindow}
        </button>
        <ContextHelp label={copy.help}>{copy.windowHelp}</ContextHelp>
        {windowError && <p role="alert">{copy.windowError}</p>}
      </fieldset>
      <p data-testid="readiness-active-scope">
        {copy.activeScope}: {copy.matrixRegions[activeRegion]} · {needId} ·{' '}
        {copy.dateRoles[dateRole]} ·{' '}
        {window ? `${window.start} — ${window.end}` : copy.unknown}
      </p>
      <dl className={styles.counts}>
        {(Object.keys(result.counts) as (keyof ReadinessCounts)[]).map(
          (key) => (
            <div key={key} data-readiness-count={key}>
              <dt>{copy.counts[key]}</dt>
              <dd>{result.counts[key] ?? copy.unknown}</dd>
            </div>
          ),
        )}
      </dl>
      {!!result.staleRecordIds.length && (
        <p role="status" className={styles.stale}>
          {copy.staleLabel}: {result.staleRecordIds.length}
        </p>
      )}
      <div className={styles.questions}>
        {result.questions.map((question) => (
          <article key={question.id}>
            <div className={styles.questionHeading}>
              <h3>{copy.questionLabels[question.id]}</h3>
              <span data-state={question.state}>
                {copy.questionStates[question.state]}
              </span>
            </div>
            {!!question.detailCodes.length && (
              <ContextHelp label={copy.help}>
                {question.detailCodes.map(label).join(' · ')}
              </ContextHelp>
            )}
            {question.id === 'structure' && (
              <p>
                {copy.fieldNamesLabel}:{' '}
                {result.fields.join(' / ') || copy.unknown}
              </p>
            )}
            {question.id === 'density' && (
              <p>
                {copy.reportWindowsLabel}:{' '}
                {result.density.reportWindows.join(', ') || copy.unknown}
              </p>
            )}
            {question.details.length > 0 ? (
              <button type="button" onClick={() => open(question.id)}>
                {copy.inspect}
              </button>
            ) : (
              <p>{copy.noDetails}</p>
            )}
          </article>
        ))}
      </div>
      {selected && (
        <section
          ref={inspector}
          tabIndex={-1}
          className={styles.inspector}
          aria-label={copy.questionLabels[selected.id]}
        >
          <div className={styles.questionHeading}>
            <h3>{copy.questionLabels[selected.id]}</h3>
            <button type="button" onClick={() => setOpened(null)}>
              {copy.closeDetails}
            </button>
          </div>
          {(selected.id === 'density' || selected.id === 'gaps') &&
            result.project.monthly.raw.length > 0 && (
              <>
                <div className={styles.coverageModes}>
                  {(['raw', 'approved', 'hypothetical'] as const)
                    .filter(
                      (mode) =>
                        mode === 'raw' ||
                        (mode === 'approved'
                          ? result.project.monthly.appliedApprovedIds.length
                          : result.project.monthly.appliedHypothesisIds.length),
                    )
                    .map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={coverageMode === mode}
                        onClick={() => {
                          setCoverageMode(mode);
                          setLimit(pageSize);
                          setMonthLimit(12);
                          setValueLimit(pageSize);
                        }}
                      >
                        {copy.coverageModes[mode]}
                      </button>
                    ))}
                </div>
                {coverageMode === 'hypothetical' && (
                  <p role="status">{copy.hypotheticalNote}</p>
                )}
                <section
                  className={styles.monthlyReadout}
                  aria-label={copy.monthlyValuesTitle}
                  data-testid="readiness-monthly-values"
                >
                  <h4>{copy.monthlyValuesTitle}</h4>
                  <div
                    className={styles.monthlyReadoutScroll}
                    role="region"
                    tabIndex={0}
                    aria-label={copy.monthlyValuesScroll}
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>{copy.grains.SOURCE_OBJECT}</th>
                          <th>{copy.monthlyValuesTitle}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {monthlyRows.slice(0, limit).map((row) => (
                          <tr key={JSON.stringify(row.objectKeys)}>
                            <th scope="row">{row.originalNames.join(' ↔ ')}</th>
                            <td>
                              {!row.coverageKnown && (
                                <p>{copy.monthlyCoverageUnknown}</p>
                              )}
                              {row.cells.length > monthLimit && (
                                <p>
                                  {shownCount(
                                    copy.monthlyMonthsCount,
                                    monthLimit,
                                    row.cells.length,
                                  )}
                                </p>
                              )}
                              <div className={styles.monthlyCells}>
                                {row.cells.slice(0, monthLimit).map((cell) => (
                                  <div
                                    key={cell.month}
                                    data-readout-month={cell.month}
                                    data-readout-state={cell.state}
                                  >
                                    <h5>{cell.month}</h5>
                                    {cell.state === 'PRESENT' && (
                                      <p>{copy.presentMonth}</p>
                                    )}
                                    {!cell.required &&
                                      result.project.monthly.requiredMonths !==
                                        null && (
                                        <p>{copy.monthlyOutsideWindow}</p>
                                      )}
                                    {cell.state === 'PRESENT' ? (
                                      <>
                                        {cell.entries.length > valueLimit && (
                                          <p>
                                            {shownCount(
                                              copy.monthlyValuesCount,
                                              valueLimit,
                                              cell.entries.length,
                                            )}
                                          </p>
                                        )}
                                        <ul className={styles.monthlyValues}>
                                          {cell.entries
                                            .slice(0, valueLimit)
                                            .map(monthlyValue)}
                                        </ul>
                                      </>
                                    ) : (
                                      <p>
                                        {cell.state === 'MISSING'
                                          ? copy.monthlyMissingReason
                                          : copy.monthlyCoverageUnknown}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                              {row.unknownTimeEntries.length > 0 && (
                                <div data-testid="readiness-unknown-month-values">
                                  <h5>{copy.monthlyUnknownTime}</h5>
                                  {row.unknownTimeEntries.length >
                                    valueLimit && (
                                    <p>
                                      {shownCount(
                                        copy.monthlyValuesCount,
                                        valueLimit,
                                        row.unknownTimeEntries.length,
                                      )}
                                    </p>
                                  )}
                                  <ul className={styles.monthlyValues}>
                                    {row.unknownTimeEntries
                                      .slice(0, valueLimit)
                                      .map(monthlyValue)}
                                  </ul>
                                </div>
                              )}
                              {row.unresolvedRecordKeys.length > 0 && (
                                <p role="status">
                                  {copy.monthlyReferenceUnavailable}
                                </p>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {maximumMonths > monthLimit && (
                    <button
                      type="button"
                      onClick={() => setMonthLimit(monthLimit + 12)}
                    >
                      {copy.monthlyMoreMonths} ({monthLimit}/{maximumMonths})
                    </button>
                  )}
                  {maximumValues > valueLimit && (
                    <button
                      type="button"
                      onClick={() => setValueLimit(valueLimit + pageSize)}
                    >
                      {copy.monthlyMoreValues} ({valueLimit}/{maximumValues})
                    </button>
                  )}
                </section>
                <div className={styles.tableScroll}>
                  <table aria-label={copy.reportWindowsLabel}>
                    <thead>
                      <tr>
                        <th>{copy.grains.SOURCE_OBJECT}</th>
                        <th>{copy.reportWindowsLabel}</th>
                        <th>{copy.missingWindowsLabel}</th>
                        <th>{copy.recordsLabel}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, limit).map((row) => (
                        <tr key={JSON.stringify(row.objectKeys)}>
                          <th scope="row">{row.originalNames.join(' ↔ ')}</th>
                          <td>
                            {row.observedMonths.join(', ') || copy.unknown}
                          </td>
                          <td>
                            {row.missingMonths === null
                              ? copy.unknown
                              : row.missingMonths.join(', ') || copy.none}
                          </td>
                          <td>
                            <details>
                              <summary>{row.recordIds.length}</summary>
                              {row.recordIds.length > valueLimit && (
                                <p>
                                  {shownCount(
                                    copy.monthlyValuesCount,
                                    valueLimit,
                                    row.recordIds.length,
                                  )}
                                </p>
                              )}
                              {result.project.records
                                .filter((record) =>
                                  row.recordIds.includes(
                                    readinessRecordKey(record),
                                  ),
                                )
                                .slice(0, valueLimit)
                                .map((record) =>
                                  recordButton(
                                    record.id,
                                    readinessRecordKey(record),
                                  ),
                                )}
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > limit && (
                  <button
                    type="button"
                    onClick={() => setLimit(limit + pageSize)}
                  >
                    {copy.more} ({Math.min(limit, rows.length)}/{rows.length})
                  </button>
                )}
              </>
            )}
          {[...new Set(selected.details.map((detail) => detail.grain))].map(
            (grain) => {
              const entries = selected.details.filter(
                (detail) => detail.grain === grain,
              );
              return (
                <details
                  key={grain}
                  open={
                    grain === 'RECORD' ||
                    selected.details.every((detail) => detail.grain === grain)
                  }
                >
                  <summary>
                    {copy.grains[grain]} ({entries.length})
                  </summary>
                  <div
                    role="group"
                    aria-label={copy.grains[grain]}
                    className={styles.detailList}
                  >
                    {entries.slice(0, limit).map((entry) => {
                      const task =
                        grain === 'TASK'
                          ? result.project.tasks.find(
                              (item) => item.id === entry.factId,
                            )
                          : undefined;
                      const check =
                        grain === 'CHECK'
                          ? result.project.checks.find(
                              (item) => item.id === entry.factId,
                            )
                          : undefined;
                      const field =
                        grain === 'FIELD'
                          ? result.project.fields.find(
                              (item) => item.id === entry.factId,
                            )
                          : undefined;
                      const use =
                        grain === 'USE_CHECK'
                          ? result.project.useChecks.find(
                              (item) => item.id === entry.factId,
                            )
                          : undefined;
                      const correspondence =
                        grain === 'CORRESPONDENCE'
                          ? facts?.correspondences.find(
                              (item) => item.id === entry.factId,
                            )
                          : undefined;
                      return (
                        <div key={entry.key}>
                          {grain === 'RECORD' ? (
                            recordButton(entry.recordIds[0])
                          ) : (
                            <>
                              <strong>
                                {entry.title ||
                                  (task
                                    ? copy.taskKinds[task.kind]
                                    : copy.grains[grain])}
                                {entry.month ? ` · ${entry.month}` : ''}
                              </strong>
                              {entry.month && (
                                <span>
                                  {entry.missing
                                    ? copy.missingMonth
                                    : copy.presentMonth}
                                </span>
                              )}
                              {task && (
                                <dl>
                                  <dt>{copy.stateLabel}</dt>
                                  <dd>
                                    {copy.factStates[task.state] ??
                                      copy.unknown}
                                  </dd>
                                  <dt>{copy.owner}</dt>
                                  <dd>{task.owner ?? copy.unassigned}</dd>
                                  <dt>{copy.processor}</dt>
                                  <dd>
                                    {task.processor
                                      ? `${task.processor.name} · ${task.processor.version}`
                                      : copy.notRegistered}
                                  </dd>
                                  <dt>{copy.nextAction}</dt>
                                  <dd>{task.nextAction ?? copy.unknown}</dd>
                                </dl>
                              )}
                              {check && (
                                <>
                                  <p>
                                    {copy.factStates[check.state] ??
                                      copy.unknown}
                                  </p>
                                  <ul>
                                    {check.findings.map((finding) => (
                                      <li key={finding}>{label(finding)}</li>
                                    ))}
                                  </ul>
                                </>
                              )}
                              {field && (
                                <dl>
                                  <dt>{copy.fieldType}</dt>
                                  <dd>{field.type || copy.unknown}</dd>
                                  <dt>{copy.unit}</dt>
                                  <dd>{field.unit ?? copy.unknown}</dd>
                                </dl>
                              )}
                              {use && (
                                <>
                                  <p>
                                    {copy.factStates[use.state] ?? copy.unknown}
                                  </p>
                                  {reasonList(use.reasons)}
                                </>
                              )}
                              {correspondence && (
                                <p>
                                  {copy.factStates[correspondence.status] ??
                                    copy.unknown}
                                </p>
                              )}
                              {sourceHref &&
                                ['WORK', 'VERSION', 'ASSET'].includes(grain) &&
                                result.sources
                                  .filter((source) =>
                                    entry.sourceRefs.some(
                                      (ref) =>
                                        fixedSourceKey(ref) ===
                                        fixedSourceKey(
                                          materialReference(source),
                                        ),
                                    ),
                                  )
                                  .map((source) => (
                                    <a
                                      key={`${source.id}:${source.versionId}`}
                                      href={sourceHref(
                                        source.id,
                                        source.versionId,
                                      )}
                                    >
                                      {source.title}
                                    </a>
                                  ))}
                              {!!entry.recordIds.length && (
                                <details>
                                  <summary>
                                    {copy.recordsLabel} (
                                    {entry.recordIds.length})
                                  </summary>
                                  {entry.recordIds
                                    .slice(0, limit)
                                    .map((id) => recordButton(id))}
                                  {entry.recordIds.length > limit && (
                                    <button
                                      type="button"
                                      onClick={() => setLimit(limit + pageSize)}
                                    >
                                      {copy.more} ({limit}/
                                      {entry.recordIds.length})
                                    </button>
                                  )}
                                </details>
                              )}
                              {!!(
                                task?.evidence ??
                                check?.evidence ??
                                field?.evidence ??
                                use?.evidence ??
                                correspondence?.evidence
                              )?.length && (
                                <details>
                                  <summary>{copy.evidence}</summary>
                                  {(
                                    task?.evidence ??
                                    check?.evidence ??
                                    field?.evidence ??
                                    use?.evidence ??
                                    correspondence?.evidence
                                  )?.map((item, index) => (
                                    <blockquote key={index}>
                                      {item.excerpt}
                                    </blockquote>
                                  ))}
                                </details>
                              )}
                              <details>
                                <summary>{copy.technicalDetails}</summary>
                                <code>{entry.key}</code>
                                {use &&
                                  useTechnicalDetails(
                                    use.reasons,
                                    result.project.ruleVersion,
                                  )}
                              </details>
                            </>
                          )}
                        </div>
                      );
                    })}
                    {entries.length > limit && (
                      <button
                        type="button"
                        onClick={() => setLimit(limit + pageSize)}
                      >
                        {copy.more} ({Math.min(limit, entries.length)}/
                        {entries.length})
                      </button>
                    )}
                  </div>
                </details>
              );
            },
          )}
        </section>
      )}
      <details className={styles.needs}>
        <summary>{copy.needHeading}</summary>
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th>{copy.needLabel}</th>
                <th>{copy.stateLabel}</th>
                <th>{copy.sourcesLabel}</th>
                <th>{copy.recordsLabel}</th>
                <th>{copy.gapLabel}</th>
              </tr>
            </thead>
            <tbody>
              {result.needs.map((need) => (
                <tr key={need.id}>
                  <th scope="row">
                    <span>{need.id}</span>
                    <small>{copy.needLabels[need.id]}</small>
                  </th>
                  <td>{copy.states[need.state]}</td>
                  <td>{need.sourceIds.length}</td>
                  <td>
                    {need.recordIds.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setNeedId(need.id);
                          setOpened(null);
                        }}
                      >
                        {copy.selectNeed} ({need.recordIds.length})
                      </button>
                    ) : (
                      need.recordIds.length
                    )}
                  </td>
                  <td>
                    {need.missingReasons.map(label).join(' · ') || copy.unknown}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className={styles.uses}>
        <summary>{copy.usesHeading}</summary>
        <ul>
          {result.uses.map((use) => (
            <li key={use.id}>
              <strong>{copy.useLabels[use.id]}</strong>
              <span data-use-state={use.state}>
                {copy.factStates[use.state] ?? copy.unknown}
              </span>
              {use.eligible ? (
                <span>{copy.useEligible}</span>
              ) : use.state === 'CHECKS_PASSED' ? (
                <span>{copy.usePendingReview}</span>
              ) : null}
              {reasonList(use.reasons)}
              <details>
                <summary>{copy.technicalDetails}</summary>
                {useTechnicalDetails(use.reasons, use.ruleVersion)}
              </details>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
