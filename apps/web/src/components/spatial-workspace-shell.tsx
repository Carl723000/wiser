'use client';

import { useMemo, useState } from 'react';
import type { ProjectReadinessInput } from '@wiser/data-core';
import { getDictionary, type Locale } from '@/lib/i18n';
import type { RegionId, WorkspacePack } from '@/lib/spatial-workspace-contract';
import { versionImpact } from '@/lib/spatial-version-impact';
import type { WorkspaceInvalidation } from '@/lib/spatial-workspace-view';
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
  readinessFacts = null,
  readinessState = 'absent',
  publicReferences = null,
  publicReferenceState = 'absent',
}: {
  pack: WorkspacePack;
  locale: Locale;
  initialRecordId?: string | null;
  readinessFacts?: ProjectReadinessInput | null;
  readinessState?: 'absent' | 'ready' | 'invalid' | 'unavailable';
  publicReferences?: PublicReferences | null;
  publicReferenceState?: 'absent' | 'ready' | 'invalid' | 'unavailable';
}) {
  const dictionary = getDictionary(locale).dataFoundation;
  const copy = dictionary.spatialManagement;
  const initialRecord = pack.records.find(
    (item) => item.id === initialRecordId,
  );
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(
    initialRecord?.id ?? null,
  );
  const [regionId, setRegionId] = useState<RegionId>(
    initialRecord?.regionIds.find((id) => id !== 'bth') ?? 'bth',
  );
  const [tab, setTab] = useState('spatial');
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
  function selectRecord(id: string) {
    const item = pack.records.find((record) => record.id === id);
    if (!item) return;
    const changeSelection = impact
      ? setExerciseSelectedId
      : setSelectedRecordId;
    const changeRegion = impact ? setExerciseRegionId : setRegionId;
    changeSelection(id);
    changeRegion(item.regionIds.find((region) => region !== 'bth') ?? 'bth');
    setTab('spatial');
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
    setExerciseTarget(item?.id ?? null);
  }
  const tabs = [
    ['spatial', copy.spatial],
    ['readiness', copy.readiness],
    ['raster', copy.raster],
  ];
  return (
    <ExplorationWorkspace
      locale={locale}
      id="main-content"
      className={styles.workspace}
    >
      <header className={styles.heading}>
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <span className={styles.status}>
          {copy.localStatus}{' '}
          <ContextHelp label={copy.help}>{copy.helpText}</ContextHelp>
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
            onClick={() => setTab(id)}
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
            pack={pack}
            locale={locale}
            copy={dictionary.spatialWorkspace}
            publicReferences={publicReferences}
            publicReferenceState={publicReferenceState}
            regionId={regionId}
            onRegionChange={setRegionId}
            selectedRecordId={selectedRecordId}
            onSelectRecord={setSelectedRecordId}
            invalidations={noInvalidations}
            storageKey="wiser:goal100:spatial-scene:v1"
            sourceHref={(sourceId, versionId) =>
              `/${locale}/data-foundation/spatial-workspace/source?source=${encodeURIComponent(sourceId)}&version=${encodeURIComponent(versionId)}`
            }
          />
        </div>
        {impact && (
          <div data-testid="exercise-workspace-view">
            <SpatialWorkspace
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
              sourceHref={(sourceId, versionId) =>
                `/${locale}/data-foundation/spatial-workspace/source?source=${encodeURIComponent(sourceId)}&version=${encodeURIComponent(versionId)}`
              }
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
                setRegionId(event.target.value as RegionId);
                setSelectedRecordId(null);
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
        <SpatialReadinessPanel
          pack={pack}
          regionId={impact ? exerciseRegionId : regionId}
          copy={dictionary.spatialReadiness}
          staleRecordIds={impact?.recordIds}
          facts={readinessFacts}
          sourceHref={(sourceId, versionId) =>
            `/${locale}/data-foundation/spatial-workspace/source?source=${encodeURIComponent(sourceId)}&version=${encodeURIComponent(versionId)}`
          }
          onSelectRecord={selectRecord}
        />
      </section>
      <section
        id="spatial-panel-raster"
        role="tabpanel"
        aria-labelledby="spatial-tab-raster"
        hidden={tab !== 'raster'}
      >
        <SpatialRasterInspection pack={pack} copy={copy} />
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
