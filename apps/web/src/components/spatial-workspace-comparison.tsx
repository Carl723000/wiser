'use client';
import type { RegionId, WorkspacePack } from '@/lib/spatial-workspace-contract';
import type { SpatialWorkspaceCopy } from '@/lib/spatial-workspace-copy';
import {
  compareWorkspaceRecords,
  filterSpatialWorkspace,
  validWorkspaceTimeFilter,
  workspaceRegionIds,
  workspaceRasterOverlays,
  workspaceScopeInvalidations,
  type SpatialWorkspaceView,
  type WorkspaceComparisonScope,
  type WorkspaceInvalidation,
  type WorkspaceSelection,
} from '@/lib/spatial-workspace-view';
import { SpatialWorkspaceMap } from './spatial-workspace-map';
import { SpatialWorkspaceInvalidations } from './spatial-workspace-invalidations';
import styles from './spatial-workspace.module.css';

export interface SpatialWorkspaceComparisonProps {
  pack: WorkspacePack;
  view: SpatialWorkspaceView;
  copy: SpatialWorkspaceCopy;
  onChange: (view: SpatialWorkspaceView) => void;
  onSelect: (selection: NonNullable<WorkspaceSelection>) => void;
  invalidations?: readonly WorkspaceInvalidation[];
}
export function SpatialWorkspaceComparison({
  pack,
  view,
  copy,
  onChange,
  onSelect,
  invalidations = [],
}: SpatialWorkspaceComparisonProps) {
  const scopes = view.comparison;
  const scopeView = (
    scope: WorkspaceComparisonScope,
  ): SpatialWorkspaceView => ({
    ...view,
    regionId: scope.regionId,
    start: scope.start,
    end: scope.end,
    bounds: null,
    topicId: null,
  });
  const left = filterSpatialWorkspace(
      pack,
      scopeView(scopes.left),
      invalidations,
    ),
    right = filterSpatialWorkspace(
      pack,
      scopeView(scopes.right),
      invalidations,
    );
  const changeScope = (
    side: 'left' | 'right',
    change: Partial<WorkspaceComparisonScope>,
  ) =>
    onChange({
      ...view,
      comparison: { ...scopes, [side]: { ...scopes[side], ...change } },
    });
  const pairs = left.records.flatMap((record) =>
    right.records
      .filter(
        (other) =>
          record.id !== other.id &&
          record.sourceId === other.sourceId &&
          record.objectId === other.objectId &&
          record.metric === other.metric,
      )
      .map((other) => ({
        left: record,
        right: other,
        result: compareWorkspaceRecords(record, other, pack, invalidations),
      })),
  );
  const selectedPairs = pairs.filter(
    (pair) =>
      !view.selection ||
      pair.left.id === view.selection.recordId ||
      pair.right.id === view.selection.recordId,
  );
  const visiblePairs = selectedPairs.slice(0, 20);
  return (
    <section className={styles.comparison} aria-label={copy.comparisonTitle}>
      <h2>{copy.comparisonTitle}</h2>
      <p>{copy.comparisonHint}</p>
      <div
        className={styles.segmented}
        role="group"
        aria-label={copy.comparisonTitle}
      >
        <button
          type="button"
          aria-pressed={scopes.mode === 'region'}
          onClick={() =>
            onChange({ ...view, comparison: { ...scopes, mode: 'region' } })
          }
        >
          {copy.compareRegion}
        </button>
        <button
          type="button"
          aria-pressed={scopes.mode === 'time'}
          onClick={() =>
            onChange({
              ...view,
              comparison: {
                ...scopes,
                mode: 'time',
                right: { ...scopes.right, regionId: scopes.left.regionId },
              },
            })
          }
        >
          {copy.compareTime}
        </button>
      </div>
      <p className={styles.hint}>{copy.sameObjectOnly}</p>
      <div className={styles.comparisonWindows}>
        {(['left', 'right'] as const).map((side) => {
          const scope = scopes[side],
            filtered = side === 'left' ? left : right;
          const notices = workspaceScopeInvalidations(
            pack,
            scopeView(scope),
            invalidations,
          );
          return (
            <section
              key={side}
              aria-label={side === 'left' ? copy.leftWindow : copy.rightWindow}
            >
              <h3>{side === 'left' ? copy.leftWindow : copy.rightWindow}</h3>
              <SpatialWorkspaceInvalidations
                pack={pack}
                copy={copy}
                notices={notices}
              />
              <div className={styles.scopeControls}>
                <label>
                  {copy.region}
                  <select
                    value={scope.regionId}
                    onChange={(event) => {
                      const regionId = event.target.value as RegionId;
                      if (scopes.mode === 'time')
                        onChange({
                          ...view,
                          comparison: {
                            ...scopes,
                            left: { ...scopes.left, regionId },
                            right: { ...scopes.right, regionId },
                          },
                        });
                      else changeScope(side, { regionId });
                    }}
                  >
                    {workspaceRegionIds.map((id) => (
                      <option key={id} value={id}>
                        {copy.regions[id]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {copy.from}
                  <input
                    type="date"
                    value={scope.start ?? ''}
                    onChange={(event) =>
                      changeScope(side, { start: event.target.value || null })
                    }
                  />
                </label>
                <label>
                  {copy.to}
                  <input
                    type="date"
                    value={scope.end ?? ''}
                    onChange={(event) =>
                      changeScope(side, { end: event.target.value || null })
                    }
                  />
                </label>
              </div>
              {!validWorkspaceTimeFilter(scope.start, scope.end) ? (
                <p role="alert">{copy.timeInvalid ?? copy.timeHint}</p>
              ) : null}
              <p className={styles.counts}>
                {copy.recordCount.replace(
                  '{count}',
                  String(filtered.recordCount),
                )}{' '}
                ·{' '}
                {copy.geometryCount.replace(
                  '{count}',
                  String(filtered.geometryCount),
                )}
              </p>
              <SpatialWorkspaceMap
                features={filtered.features}
                rasterReports={workspaceRasterOverlays(
                  pack,
                  scopeView(scope),
                  invalidations,
                )}
                rasterSettings={view.raster}
                onRasterChange={(raster) => onChange({ ...view, raster })}
                camera={view.camera}
                mode={view.mode}
                selection={view.selection}
                copy={copy}
                onCamera={(camera) => onChange({ ...view, camera })}
                onSelect={onSelect}
              />
              {!filtered.records.length && !notices.length ? (
                <p>{copy.missingPeriod}</p>
              ) : null}
              <div className={styles.comparisonRecords}>
                {filtered.records.map((record) => (
                  <button
                    type="button"
                    key={record.id}
                    aria-pressed={view.selection?.recordId === record.id}
                    onClick={() =>
                      onSelect({ recordId: record.id, positionId: null })
                    }
                  >
                    {record.objectLabel} · {record.time.start ?? copy.unknown} ·{' '}
                    {record.value ?? copy.missing} {record.unit ?? ''}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {!visiblePairs.length ? (
        <p>{copy.comparisonEmpty}</p>
      ) : (
        <div className={styles.comparisonResults}>
          {visiblePairs.map((pair) => (
            <article key={`${pair.left.id}:${pair.right.id}`}>
              <h3>
                {pair.left.objectLabel} · {pair.left.metric}
              </h3>
              <p>
                {pair.left.time.start ?? copy.unknown}:{' '}
                {pair.left.value ?? copy.missing}{' '}
                {pair.left.unit ?? copy.unknown} →{' '}
                {pair.right.time.start ?? copy.unknown}:{' '}
                {pair.right.value ?? copy.missing}{' '}
                {pair.right.unit ?? copy.unknown}
              </p>
              <strong>
                {pair.result.state === 'comparable'
                  ? copy.comparable
                  : copy.sideBySide}
              </strong>
              {pair.result.difference !== null ? (
                <p>
                  {copy.difference}: {pair.result.difference} {pair.left.unit}
                </p>
              ) : (
                <ul>
                  {pair.result.reasons.map((reason) => (
                    <li key={reason}>{copy.comparisonReasons[reason]}</li>
                  ))}
                </ul>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={() =>
                    onSelect({ recordId: pair.left.id, positionId: null })
                  }
                >
                  {copy.leftWindow} · {copy.originalEvidence}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onSelect({ recordId: pair.right.id, positionId: null })
                  }
                >
                  {copy.rightWindow} · {copy.originalEvidence}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
