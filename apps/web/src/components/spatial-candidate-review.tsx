'use client';

import { useState } from 'react';
import {
  decideCandidate,
  regenerateCandidates,
  syntheticReviewRecord,
  type CandidateAction,
  type CandidateDecision,
} from '../lib/spatial-candidate-review';
import type {
  WorkspacePosition,
  WorkspaceRecord,
} from '../lib/spatial-workspace-contract';
import styles from './spatial-candidate-review.module.css';

export interface CandidateReviewCopy {
  title: string;
  noSelection: string;
  realPendingNote: string;
  exerciseNote: string;
  startExercise: string;
  returnToReal: string;
  sourceEvidence: string;
  candidatePosition: string;
  reasonLabel: string;
  actionLabel: string;
  actions: Record<CandidateAction, string>;
  saveDecision: string;
  regenerate: string;
  history: string;
  versionLabel: string;
  errorLabels: Record<string, string>;
  regeneratedNote: string;
  positionRoleLabels: Record<WorkspacePosition['role'], string>;
}
export interface SpatialCandidateReviewProps {
  record: WorkspaceRecord | null;
  copy: CandidateReviewCopy;
  onRegenerate?: (
    record: WorkspaceRecord,
    decisions: CandidateDecision[],
    context: CandidateExerciseContext,
  ) => void;
  onEndExercise?: () => void;
}
export interface CandidateExerciseContext {
  originalRecordId: string | null;
  originalSourceId: string | null;
  originalVersionId: string | null;
  syntheticRecordId: string;
}
const storageKey = 'wiser:synthetic-candidate:synthetic-v1';
function readDecisions(record: WorkspaceRecord): CandidateDecision[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? '[]',
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is CandidateDecision => {
        if (!item || typeof item !== 'object') return false;
        const decision = item as Partial<CandidateDecision>;
        return (
          decision.synthetic === true &&
          decision.sourceId === record.sourceId &&
          decision.versionId === record.versionId &&
          decision.recordId === record.id &&
          record.positions.some(
            (position) => position.id === decision.positionId,
          ) &&
          ['accept', 'exclude', 'pending'].includes(decision.action ?? '') &&
          typeof decision.reason === 'string' &&
          decision.reason.trim().length > 0 &&
          decision.reason.length <= 2000 &&
          typeof decision.decisionVersion === 'string' &&
          /^d\d+$/.test(decision.decisionVersion)
        );
      })
      .slice(-100);
  } catch {
    return [];
  }
}

export function SpatialCandidateReview({
  record,
  copy,
  onRegenerate,
  onEndExercise,
}: SpatialCandidateReviewProps) {
  const [exercise, setExercise] = useState<WorkspaceRecord | null>(null);
  const [decisions, setDecisions] = useState<CandidateDecision[]>([]);
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<CandidateAction>('pending');
  const [positionId, setPositionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [regenerated, setRegenerated] = useState(false);
  const [context, setContext] = useState<CandidateExerciseContext | null>(null);
  const current = exercise ?? record;
  function start() {
    const synthetic = syntheticReviewRecord();
    setExercise(synthetic);
    setContext({
      originalRecordId: record?.id ?? null,
      originalSourceId: record?.sourceId ?? null,
      originalVersionId: record?.versionId ?? null,
      syntheticRecordId: synthetic.id,
    });
    setPositionId(synthetic.positions[0].id);
    setDecisions(readDecisions(synthetic));
    setError(null);
    setRegenerated(false);
  }
  function save() {
    if (!exercise) return;
    try {
      const number =
        Math.max(
          0,
          ...decisions.map((decision) =>
            Number(decision.decisionVersion.slice(1)),
          ),
        ) + 1;
      const decision = decideCandidate(exercise, decisions, {
        positionId,
        action,
        reason,
        decisionVersion: `d${number}`,
      });
      const next = [...decisions, decision].slice(-100);
      // Persist only the independent synthetic exercise, never real source evidence.
      localStorage.setItem(storageKey, JSON.stringify(next));
      setDecisions(next);
      setReason('');
      setError(null);
      setRegenerated(false);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'LOCAL_SAVE_FAILED',
      );
    }
  }
  function regenerate() {
    if (!exercise || !decisions.length || !context) return;
    onRegenerate?.(regenerateCandidates(exercise, decisions), [...decisions], {
      ...context,
    });
    setRegenerated(true);
  }
  return (
    <section className={styles.panel} aria-label={copy.title}>
      <div className={styles.heading}>
        <h2>{copy.title}</h2>
        {exercise ? (
          <button
            type="button"
            onClick={() => {
              setExercise(null);
              setError(null);
              setRegenerated(false);
              setContext(null);
              onEndExercise?.();
            }}
          >
            {copy.returnToReal}
          </button>
        ) : (
          <button type="button" onClick={start}>
            {copy.startExercise}
          </button>
        )}
      </div>
      <p className={styles.notice}>
        {exercise ? copy.exerciseNote : copy.realPendingNote}
      </p>
      {!current ? (
        <p>{copy.noSelection}</p>
      ) : (
        <>
          <p className={styles.object}>{current.objectLabel}</p>
          <div className={styles.evidenceGrid}>
            <div>
              <strong>{copy.sourceEvidence}</strong>
              {current.evidence.map((evidence, index) => (
                <blockquote key={`${evidence.locator}:${index}`}>
                  <p>{evidence.text}</p>
                  <small>{evidence.locator}</small>
                  {evidence.url && (
                    <a href={evidence.url} target="_blank" rel="noreferrer">
                      {copy.sourceEvidence}
                    </a>
                  )}
                </blockquote>
              ))}
            </div>
            <div>
              <strong>{copy.candidatePosition}</strong>
              {current.positions.map((position) => (
                <div className={styles.position} key={position.id}>
                  <p>{position.expression}</p>
                  <small>
                    {copy.positionRoleLabels[position.role]} ·{' '}
                    {position.evidence.locator}
                  </small>
                  <p>{position.evidence.text}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {exercise && (
        <div className={styles.form}>
          <label>
            {copy.candidatePosition}
            <select
              value={positionId}
              onChange={(event) => setPositionId(event.target.value)}
            >
              {exercise.positions.map((position) => (
                <option key={position.id} value={position.id}>
                  {position.expression}
                </option>
              ))}
            </select>
          </label>
          <label>
            {copy.actionLabel}
            <select
              value={action}
              onChange={(event) =>
                setAction(event.target.value as CandidateAction)
              }
            >
              {(['accept', 'exclude', 'pending'] as const).map((choice) => (
                <option key={choice} value={choice}>
                  {copy.actions[choice]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.reason}>
            {copy.reasonLabel}
            <textarea
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <button type="button" onClick={save}>
              {copy.saveDecision}
            </button>
            <button
              type="button"
              onClick={regenerate}
              disabled={!decisions.length}
            >
              {copy.regenerate}
            </button>
          </div>
          {error && (
            <p role="alert">
              {copy.errorLabels[error] ??
                copy.errorLabels.LOCAL_SAVE_FAILED ??
                copy.noSelection}
            </p>
          )}
          {regenerated && <p role="status">{copy.regeneratedNote}</p>}
          <details open={decisions.length > 0}>
            <summary>
              {copy.history} ({decisions.length})
            </summary>
            <ol>
              {decisions.map((decision) => (
                <li key={decision.decisionVersion}>
                  <strong>
                    {copy.versionLabel} {decision.decisionVersion} ·{' '}
                    {copy.actions[decision.action]}
                  </strong>
                  <p>{decision.reason}</p>
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}
    </section>
  );
}
