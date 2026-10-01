'use client';

import {
  buildReadiness,
  type NeedState,
  type ReadinessCounts,
  type ReadinessQuestionId,
  type UseId,
} from '../lib/spatial-readiness';
import type {
  Material,
  RegionId,
  WorkspacePack,
} from '../lib/spatial-workspace-contract';
import styles from './spatial-readiness-panel.module.css';

export interface ReadinessCopy {
  title: string;
  scopeNote: string;
  unknown: string;
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
  usesHeading: string;
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
}
export interface SpatialReadinessPanelProps {
  pack: WorkspacePack;
  regionId: RegionId;
  staleRecordIds?: string[];
  onSelectRecord?: (id: string) => void;
  copy: ReadinessCopy;
}
export function SpatialReadinessPanel({
  pack,
  regionId,
  staleRecordIds = [],
  onSelectRecord,
  copy,
}: SpatialReadinessPanelProps) {
  const result = buildReadiness(pack, regionId, staleRecordIds);
  const label = (code: string) => copy.detailLabels[code] ?? copy.unknown;
  return (
    <section className={styles.panel} aria-label={copy.title}>
      <h2>{copy.title}</h2>
      <p className={styles.scope}>{copy.scopeNote}</p>
      <dl className={styles.counts}>
        {(Object.keys(result.counts) as (keyof ReadinessCounts)[]).map(
          (key) => (
            <div key={key}>
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
            <h3>{copy.questionLabels[question.id]}</h3>
            <p>{question.detailCodes.map(label).join(' · ')}</p>
            {question.id === 'inventory' && (
              <p>
                {copy.counts.sources}: {result.counts.sources} ·{' '}
                {copy.recordsLabel}: {question.recordIds.length}
              </p>
            )}
            {question.id === 'structure' && (
              <p>
                {copy.fieldNamesLabel}:{' '}
                {result.fields.join(' / ') || copy.unknown}
              </p>
            )}
            {question.id === 'density' && (
              <>
                <p>
                  {copy.reportWindowsLabel}:{' '}
                  {result.density.reportWindows.join(', ') || copy.unknown}
                </p>
                <p>
                  {copy.missingWindowsLabel}:{' '}
                  {result.density.missingReportWindows.join(', ') || copy.none}
                </p>
              </>
            )}
            {question.id === 'quality' && (
              <details>
                <summary>{copy.stateLabel}</summary>
                {result.statuses.map(({ sourceId, status }) => (
                  <dl key={sourceId}>
                    <dt>{sourceId}</dt>
                    {(Object.keys(status) as (keyof Material['status'])[]).map(
                      (key) => (
                        <dd key={key}>
                          {copy.statusLabels[key]}:{' '}
                          {copy.detailLabels[status[key]] ?? status[key]}
                        </dd>
                      ),
                    )}
                  </dl>
                ))}
              </details>
            )}
            {question.recordIds.length > 0 && onSelectRecord && (
              <button
                type="button"
                onClick={() => onSelectRecord(question.recordIds[0])}
              >
                {copy.inspect} ({question.recordIds.length})
              </button>
            )}
          </article>
        ))}
      </div>
      <details className={styles.needs} open>
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
                    {need.recordIds.length > 0 && onSelectRecord ? (
                      <button
                        type="button"
                        onClick={() => onSelectRecord(need.recordIds[0])}
                      >
                        {copy.inspect} ({need.recordIds.length})
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
      <details className={styles.uses} open>
        <summary>{copy.usesHeading}</summary>
        <ul>
          {result.uses.map((use) => (
            <li key={use.id}>
              <strong>{copy.useLabels[use.id]}</strong>
              <span>{use.eligible ? copy.useEligible : copy.useBlocked}</span>
              <p>{use.reasons.map(label).join(' · ')}</p>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
