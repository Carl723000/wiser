'use client';

import { useMemo, useState } from 'react';
import { getDictionary, type Locale } from '@/lib/i18n';
import type {
  CandidateMonthlySemanticRead,
  CandidateMonthlySemanticRecord,
} from '@/lib/candidate-monthly-semantic-reader';
import {
  buildCandidateMonthlyScopedReadiness,
  CANDIDATE_MONTHLY_SCOPE_RULE,
} from '@/lib/candidate-monthly-readiness';
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
  const scoped = useMemo(
    () =>
      result.kind === 'READY'
        ? buildCandidateMonthlyScopedReadiness(result)
        : null,
    [result],
  );
  const originals = scoped?.originals ?? [];
  const originalByKey = new Map(
    originals.map((entry) => [entry.recordKey, entry]),
  );
  const originalById = new Map(
    originals.map((entry) => [
      entry.record.sourceLocalIdentity.recordId,
      entry,
    ]),
  );
  const questionNames = {
    KINDS: 'inventory',
    COUNTS: 'quantity',
    QUALITY: 'quality',
    STRUCTURE: 'structure',
    DENSITY: 'density',
    GAPS: 'gaps',
    CLEANING: 'cleaning',
    QUALITY_CONTROL: 'quality-control',
    COMPUTATIONS: 'computations',
  } as const;
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
          <p>{copy.scopeBoundary}</p>
          {scoped && (
            <section role="region" aria-label={copy.readiness}>
              <h4>{copy.readiness}</h4>
              <p>
                <span>{dictionary.spatialReadiness.needLabels['K5-001']}</span>
                {' · '}
                <span>{copy.chaobai}</span>
              </p>
              <p>
                {copy.mapped}: {scoped.readiness.records.length}
              </p>
              <p>
                {copy.unmapped}: {scoped.unmappedRecordIds.length}
              </p>
              <p>{copy.coverageBoundary}</p>
              {scoped.readiness.records.slice(0, limit).map((entry) => {
                const original = originalById.get(entry.id);
                if (!original) return null;
                return (
                  <p key={original.recordKey}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onSelect(original.record)}
                      aria-label={`${copy.mappedRow}: ${original.record.originalName}`}
                    >
                      {original.record.originalName}
                    </button>
                    {' · '}
                    {original.record.time.value ?? reader.unknown}
                    {' · '}
                    <code>{original.record.rawCategory || copy.empty}</code>
                  </p>
                );
              })}
              {scoped.readiness.questions.map((question) => (
                <details
                  key={question.id}
                  role="group"
                  aria-label={
                    dictionary.spatialReadiness.questionLabels[
                      questionNames[question.id]
                    ]
                  }
                >
                  <summary>
                    {
                      dictionary.spatialReadiness.questionLabels[
                        questionNames[question.id]
                      ]
                    }
                    :{' '}
                    {dictionary.spatialReadiness.questionStates[question.state]}
                  </summary>
                  {question.drilldowns.map((detail, index) => (
                    <div key={index}>
                      <p>
                        {dictionary.spatialReadiness.grains[detail.grain]}:{' '}
                        {detail.ids.length}
                      </p>
                      {detail.ids.slice(0, limit).map((key) => {
                        const original = originalByKey.get(key);
                        return original ? (
                          <p key={key}>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => onSelect(original.record)}
                            >
                              {copy.sourceRow}: {original.record.originalName}
                            </button>
                            {' · '}
                            <code>
                              {original.record.rawCategory || copy.empty}
                            </code>
                          </p>
                        ) : null;
                      })}
                    </div>
                  ))}
                </details>
              ))}
            </section>
          )}
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
              <dt>{copy.scopeRule}</dt>
              <dd>{CANDIDATE_MONTHLY_SCOPE_RULE}</dd>
              <dt>{copy.requirementCatalog}</dt>
              <dd>{scoped?.readiness.requirement.version}</dd>
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
