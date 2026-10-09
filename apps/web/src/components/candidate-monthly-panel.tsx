'use client';

import { useMemo, useState } from 'react';
import { getDictionary, type Locale } from '@/lib/i18n';
import type {
  CandidateMonthlySemanticRead,
  CandidateMonthlySemanticRecord,
} from '@/lib/candidate-monthly-semantic-reader';
import { buildCandidateMonthlyOriginals } from '@/lib/candidate-monthly-readiness';
import styles from './ingestion-candidate-reader.module.css';

/** All content is owned and invalidated by the surrounding candidate session. */
export function CandidateMonthlyPanel({
  result,
  locale,
  busy,
  onSelect,
}: {
  result: CandidateMonthlySemanticRead;
  locale: Locale;
  busy: boolean;
  onSelect: (record: CandidateMonthlySemanticRecord) => void;
}) {
  const dictionary = getDictionary(locale).dataFoundation;
  const reader = dictionary.candidateReader;
  const copy = reader.monthly;
  const [limit, setLimit] = useState(40);
  const originals = useMemo(
    () =>
      result.kind === 'READY'
        ? buildCandidateMonthlyOriginals(result).originals
        : [],
    [result],
  );
  return (
    <section className={styles.tabPanel} aria-label={copy.title}>
      <h3>{copy.title}</h3>
      <p className={styles.pending}>{reader.pending}</p>
      <p>
        {reader.parseStatus}:{' '}
        <span className={styles.status} data-state={result.batchStatus}>
          {reader.statuses[result.batchStatus]}
        </span>
      </p>
      {result.kind === 'NOT_PARSED' ? (
        <div role="status">
          <p>{copy.unavailable}</p>
          <p>{copy.reasons[result.reason]}</p>
        </div>
      ) : (
        <>
          <dl className={styles.assetCounts}>
            <div>
              <dt>{copy.reportPeriod}</dt>
              <dd>{result.reportPeriod ?? reader.unknown}</dd>
            </div>
          </dl>
          <p>{copy.noLocation}</p>
          <p>{copy.noScope}</p>
          {result.conversionEvidence && <p>{copy.verified}</p>}
          <ul className={styles.assetList}>
            {result.conversionMembers.map((member) => (
              <li key={member.role}>
                <span>{copy[member.role]}</span>
                <span className={styles.status} data-state={member.status}>
                  {reader.statuses[member.status]}
                </span>
              </li>
            ))}
          </ul>
          <div
            className={styles.tableWrap}
            role="region"
            aria-label={copy.value}
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">{copy.name}</th>
                  <th scope="col">{copy.value}</th>
                  <th scope="col">{copy.kind}</th>
                </tr>
              </thead>
              <tbody>
                {originals
                  .slice(0, limit)
                  .map(({ recordKey, record, value }) => (
                    <tr key={recordKey}>
                      <th scope="row">
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`${copy.sourceRow}: ${record.originalName}`}
                          onClick={() => onSelect(record)}
                        >
                          {record.originalName}
                        </button>
                      </th>
                      <td>
                        <code>
                          {record.rawCategory === ''
                            ? copy.empty
                            : record.rawCategory}
                        </code>
                      </td>
                      <td>
                        {
                          dictionary.spatialReadiness.monthlyValueKinds[
                            value.kind
                          ]
                        }
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p>
            {copy.shown}: {Math.min(limit, originals.length)} /{' '}
            {originals.length}
          </p>
          {limit < originals.length && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setLimit((previous) => previous + 40)}
            >
              {copy.more}
            </button>
          )}
          <details>
            <summary>{copy.technical}</summary>
            <dl className={styles.technical}>
              <dt>{copy.rule}</dt>
              <dd>{result.processingRuleVersion}</dd>
              <dt>{reader.processingBatch}</dt>
              <dd>{result.candidateReference.processingBatchId}</dd>
              <dt>{reader.reviewHash}</dt>
              <dd>{result.candidateReference.reviewHash}</dd>
              {result.conversionEvidence && (
                <>
                  <dt>{copy.result}</dt>
                  <dd>{result.conversionEvidence.resultId}</dd>
                  <dt>{copy.tool}</dt>
                  <dd>
                    {result.conversionEvidence.tool?.name}{' '}
                    {result.conversionEvidence.tool?.version}
                  </dd>
                </>
              )}
            </dl>
            {result.conversionMembers.map((member) => (
              <dl key={member.role} className={styles.technical}>
                <dt>{copy[member.role]}</dt>
                <dd>{member.assetId}</dd>
                <dt>{reader.sourceHash}</dt>
                <dd>{result.conversionEvidence?.[member.role].sha256}</dd>
                <dt>{copy.reason}</dt>
                <dd>{member.reason ?? reader.unknown}</dd>
              </dl>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
