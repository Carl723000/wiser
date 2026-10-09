'use client';

import type { CandidateRelationPages } from '@/lib/candidate-relation-reader';
import { getDictionary, type Locale } from '@/lib/i18n';
import styles from './ingestion-candidate-reader.module.css';
type CandidateRelationSnapshot = CandidateRelationPages['get']['relation'];

/** The surrounding candidate owner holds and invalidates every read result. */
export function CandidateRelationPanel({
  locale,
  busy,
  page,
  detail,
  canPrevious,
  onRead,
  onInspect,
  onNext,
  onPrevious,
}: {
  locale: Locale;
  busy: boolean;
  page: CandidateRelationPages['list'] | null;
  detail: CandidateRelationSnapshot | null;
  canPrevious: boolean;
  onRead: () => void;
  onInspect: (relation: CandidateRelationSnapshot) => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const dictionary = getDictionary(locale);
  const reader = dictionary.dataFoundation.candidateReader;
  const copy = reader.relations;
  const shared = dictionary.knowledgeRelations;
  return (
    <section
      className={styles.savedSection}
      aria-label={copy.title}
      aria-busy={busy}
    >
      <div className={styles.summaryHeader}>
        <h3>{copy.title}</h3>
        <button type="button" disabled={busy} onClick={onRead}>
          {copy.read}
        </button>
      </div>
      <p>{copy.scope}</p>
      {page && (
        <>
          <p>
            {copy.loaded}: {page.relations.length}
          </p>
          {page.relations.length === 0 ? (
            <p role="status">{copy.empty}</p>
          ) : (
            <ul className={styles.assetList}>
              {page.relations.map((relation) => (
                <li
                  key={`${relation.revision.relationId}:${relation.revision.revision}:${relation.decisionVersion}`}
                >
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${copy.inspect}: ${relation.revision.content.subject.label} · ${relation.revision.content.object.label}`}
                    onClick={() => onInspect(relation)}
                  >
                    {relation.revision.content.subject.label} ·{' '}
                    {shared.predicates[relation.revision.content.predicate]} ·{' '}
                    {relation.revision.content.object.label}
                  </button>
                  <span className={styles.status} data-state={relation.state}>
                    {copy.states[relation.state]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busy || !canPrevious}
              onClick={onPrevious}
            >
              {copy.previous}
            </button>
            <button
              type="button"
              disabled={busy || !page.nextCursor}
              onClick={onNext}
            >
              {copy.next}
            </button>
          </div>
        </>
      )}
      {detail && (
        <section aria-label={copy.detail} className={styles.tabPanel}>
          <h4>
            {detail.revision.content.subject.label} ·{' '}
            {shared.predicates[detail.revision.content.predicate]} ·{' '}
            {detail.revision.content.object.label}
          </h4>
          <p className={styles.status} data-state={detail.state}>
            {copy.states[detail.state]}
          </p>
          <p>{copy.meanings[detail.state]}</p>
          <p>{shared.relationMeaning[detail.revision.content.predicate]}</p>
          <dl className={styles.technical}>
            <dt>{shared.nature}</dt>
            <dd>
              {
                shared.natures[
                  detail.revision.content.qualifiers.context.recordNature
                ]
              }
            </dd>
            <dt>{shared.timeRole}</dt>
            <dd>
              {
                shared.timeRoles[
                  detail.revision.content.qualifiers.context.timeRole
                ]
              }
            </dd>
            <dt>{shared.locationRole}</dt>
            <dd>
              {
                shared.locationRoles[
                  detail.revision.content.qualifiers.context.locationRole
                ]
              }
            </dd>
            <dt>{shared.applicability}</dt>
            <dd>{detail.revision.content.qualifiers.context.applicability}</dd>
            <dt>{shared.period}</dt>
            <dd>
              {detail.revision.content.qualifiers.context.validFrom ??
                reader.unknown}{' '}
              ·{' '}
              {detail.revision.content.qualifiers.context.validTo ??
                reader.unknown}
            </dd>
          </dl>
          <h4>{shared.evidence}</h4>
          <ul className={styles.assetList}>
            {detail.revision.content.evidence.map((evidence, index) => (
              <li key={index}>
                <span>{shared.polarities[evidence.polarity]}</span>
                <p>{evidence.excerpt ?? reader.unknown}</p>
                <p>{evidence.locator}</p>
                <details>
                  <summary>{copy.source}</summary>
                  <dl className={styles.technical}>
                    <dt>{copy.ingestion}</dt>
                    <dd>{evidence.reference.ingestionId}</dd>
                    <dt>{reader.processingBatch}</dt>
                    <dd>{evidence.reference.processingBatchId}</dd>
                    <dt>{reader.reviewHash}</dt>
                    <dd>{evidence.reference.reviewHash}</dd>
                    <dt>{reader.asset}</dt>
                    <dd>{evidence.assetId}</dd>
                    <dt>{copy.record}</dt>
                    <dd>{evidence.recordId ?? reader.unknown}</dd>
                    <dt>{reader.sourceHash}</dt>
                    <dd>{evidence.sourceHash}</dd>
                  </dl>
                </details>
              </li>
            ))}
          </ul>
          <details>
            <summary>{copy.fixed}</summary>
            <dl className={styles.technical}>
              <dt>{copy.id}</dt>
              <dd>{detail.revision.relationId}</dd>
              <dt>{copy.revision}</dt>
              <dd>{detail.revision.revision}</dd>
              <dt>{copy.decision}</dt>
              <dd>{detail.decisionVersion}</dd>
              <dt>{copy.mapping}</dt>
              <dd>{detail.revision.mappingVersion}</dd>
              <dt>{reader.monthly.rule}</dt>
              <dd>{detail.revision.ruleVersion}</dd>
              <dt>{copy.subjectKey}</dt>
              <dd>{detail.revision.content.subject.key}</dd>
              <dt>{copy.objectKey}</dt>
              <dd>{detail.revision.content.object.key}</dd>
            </dl>
          </details>
        </section>
      )}
    </section>
  );
}
