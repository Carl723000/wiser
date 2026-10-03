'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkspacePack,
  WorkspaceRecord,
} from '@/lib/spatial-workspace-contract';
import type { SpatialWorkspaceCopy } from '@/lib/spatial-workspace-copy';
import {
  workspaceDisplayPositions,
  type WorkspaceInvalidation,
  type WorkspaceSelection,
  type WorkspaceSourcePin,
} from '@/lib/spatial-workspace-view';
import styles from './spatial-workspace-records.module.css';

const pageSize = 40;
export function SpatialWorkspaceRecords({
  records,
  pack,
  copy,
  label,
  scope,
  selection,
  invalidations,
  sourcePins,
  onSelect,
}: {
  records: readonly WorkspaceRecord[];
  pack: WorkspacePack;
  copy: SpatialWorkspaceCopy;
  label: string;
  scope: string;
  selection: WorkspaceSelection;
  invalidations: readonly WorkspaceInvalidation[];
  sourcePins: readonly WorkspaceSourcePin[] | null;
  onSelect: (record: WorkspaceRecord) => void;
}) {
  const identity = useMemo(
    () =>
      JSON.stringify([
        scope,
        records.map((record) => [
          record.id,
          record.sourceId,
          record.versionId,
          record.processingVersion,
        ]),
      ]),
    [scope, records],
  );
  const [reading, setReading] = useState({ identity, page: 0 });
  if (reading.identity !== identity) setReading({ identity, page: 0 });
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  const page =
    reading.identity === identity ? Math.min(reading.page, pages - 1) : 0;
  const start = page * pageSize;
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (frame.current) {
      frame.current.scrollTop = 0;
      frame.current.scrollLeft = 0;
    }
  }, [identity, page]);
  const sources = useMemo(
    () =>
      new Map(
        pack.sources.map((source) => [
          JSON.stringify([source.id, source.versionId]),
          source,
        ]),
      ),
    [pack.sources],
  );
  const rows = records.slice(start, start + pageSize);
  const text = (template: string, values: Record<string, number>) =>
    template.replace(/\{(\w+)\}/g, (token, key: string) =>
      String(values[key] ?? token),
    );

  if (!records.length) return <p>{copy.emptyRecords}</p>;
  return (
    <div className={styles.results}>
      <nav className={styles.pagination} aria-label={copy.recordNavigation}>
        <p aria-live="polite" aria-atomic="true">
          <strong>
            {text(copy.recordRange, {
              from: start + 1,
              to: Math.min(start + pageSize, records.length),
              total: records.length,
            })}
          </strong>
          <span>{text(copy.recordPage, { page: page + 1, pages })}</span>
        </p>
        <div>
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setReading({ identity, page: page - 1 })}
          >
            {copy.previousRecords}
          </button>
          <button
            type="button"
            disabled={page === pages - 1}
            onClick={() => setReading({ identity, page: page + 1 })}
          >
            {copy.nextRecords}
          </button>
        </div>
      </nav>
      <div
        ref={frame}
        className={styles.frame}
        tabIndex={0}
        role="region"
        aria-label={copy.recordScroll}
      >
        <table aria-label={label}>
          <thead>
            <tr>
              <th scope="col">{copy.recordColumns.object}</th>
              <th scope="col">{copy.recordColumns.time}</th>
              <th scope="col">{copy.recordColumns.value}</th>
              <th scope="col">{copy.recordColumns.source}</th>
              <th scope="col">{copy.recordColumns.location}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((record) => {
              const source = sources.get(
                JSON.stringify([record.sourceId, record.versionId]),
              );
              const positions = workspaceDisplayPositions(
                pack,
                record,
                invalidations,
                sourcePins,
              );
              const selected = selection?.recordId === record.id;
              return (
                <tr key={record.id} data-selected={selected}>
                  <th scope="row">
                    <button
                      type="button"
                      className={styles.object}
                      aria-pressed={selected}
                      onClick={() => onSelect(record)}
                    >
                      {record.objectLabel}
                    </button>
                    <small>{copy.kinds[record.kind]}</small>
                  </th>
                  <td>
                    <span>
                      {record.time.start ?? copy.unknown}
                      {record.time.end && record.time.end !== record.time.start
                        ? ` – ${record.time.end}`
                        : ''}
                    </span>
                    <small>
                      {copy.timePrecisions[record.time.precision]} ·{' '}
                      {copy.timeRoles[record.time.role]}
                    </small>
                  </td>
                  <td>
                    <span>{record.value ?? copy.unknown}</span>
                    <small>
                      {copy.unit} · <span>{record.unit ?? copy.unknown}</span>
                    </small>
                    <small>{record.metric || copy.unknown}</small>
                  </td>
                  <td>
                    <span>{source?.title ?? copy.sourceMissing}</span>
                    <small>{source?.provider ?? copy.unknown}</small>
                    <span className={styles.review}>
                      {record.reviewStatus === 'pending'
                        ? copy.pending
                        : copy.syntheticReviewed}
                    </span>
                  </td>
                  <td>
                    {positions.length ? (
                      positions.map((position) => (
                        <div key={position.id} className={styles.position}>
                          <span>{position.expression}</span>
                          <small>
                            {copy.positionRoles[position.role]} ·{' '}
                            {copy.matchStates[position.match]}
                          </small>
                          <small>{position.scaleNote || copy.unknown}</small>
                        </div>
                      ))
                    ) : (
                      <span>{copy.noGeometry}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
