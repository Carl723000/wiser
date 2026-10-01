'use client';
import type { WorkspacePack } from '@/lib/spatial-workspace-contract';
import type { SpatialWorkspaceCopy } from '@/lib/spatial-workspace-copy';
import {
  workspaceEvidenceUrl,
  workspaceObjectDossier,
  type WorkspaceInvalidation,
  type WorkspaceSourcePin,
} from '@/lib/spatial-workspace-view';
import styles from './spatial-workspace.module.css';
import { SpatialWorkspaceInvalidations } from './spatial-workspace-invalidations';

export interface SpatialWorkspaceDossierProps {
  pack: WorkspacePack;
  recordId: string | null;
  positionId?: string | null;
  copy: SpatialWorkspaceCopy;
  invalidations?: readonly WorkspaceInvalidation[];
  sourcePins?: readonly WorkspaceSourcePin[] | null;
  notices?: readonly WorkspaceInvalidation[];
  onSelectRecord: (id: string) => void;
  onSelectPosition: (recordId: string, positionId: string) => void;
  sourceHref?: (sourceId: string, versionId: string) => string;
}
function originalHref(local: string | undefined, publicUrl: string | null) {
  return local?.startsWith('/') && !local.startsWith('//')
    ? local
    : workspaceEvidenceUrl(publicUrl);
}
export function SpatialWorkspaceDossier({
  pack,
  recordId,
  positionId,
  copy,
  invalidations = [],
  sourcePins = null,
  notices = [],
  onSelectRecord,
  onSelectPosition,
  sourceHref,
}: SpatialWorkspaceDossierProps) {
  const dossier = recordId
    ? workspaceObjectDossier(pack, recordId, invalidations, sourcePins)
    : null;
  return (
    <section
      className={styles.dossier}
      aria-label={copy.dossierTitle}
      tabIndex={-1}
    >
      <h2>{copy.dossierTitle}</h2>
      <SpatialWorkspaceInvalidations
        pack={pack}
        copy={copy}
        notices={notices}
      />
      {!dossier ? (
        <p>{copy.selectRecord}</p>
      ) : (
        (() => {
          const {
            selected: record,
            source,
            positions,
            records,
            copies,
          } = dossier;
          const href = originalHref(
            sourceHref?.(source.id, source.versionId),
            source.evidenceUrl,
          );
          return (
            <>
              <h3>{record.objectLabel}</h3>
              <p className={styles.status}>
                {record.reviewStatus === 'pending'
                  ? copy.pending
                  : copy.syntheticReviewed}
              </p>
              <dl className={styles.metadata}>
                <dt>{copy.source}</dt>
                <dd>{source.title}</dd>
                <dt>{copy.provider}</dt>
                <dd>{source.provider}</dd>
                <dt>{copy.version}</dt>
                <dd>{source.versionId}</dd>
                <dt>{copy.recordId}</dt>
                <dd>{record.id}</dd>
                <dt>{copy.processingVersion}</dt>
                <dd>{record.processingVersion}</dd>
                <dt>{copy.nativeTime}</dt>
                <dd>
                  {record.time.start ?? copy.unknown}
                  {record.time.end && record.time.end !== record.time.start
                    ? ` – ${record.time.end}`
                    : ''}{' '}
                  · {copy.timePrecisions[record.time.precision]} ·{' '}
                  {copy.timeRoles[record.time.role]}
                </dd>
                <dt>{copy.metric}</dt>
                <dd>{record.metric || copy.unknown}</dd>
                <dt>{copy.value}</dt>
                <dd>{record.value ?? copy.missing}</dd>
                <dt>{copy.unit}</dt>
                <dd>{record.unit ?? copy.unknown}</dd>
                <dt>{copy.rights}</dt>
                <dd>{source.rights.note}</dd>
              </dl>
              <p className={styles.hint}>{copy.sourceDistinct}</p>
              {href ? (
                <a
                  className={styles.originalLink}
                  href={href}
                  target={href.startsWith('/') ? undefined : '_blank'}
                  rel={href.startsWith('/') ? undefined : 'noopener noreferrer'}
                >
                  {copy.openOriginal}
                </a>
              ) : null}
              <details
                open
                className={styles.evidence}
                data-testid="spatial-original-evidence"
              >
                <summary>{copy.originalEvidence}</summary>
                {record.evidence.map((evidence, index) => (
                  <blockquote key={index}>
                    <cite>{evidence.locator}</cite>
                    <p>{evidence.text}</p>
                  </blockquote>
                ))}
                {!record.evidence.length ? <p>{copy.missing}</p> : null}
              </details>
              <details open className={styles.evidence}>
                <summary>
                  {copy.locationEvidence} · {record.positions.length}
                </summary>
                {record.positions.map((position) => {
                  const displayPosition = positions.find(
                    (available) => available.id === position.id,
                  );
                  const geometrySource = displayPosition
                    ? pack.sources.find(
                        (item) =>
                          item.id === displayPosition.geometrySourceId &&
                          item.versionId === displayPosition.geometryVersionId,
                      )
                    : null;
                  return (
                    <article
                      key={position.id}
                      className={styles.positionEvidence}
                      data-position-id={position.id}
                    >
                      <h4>{position.expression}</h4>
                      <dl className={styles.metadata}>
                        <dt>{copy.positionRole}</dt>
                        <dd>{copy.positionRoles[position.role]}</dd>
                        <dt>{copy.matchState}</dt>
                        <dd>{copy.matchStates[position.match]}</dd>
                        <dt>{copy.scale}</dt>
                        <dd>{position.scaleNote ?? copy.unknown}</dd>
                        <dt>{copy.geometrySource}</dt>
                        <dd>
                          {geometrySource
                            ? `${geometrySource.title} · ${geometrySource.versionId} · ${position.locator}`
                            : copy.noGeometry}
                        </dd>
                      </dl>
                      <blockquote>
                        <cite>{position.evidence.locator}</cite>
                        <p>{position.evidence.text}</p>
                      </blockquote>
                      {position.role === 'reference' ? (
                        <p className={styles.hint}>{copy.referenceLocation}</p>
                      ) : null}
                      {displayPosition ? (
                        <button
                          type="button"
                          aria-pressed={positionId === position.id}
                          onClick={() =>
                            onSelectPosition(record.id, position.id)
                          }
                        >
                          {copy.locatePosition}
                        </button>
                      ) : null}
                    </article>
                  );
                })}
                {!record.positions.length ? <p>{copy.noGeometry}</p> : null}
              </details>
              {record.missingReasons.length ? (
                <div className={styles.missing}>
                  <strong>{copy.missing}</strong>
                  <ul>
                    {record.missingReasons.map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {records.length > 1 ? (
                <details>
                  <summary>
                    {copy.relatedRecords} · {records.length}
                  </summary>
                  <div className={styles.recordList}>
                    {records.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        aria-pressed={item.id === record.id}
                        onClick={() => onSelectRecord(item.id)}
                      >
                        {item.time.start ?? copy.unknown} · {item.metric} ·{' '}
                        {item.value ?? copy.missing} · {item.versionId}
                      </button>
                    ))}
                  </div>
                </details>
              ) : null}
              {copies.length ? (
                <details>
                  <summary>{copy.duplicates}</summary>
                  <ul>
                    {copies.map((item) => (
                      <li key={`${item.id}:${item.versionId}`}>
                        {item.title} · {item.versionId}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          );
        })()
      )}
    </section>
  );
}
