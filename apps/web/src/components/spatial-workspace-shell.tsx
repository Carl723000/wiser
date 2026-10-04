'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectReadinessInput } from '@wiser/data-core';
import { getDictionary, type Locale } from '@/lib/i18n';
import type { RegionId, WorkspacePack } from '@/lib/spatial-workspace-contract';
import { versionImpact } from '@/lib/spatial-version-impact';
import type { WorkspaceInvalidation } from '@/lib/spatial-workspace-view';
import {
  decodeWorkspaceReadingUrl,
  encodeWorkspaceReadingUrl,
  type WorkspaceReadingUrlState,
} from '@/lib/spatial-workspace-url-state';
import {
  defaultWorkspaceReadingState,
  scopeWorkspaceReadingPack,
  withWorkspaceReadingRecord,
  workspaceReadingSourcePin,
} from '@/lib/spatial-workspace-reading-view';
import type { ReadinessSelection } from '@/lib/spatial-readiness-facts';
import type { PublicReferences } from '@/lib/spatial-public-reference';
import { ContextHelp } from './context-help';
import { ExplorationWorkspace } from './exploration-workspace';
import { SpatialWorkspace } from './spatial-workspace';
import { SpatialReadinessPanel } from './spatial-readiness-panel';
import {
  SpatialCandidateReview,
  type CandidateExerciseContext,
} from './spatial-candidate-review';
import { SpatialRasterInspection } from './spatial-raster-inspection';
import styles from './spatial-workspace-shell.module.css';

const noInvalidations: readonly WorkspaceInvalidation[] = [];

export function SpatialWorkspaceShell({
  pack,
  locale,
  initialRecordId = null,
  initialReadingState,
  readinessFacts = null,
  readinessState = 'absent',
  publicReferences = null,
  publicReferenceState = 'absent',
}: {
  pack: WorkspacePack;
  locale: Locale;
  initialRecordId?: string | null;
  initialReadingState?: WorkspaceReadingUrlState;
  readinessFacts?: ProjectReadinessInput | null;
  readinessState?: 'absent' | 'ready' | 'invalid' | 'unavailable';
  publicReferences?: PublicReferences | null;
  publicReferenceState?: 'absent' | 'ready' | 'invalid' | 'unavailable';
}) {
  const dictionary = getDictionary(locale).dataFoundation;
  const copy = dictionary.spatialManagement;
  const [reading, setReading] = useState<WorkspaceReadingUrlState>(() => {
    if (initialReadingState) return initialReadingState;
    const base = defaultWorkspaceReadingState();
    const record = pack.records.find((item) => item.id === initialRecordId);
    return record
      ? (withWorkspaceReadingRecord(
          pack,
          {
            ...base,
            regionId: record.regionIds.find((id) => id !== 'bth') ?? 'bth',
            pane: 'evidence',
          },
          { recordId: record.id, positionId: null },
        ) ?? base)
      : base;
  });
  const [invalidNavigation, setInvalidNavigation] = useState(false);
  const readingRef = useRef(reading);
  readingRef.current = reading;
  const regionId = reading.regionId ?? 'bth';
  const selectedRecordId = reading.selection?.recordId ?? null;
  const [exerciseTab, setExerciseTab] =
    useState<WorkspaceReadingUrlState['tab']>('spatial');
  const initialKey = JSON.stringify(initialReadingState);
  useEffect(() => {
    if (initialReadingState) setReading(initialReadingState);
    setInvalidNavigation(false);
  }, [initialKey]);
  useEffect(() => {
    const restore = () => {
      const decoded = decodeWorkspaceReadingUrl(
        new URLSearchParams(window.location.search),
        { pack },
      );
      if (decoded.status === 'invalid') setInvalidNavigation(true);
      else {
        setReading(
          decoded.status === 'valid'
            ? decoded.state
            : defaultWorkspaceReadingState(),
        );
        setInvalidNavigation(false);
      }
      setExerciseTarget(null);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [pack]);
  function commitReading(next: WorkspaceReadingUrlState) {
    const encoded = encodeWorkspaceReadingUrl(locale, next, { pack });
    if (encoded.status !== 'valid') {
      setInvalidNavigation(true);
      return;
    }
    readingRef.current = next;
    setReading(next);
    setInvalidNavigation(false);
    const path = `/${locale}/data-foundation/spatial-workspace`;
    if (
      window.location.pathname === path &&
      `${window.location.pathname}${window.location.search}` !== encoded.href
    )
      window.history.pushState(null, '', encoded.href);
  }
  function changeRegion(id: RegionId) {
    commitReading({
      ...readingRef.current,
      regionId: id,
      source: null,
      selection: null,
    });
  }
  function changeReadiness(
    selection: ReadinessSelection,
    region: RegionId = readingRef.current.regionId ?? 'bth',
  ) {
    const { dayWindow: _days, ...current } = readingRef.current;
    commitReading({
      ...current,
      track: selection.track ?? current.track ?? 'REAL',
      regionId: region,
      needId: selection.needId,
      dateRole: selection.dateRole,
      monthWindow: selection.window,
      source: null,
      selection: null,
    });
  }
  const [exerciseTarget, setExerciseTarget] = useState<string | null>(null);
  const [exerciseRegionId, setExerciseRegionId] = useState<RegionId>('bth');
  const [exerciseSelectedId, setExerciseSelectedId] = useState<string | null>(
    null,
  );
  const selected =
    pack.records.find((item) => item.id === selectedRecordId) ?? null;
  const target = pack.records.find((item) => item.id === exerciseTarget);
  // This is a dependency preview of an independent synthetic exercise. No real
  // record, source state or professional decision is changed or persisted.
  const impact = useMemo(
    () =>
      target
        ? versionImpact(
            pack.records,
            [
              {
                sourceId: target.sourceId,
                previousVersionId: target.versionId,
                nextVersionId: target.versionId,
                reason: 'rule-changed',
                previousProcessingVersion: target.processingVersion,
                scope: { kind: 'records', recordIds: [target.id] },
              },
            ],
            pack.topicPackages,
          )
        : null,
    [target, pack],
  );
  const invalidations = useMemo(
    () =>
      target && impact
        ? [
            {
              sourceId: target.sourceId,
              versionId: target.versionId,
              state: 'stale' as const,
              reason: copy.regenerated,
              affectedRecordIds: impact.recordIds,
            },
          ]
        : [],
    [target, impact, copy.regenerated],
  );
  const tab = impact ? (exerciseTab ?? 'spatial') : (reading.tab ?? 'spatial');
  const visiblePack = useMemo(
    () => scopeWorkspaceReadingPack(pack, reading),
    [pack, reading.track, reading.needId, reading.regionId],
  );
  const readinessDateRole =
    reading.dateRole === null ||
    reading.dateRole === 'PUBLICATION' ||
    reading.dateRole === 'OBSERVATION' ||
    reading.dateRole === 'EVENT'
      ? (reading.dateRole ?? 'PUBLICATION')
      : null;
  function selectRecord(id: string) {
    const item = pack.records.find((record) => record.id === id);
    if (!item) return;
    if (impact) {
      setExerciseSelectedId(id);
      setExerciseRegionId(
        item.regionIds.find((region) => region !== 'bth') ?? 'bth',
      );
      setExerciseTab('spatial');
      return;
    }
    const current = readingRef.current;
    const localRegions = item.regionIds.filter((value) => value !== 'bth');
    const region =
      current.regionId === 'bth' && localRegions.length === 1
        ? localRegions[0]
        : current.regionId === null ||
            current.regionId === 'bth' ||
            item.regionIds.includes(current.regionId)
          ? current.regionId
          : localRegions.length === 1
            ? localRegions[0]
            : current.regionId;
    const next = withWorkspaceReadingRecord(
      pack,
      { ...current, regionId: region, tab: 'spatial', pane: 'evidence' },
      { recordId: item.id, positionId: null },
    );
    if (next) commitReading(next);
    else setInvalidNavigation(true);
  }
  function sourceHref(sourceId: string, versionId: string) {
    const source = workspaceReadingSourcePin(pack, sourceId, versionId);
    if (!source) return `/${locale}/data-foundation/spatial-workspace/source`;
    const current = readingRef.current;
    const material = pack.sources.find(
      (item) => item.id === sourceId && item.versionId === versionId,
    )!;
    const keepSelection =
      current.source?.sourceId === sourceId &&
      current.source.versionId === versionId;
    const next = {
      ...current,
      track: material.track ?? 'REAL',
      source,
      selection: keepSelection ? current.selection : null,
    };
    const encoded = encodeWorkspaceReadingUrl(locale, next, { pack }, 'source');
    // An invalid target opens an explicit unavailable-link state; never choose a different source.
    return encoded.status === 'valid'
      ? encoded.href
      : `/${locale}/data-foundation/spatial-workspace/source`;
  }
  function regenerate(
    _record: unknown,
    _decisions: unknown,
    context: CandidateExerciseContext,
  ) {
    const item = pack.records.find(
      (record) =>
        record.id === context.originalRecordId &&
        record.sourceId === context.originalSourceId &&
        record.versionId === context.originalVersionId,
    );
    setExerciseRegionId(regionId);
    setExerciseSelectedId(selectedRecordId);
    setExerciseTab(reading.tab ?? 'spatial');
    setExerciseTarget(item?.id ?? null);
  }
  const tabs = [
    ['spatial', copy.spatial],
    ['readiness', copy.readiness],
    ['raster', copy.raster],
  ];
  const currentLink = encodeWorkspaceReadingUrl(locale, reading, { pack });
  if (invalidNavigation || currentLink.status === 'invalid')
    return (
      <main id="main-content" className={styles.workspace}>
        <h1>{copy.readingLinkInvalid}</h1>
        <p role="alert">{copy.readingLinkInvalidText}</p>
        <a href={`/${locale}/data-foundation/spatial-workspace`}>
          {copy.returnWorkspace}
        </a>
      </main>
    );
  return (
    <ExplorationWorkspace
      locale={locale}
      id="main-content"
      className={styles.workspace}
      toolbarClassName={styles.workspaceToolbar}
    >
      <header className={styles.heading}>
        <div>
          <h1>{copy.title}</h1>
        </div>
        <span className={styles.status}>
          {copy.localStatus}{' '}
          <ContextHelp label={copy.help}>
            <p>{copy.description}</p>
            <p>{copy.helpText}</p>
          </ContextHelp>
        </span>
      </header>
      <nav
        className={styles.tabs}
        role="tablist"
        aria-label={copy.title}
        onKeyDown={(event) => {
          const direction =
            event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!direction) return;
          event.preventDefault();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            ),
          ];
          const index = buttons.findIndex(
            (button) => button === document.activeElement,
          );
          const next = (index + direction + buttons.length) % buttons.length;
          buttons[next]?.click();
          buttons[next]?.focus();
        }}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            id={`spatial-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`spatial-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => {
              if (impact) setExerciseTab(id as WorkspaceReadingUrlState['tab']);
              else
                commitReading({
                  ...readingRef.current,
                  tab: id as WorkspaceReadingUrlState['tab'],
                });
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {impact && (
        <div
          className={styles.alert}
          role="status"
          aria-label={copy.exercisePreview}
        >
          <strong>{copy.exercisePreview}</strong>
          <p>{copy.exercisePreviewText}</p>
          <p>
            {copy.regenerated} · {impact.recordIds.length} {copy.impactRecords}{' '}
            · {impact.needIds.join(', ')} · {impact.topicIds.join(', ')}
          </p>
        </div>
      )}
      <section
        id="spatial-panel-spatial"
        role="tabpanel"
        aria-labelledby="spatial-tab-spatial"
        hidden={tab !== 'spatial'}
      >
        <div hidden={Boolean(impact)} data-testid="real-workspace-view">
          <SpatialWorkspace
            embedded
            pack={visiblePack}
            locale={locale}
            copy={dictionary.spatialWorkspace}
            publicReferences={publicReferences}
            publicReferenceState={publicReferenceState}
            regionId={regionId}
            onRegionChange={changeRegion}
            selectedRecordId={selectedRecordId}
            onSelectRecord={(id) => {
              if (id) selectRecord(id);
              else
                commitReading({
                  ...readingRef.current,
                  source: null,
                  selection: null,
                });
            }}
            readingState={reading}
            onReadingStateChange={commitReading}
            invalidations={noInvalidations}
            storageKey="wiser:goal100:spatial-scene:v1"
            sourceHref={sourceHref}
          />
        </div>
        {impact && (
          <div data-testid="exercise-workspace-view">
            <SpatialWorkspace
              embedded
              key={exerciseTarget}
              pack={pack}
              locale={locale}
              copy={dictionary.spatialWorkspace}
              publicReferences={publicReferences}
              publicReferenceState={publicReferenceState}
              regionId={exerciseRegionId}
              onRegionChange={setExerciseRegionId}
              selectedRecordId={exerciseSelectedId}
              onSelectRecord={setExerciseSelectedId}
              invalidations={invalidations}
              storageKey={`wiser:goal100:synthetic-spatial-scene:v1:${exerciseTarget}`}
              sourceHref={sourceHref}
            />
          </div>
        )}
      </section>
      <section
        id="spatial-panel-readiness"
        role="tabpanel"
        aria-labelledby="spatial-tab-readiness"
        hidden={tab !== 'readiness'}
      >
        <label>
          {copy.selectRegion}{' '}
          <select
            value={impact ? exerciseRegionId : regionId}
            onChange={(event) => {
              if (impact) {
                setExerciseRegionId(event.target.value as RegionId);
                setExerciseSelectedId(null);
              } else {
                changeRegion(event.target.value as RegionId);
              }
            }}
          >
            {pack.regions.map((region) => (
              <option key={region.id} value={region.id}>
                {dictionary.spatialWorkspace.regions[region.id]}
              </option>
            ))}
          </select>
        </label>
        {(readinessState === 'invalid' || readinessState === 'unavailable') && (
          <p role="status">{dictionary.spatialReadiness.factsUnavailable}</p>
        )}
        {(reading.dayWindow || readinessDateRole === null) && !impact ? (
          <div className={styles.alert} role="status">
            <p>
              {reading.dayWindow ? copy.dayWindowMatrix : copy.dateRoleMatrix}
            </p>
            {readinessDateRole !== null ? (
              <button
                type="button"
                onClick={() => {
                  const { dayWindow: _days, ...current } = readingRef.current;
                  commitReading({ ...current, monthWindow: null });
                }}
              >
                {copy.chooseMonthWindow}
              </button>
            ) : (
              <label>
                {dictionary.spatialReadiness.dateRole}
                <select
                  value=""
                  onChange={(event) =>
                    changeReadiness({
                      track: reading.track,
                      needId: reading.needId ?? 'K5-001',
                      window: reading.monthWindow,
                      dateRole: event.target
                        .value as ReadinessSelection['dateRole'],
                    })
                  }
                >
                  <option value="">{copy.chooseDateRole}</option>
                  {Object.entries(dictionary.spatialReadiness.dateRoles).map(
                    ([role, label]) => (
                      <option key={role} value={role}>
                        {label}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}
          </div>
        ) : (
          <SpatialReadinessPanel
            pack={pack}
            regionId={impact ? exerciseRegionId : regionId}
            copy={dictionary.spatialReadiness}
            staleRecordIds={impact?.recordIds}
            facts={readinessFacts}
            sourceHref={sourceHref}
            selection={
              !impact
                ? {
                    track: reading.track ?? 'REAL',
                    needId: reading.needId ?? 'K5-001',
                    dateRole: readinessDateRole ?? 'PUBLICATION',
                    window: reading.monthWindow,
                  }
                : undefined
            }
            onSelectionChange={
              !impact ? (selection) => changeReadiness(selection) : undefined
            }
            onSelectScope={
              !impact
                ? (id, selection) => changeReadiness(selection, id)
                : undefined
            }
            onSelectRegion={(id) => {
              if (impact) setExerciseRegionId(id);
              else changeRegion(id);
            }}
            onSelectRecord={selectRecord}
          />
        )}
      </section>
      <section
        id="spatial-panel-raster"
        role="tabpanel"
        aria-labelledby="spatial-tab-raster"
        hidden={tab !== 'raster'}
      >
        <SpatialRasterInspection pack={visiblePack} copy={copy} />
      </section>
      <section className={styles.practice}>
        <SpatialCandidateReview
          record={selected}
          copy={dictionary.spatialCandidateReview}
          onRegenerate={regenerate}
          onEndExercise={() => setExerciseTarget(null)}
        />
      </section>
    </ExplorationWorkspace>
  );
}
