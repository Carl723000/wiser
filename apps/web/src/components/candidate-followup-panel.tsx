'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  candidateSavedReferenceKey,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  CandidateFollowupEvidenceSchema,
  type CandidateFollowupSchema,
  type CandidateFollowupEvidence,
} from '@wiser/data-contracts/candidate-followups';
import { getDictionary, type Locale } from '@/lib/i18n';
import {
  readCandidateFollowup,
  sameCandidateFollowupEvidence,
  type FollowupList,
} from '@/lib/candidate-followup-reader';
import {
  CandidateReaderError,
  readCandidatePage,
} from '@/lib/ingestion-candidate-reader';
import { ContextHelp } from './context-help';
import styles from './candidate-followup-panel.module.css';
export interface CandidateFollowupSource {
  readonly reference: IngestionCandidateReference;
  readonly label: string;
}
const referenceKey = (value: IngestionCandidateReference) =>
  candidateSavedReferenceKey(value);
const isRecord = (value: CandidateFollowupEvidence | null) =>
  Boolean(value?.recordId && value.geometry && value.sourceCrs);

type CandidateFollowup = ReturnType<typeof CandidateFollowupSchema.parse>;
export interface CandidateSupplementLookup {
  readonly action: string;
  readonly requestedIngestionId: string;
  readonly initialFollowupId?: string;
  readonly verificationId?: string;
  readonly source?: CandidateFollowupSource;
  readonly stateLabel?: string;
  readonly error?: 'empty' | 'denied' | 'stale' | 'invalid' | 'unavailable';
}
interface CandidateFollowupPanelProps {
  readonly locale: Locale;
  readonly references: readonly CandidateFollowupSource[];
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly readOnly?: boolean;
  readonly parentBusy?: boolean;
  readonly supplementLookup?: CandidateSupplementLookup;
}
export function CandidateFollowupPanel(props: CandidateFollowupPanelProps) {
  // Retain only the selected identity across owner recovery, never its proof or authority.
  const targetScope = JSON.stringify([
    props.references.map((s) => referenceKey(s.reference)),
    props.ruleId,
    props.ruleVersion,
    props.supplementLookup?.initialFollowupId,
  ]);
  const target = useRef({
    scope: targetScope,
    id: props.supplementLookup?.initialFollowupId,
  });
  if (target.current.scope !== targetScope)
    target.current = {
      scope: targetScope,
      id: props.supplementLookup?.initialFollowupId,
    };
  const lookupScope = JSON.stringify([
    targetScope,
    props.supplementLookup?.requestedIngestionId,
    props.supplementLookup?.verificationId,
  ]);
  const blocked = useRef({ scope: lookupScope, value: false });
  if (blocked.current.scope !== lookupScope)
    blocked.current = { scope: lookupScope, value: false };
  return (
    <CandidateFollowupSession
      key={JSON.stringify([
        props.references.map((s) => referenceKey(s.reference)),
        props.ruleId,
        props.ruleVersion,
        props.readOnly,
        props.parentBusy,
      ])}
      {...props}
      supplementLookup={
        props.supplementLookup
          ? { ...props.supplementLookup, initialFollowupId: target.current.id }
          : undefined
      }
      initialSupplementBlocked={blocked.current.value}
      onSupplementBlocked={() => {
        blocked.current.value = true;
      }}
      onTarget={(id) => {
        target.current.id = id;
      }}
    />
  );
}
function CandidateFollowupSession({
  locale,
  references,
  ruleId,
  ruleVersion,
  readOnly = false,
  parentBusy = false,
  supplementLookup,
  onTarget,
  initialSupplementBlocked,
  onSupplementBlocked,
}: {
  readonly locale: Locale;
  readonly references: readonly CandidateFollowupSource[];
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly readOnly?: boolean;
  readonly parentBusy?: boolean;
  readonly supplementLookup?: CandidateSupplementLookup;
  readonly onTarget: (id: string) => void;
  readonly initialSupplementBlocked: boolean;
  readonly onSupplementBlocked: () => void;
}) {
  const copy = getDictionary(locale).candidateFollowups;
  const id = useId();
  const scopeKey = JSON.stringify(
    references.map((s) => referenceKey(s.reference)),
  );
  const unique = [
    ...new Map(references.map((s) => [referenceKey(s.reference), s])).values(),
  ];
  const [supplementBlocked, setSupplementBlocked] = useState(
    initialSupplementBlocked,
  );
  const evidenceSources = supplementLookup?.requestedIngestionId
    ? supplementLookup.source
      ? [supplementLookup.source]
      : []
    : unique;
  const evidenceScopeKey = JSON.stringify([
    evidenceSources.map((s) => referenceKey(s.reference)),
    supplementLookup?.verificationId,
  ]);
  const [proofScope, setProofScope] = useState(evidenceScopeKey);
  const [sourceKey, setSourceKey] = useState(
    unique[0] ? referenceKey(unique[0].reference) : '',
  );
  const selected =
    unique.find((s) => referenceKey(s.reference) === sourceKey) ?? unique[0];
  const [proofSourceKey, setProofSourceKey] = useState(
    evidenceSources[0] ? referenceKey(evidenceSources[0].reference) : '',
  );
  const evidenceSource =
    !supplementBlocked &&
    evidenceSources.find((s) => referenceKey(s.reference) === proofSourceKey);
  const [page, setPage] = useState<FollowupList | null>(null);
  const [task, setTask] = useState<CandidateFollowup | null>(null);
  const [proofs, setProofs] = useState<CandidateFollowupEvidence[]>([]);
  const [proofIndex, setProofIndex] = useState(0);
  const [assetAfter, setAssetAfter] = useState<string | null>(null);
  const [geometryAfter, setGeometryAfter] = useState<string | null>(null);
  const [type, setType] = useState<'GAP' | 'CORRECTION'>('GAP');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState('');
  const [mapping, setMapping] = useState('');
  const [oldIndex, setOldIndex] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CandidateReaderError['kind'] | null>(null);
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    active.current?.abort();
    setPage(null);
    setTask(null);
    setProofs([]);
    setProofIndex(0);
    setAssetAfter(null);
    setGeometryAfter(null);
    setBusy(false);
    setError(null);
    setNotice('');
    setHistoryLimit(20);
    setProofSourceKey(
      supplementLookup?.requestedIngestionId
        ? evidenceSources[0]
          ? referenceKey(evidenceSources[0].reference)
          : ''
        : sourceKey,
    );
    keys.current.clear();
    return () => active.current?.abort();
  }, [scopeKey, sourceKey, ruleId, ruleVersion]);
  useEffect(() => {
    active.current?.abort();
    setProofs([]);
    setProofIndex(0);
    setAssetAfter(null);
    setGeometryAfter(null);
    setBusy(false);
    setNotice('');
    setProofScope(evidenceScopeKey);
    setError(null);
    setSupplementBlocked(initialSupplementBlocked);
    setProofSourceKey(
      evidenceSources[0] ? referenceKey(evidenceSources[0].reference) : '',
    );
  }, [evidenceScopeKey]);
  useEffect(() => {
    const followupId = supplementLookup?.initialFollowupId;
    if (!followupId || readOnly || parentBusy) return;
    void run(async (signal) => {
      accept(
        (await readCandidateFollowup('get', { followupId }, signal)).followup,
        signal,
      );
    });
    return () => active.current?.abort();
  }, [supplementLookup?.initialFollowupId, sourceKey]);
  function mutationKey(action: string, input: unknown) {
    const key = JSON.stringify({ action, input });
    let value = keys.current.get(key);
    if (!value) {
      value = crypto.randomUUID();
      keys.current.set(key, value);
    }
    return value;
  }
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (parentBusy) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await work(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof CandidateReaderError ? e.kind : 'unavailable');
        if (supplementLookup?.requestedIngestionId) {
          setSupplementBlocked(true);
          onSupplementBlocked();
        }
        setPage(null);
        setTask(null);
        setProofs([]);
        setAssetAfter(null);
        setGeometryAfter(null);
      }
    } finally {
      if (!controller.signal.aborted && active.current === controller)
        setBusy(false);
    }
  }
  function accept(value: CandidateFollowup, signal: AbortSignal) {
    if (signal.aborted) return;
    if (
      !selected ||
      referenceKey(value.source.reference) !== referenceKey(selected.reference)
    )
      throw new CandidateReaderError('invalid');
    onTarget(value.followupId);
    setTask(value);
    setHistoryLimit(20);
    setOldIndex(0);
  }
  const load = (after?: string) =>
    run(async (signal) => {
      if (!selected) return;
      setPage(null);
      setTask(null);
      const result = await readCandidateFollowup(
        'list',
        { ...selected.reference, first: 25, ...(after ? { after } : {}) },
        signal,
      );
      if (!signal.aborted) setPage(result);
    });
  const open = (followupId: string) =>
    run(async (signal) => {
      setTask(null);
      accept(
        (await readCandidateFollowup('get', { followupId }, signal)).followup,
        signal,
      );
    });
  const visibleProofs =
    !supplementBlocked && proofScope === evidenceScopeKey ? proofs : [];
  const proof = visibleProofs[proofIndex] ?? null;
  function loadProof(after?: string) {
    return run(async (signal) => {
      if (!evidenceSource) return;
      setProofs([]);
      setProofScope(evidenceScopeKey);
      setGeometryAfter(null);
      const result = await readCandidatePage(
        'get',
        { ...evidenceSource.reference, first: 50, ...(after ? { after } : {}) },
        signal,
      );
      if (signal.aborted) return;
      setProofs(
        result.assets.map((asset) =>
          CandidateFollowupEvidenceSchema.parse({
            reference: result.reference,
            assetId: asset.assetId,
            sourceHash: asset.sourceHash,
            locator: `asset:${asset.assetId.toLowerCase()}`,
          }),
        ),
      );
      setProofIndex(0);
      setAssetAfter(result.nextCursor);
    });
  }
  function loadGeometry(after?: string) {
    const asset = proof;
    return run(async (signal) => {
      if (!asset) return;
      const result = await readCandidatePage(
        'geometry',
        {
          ...asset.reference,
          assetId: asset.assetId,
          first: 50,
          ...(after ? { after } : {}),
        },
        signal,
      );
      if (signal.aborted) return;
      const records = result.features
        .filter((f) => f.sourceId && f.sourceCrs)
        .map((f) =>
          CandidateFollowupEvidenceSchema.parse({
            reference: result.reference,
            assetId: f.assetId,
            recordId: f.recordId,
            sourceHash: asset.sourceHash,
            locator: f.sourceId,
            sourceCrs: f.sourceCrs,
            geometry: f.geometry,
          }),
        );
      setProofs([
        {
          ...asset,
          recordId: undefined,
          geometry: undefined,
          sourceCrs: undefined,
          locator: `asset:${asset.assetId.toLowerCase()}`,
        },
        ...records,
      ]);
      setProofIndex(records.length ? 1 : 0);
      setGeometryAfter(result.nextCursor);
      if (!records.length) setNotice(copy.noGeometry);
    });
  }
  const createSourceMatches = Boolean(
    proof &&
    selected &&
    referenceKey(proof.reference) === referenceKey(selected.reference),
  );
  function create() {
    if (
      !proof ||
      !createSourceMatches ||
      !reason.trim() ||
      (type === 'CORRECTION' && !isRecord(proof))
    )
      return;
    const input = {
      type,
      source: proof,
      ruleId,
      ruleVersion,
      reason: reason.trim(),
    };
    return run(async (signal) => {
      const result = await readCandidateFollowup(
        'create',
        input,
        signal,
        mutationKey('create', input),
      );
      accept(result.followup, signal);
      if (!signal.aborted) setNotice(copy.updated);
    });
  }
  const originalProofs = task
    ? [task.source, ...task.evidence].filter((item) => isRecord(item))
    : [];
  const oldProof = originalProofs[oldIndex] ?? null;
  const supplementReady = Boolean(
    proof &&
    task &&
    ![task.source, ...task.evidence].some((item) =>
      sameCandidateFollowupEvidence(item, proof),
    ) &&
    (task.type === 'GAP' || (isRecord(proof) && oldProof && mapping.trim())),
  );
  function act(
    action:
      | 'CLAIM'
      | 'HANDOFF'
      | 'SUPPLEMENT'
      | 'SUBMIT_REVIEW'
      | 'REOPEN'
      | 'CLOSE'
      | 'RETURN',
  ) {
    if (!task || !note.trim()) return;
    const input = {
      followupId: task.followupId,
      expectedVersion: task.rowVersion,
      note: note.trim(),
      ...(['CLOSE', 'RETURN'].includes(action)
        ? { decision: action }
        : { action }),
      ...(action === 'HANDOFF' ? { targetActorId: target.trim() } : {}),
      ...(action === 'SUPPLEMENT'
        ? {
            evidence: [proof],
            ...(task.type === 'CORRECTION'
              ? {
                  correction: {
                    scope: 'WHOLE_RECORD',
                    old: oldProof,
                    new: proof,
                    mappingReason: mapping.trim(),
                  },
                }
              : {}),
          }
        : {}),
    };
    const operation =
      action === 'CLOSE' || action === 'RETURN' ? 'review' : 'act';
    return run(async (signal) => {
      const result = await readCandidateFollowup(
        operation,
        input,
        signal,
        mutationKey(operation, input),
      );
      accept(result.followup, signal);
      if (!signal.aborted) setNotice(copy.updated);
    });
  }
  if (!selected)
    return (
      <section className={styles.panel} aria-label={copy.title}>
        <h4>{copy.title}</h4>
        <p role="status">{copy.dependency}</p>
      </section>
    );
  return (
    <section
      className={styles.panel}
      aria-label={copy.title}
      aria-busy={busy || parentBusy}
      inert={parentBusy}
    >
      <div className={styles.heading}>
        <h4>{copy.title}</h4>
        <span className={styles.scope}>{copy.scope}</span>
        <ContextHelp label={copy.help}>{copy.helpText}</ContextHelp>
      </div>
      <label htmlFor={`${id}-source`}>{copy.source}</label>
      <select
        id={`${id}-source`}
        value={referenceKey(selected.reference)}
        disabled={busy || parentBusy}
        onChange={(e) => {
          active.current?.abort();
          setPage(null);
          setTask(null);
          setProofs([]);
          setAssetAfter(null);
          setGeometryAfter(null);
          setNotice('');
          setError(null);
          setReason('');
          setNote('');
          setTarget('');
          setMapping('');
          setSourceKey(e.target.value);
        }}
      >
        {unique.map((s) => (
          <option
            key={referenceKey(s.reference)}
            value={referenceKey(s.reference)}
          >
            {s.label}
          </option>
        ))}
      </select>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={busy || parentBusy}
          onClick={() => void load()}
        >
          {copy.load}
        </button>
        {page?.nextCursor && (
          <button
            type="button"
            disabled={busy || parentBusy}
            onClick={() => void load(page.nextCursor!)}
          >
            {copy.next}
          </button>
        )}
      </div>
      {busy && <p role="status">{copy.loading}</p>}
      {error && error !== 'cancelled' && (
        <p role="alert" className={styles.error}>
          {copy[error]}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {page && (
        <ul className={styles.list}>
          {page.items.map((item) => (
            <li key={item.followupId}>
              <button
                type="button"
                disabled={busy || parentBusy}
                onClick={() => void open(item.followupId)}
              >
                {item.reason}
              </button>
              <span>{copy[item.state]}</span>
            </li>
          ))}
        </ul>
      )}
      {page?.items.length === 0 && <p>{copy.empty}</p>}
      {readOnly ? (
        <p>{copy.readOnly}</p>
      ) : (
        <details className={styles.evidence}>
          <summary>{copy.evidence}</summary>
          {supplementLookup ? (
            <form
              action={supplementLookup.action}
              method="get"
              className={styles.form}
              onSubmit={() => {
                active.current?.abort();
                setProofs([]);
                setAssetAfter(null);
                setGeometryAfter(null);
                setBusy(false);
              }}
            >
              <label htmlFor={`${id}-lookup`}>{copy.supplementIntake}</label>
              <input
                key={supplementLookup.requestedIngestionId}
                id={`${id}-lookup`}
                name="supplementIngestionId"
                defaultValue={supplementLookup.requestedIngestionId}
                disabled={busy || parentBusy}
                aria-describedby={`${id}-lookup-hint`}
              />
              {(task?.followupId ?? supplementLookup.initialFollowupId) ? (
                <input
                  type="hidden"
                  name="followupId"
                  value={task?.followupId ?? supplementLookup.initialFollowupId}
                />
              ) : null}
              <p id={`${id}-lookup-hint`}>{copy.supplementHint}</p>
              <button type="submit" disabled={busy || parentBusy}>
                {copy.findSupplement}
              </button>
              {(supplementLookup.error || supplementBlocked) && !error ? (
                <p role="alert">
                  {supplementLookup.error === 'empty'
                    ? copy.supplementEmpty
                    : supplementLookup.error
                      ? copy[supplementLookup.error]
                      : copy.supplementRecheck}
                </p>
              ) : null}
              {supplementLookup.source && !supplementBlocked ? (
                <p>
                  {copy.supplementSelected}: {supplementLookup.source.label} ·{' '}
                  <span>{supplementLookup.stateLabel}</span>
                </p>
              ) : null}
            </form>
          ) : null}
          <label htmlFor={`${id}-evidence-source`}>{copy.evidenceSource}</label>
          <select
            id={`${id}-evidence-source`}
            value={evidenceSource ? referenceKey(evidenceSource.reference) : ''}
            disabled={busy || parentBusy}
            onChange={(e) => {
              active.current?.abort();
              setProofSourceKey(e.target.value);
              setProofs([]);
              setProofIndex(0);
              setAssetAfter(null);
              setGeometryAfter(null);
              setNotice('');
              setError(null);
            }}
          >
            {(supplementBlocked ? [] : evidenceSources).map((s) => (
              <option
                key={referenceKey(s.reference)}
                value={referenceKey(s.reference)}
              >
                {s.label}
              </option>
            ))}
          </select>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busy || parentBusy || !evidenceSource}
              onClick={() => void loadProof()}
            >
              {copy.loadEvidence}
            </button>
            {assetAfter && (
              <button
                type="button"
                disabled={busy || parentBusy}
                onClick={() => void loadProof(assetAfter)}
              >
                {copy.moreAssets}
              </button>
            )}
            <button
              type="button"
              disabled={busy || parentBusy || !proof}
              onClick={() => void loadGeometry()}
            >
              {copy.loadGeometry}
            </button>
            {geometryAfter && (
              <button
                type="button"
                disabled={busy || parentBusy || !proof}
                onClick={() => void loadGeometry(geometryAfter)}
              >
                {copy.moreGeometry}
              </button>
            )}
          </div>
          <label htmlFor={`${id}-proof`}>{copy.choose}</label>
          <select
            id={`${id}-proof`}
            value={proofIndex}
            disabled={busy || parentBusy || visibleProofs.length === 0}
            onChange={(e) => setProofIndex(Number(e.target.value))}
          >
            {visibleProofs.map((p, i) => (
              <option key={`${p.assetId}:${p.recordId ?? 'asset'}`} value={i}>
                {p.recordId ? copy.geometry : copy.asset} ·{' '}
                {p.recordId ?? p.assetId}
              </option>
            ))}
          </select>
          {!proof && <p>{copy.proofMissing}</p>}
          {proof && (
            <details>
              <summary>{copy.technical}</summary>
              <pre>{JSON.stringify(proof, null, 2)}</pre>
            </details>
          )}
          <fieldset disabled={busy || parentBusy} className={styles.form}>
            <label htmlFor={`${id}-type`}>{copy.type}</label>
            <select
              id={`${id}-type`}
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
            >
              <option value="GAP">{copy.GAP}</option>
              <option value="CORRECTION">{copy.CORRECTION}</option>
            </select>
            <label htmlFor={`${id}-reason`}>{copy.reason}</label>
            <textarea
              id={`${id}-reason`}
              value={reason}
              maxLength={4096}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              disabled={
                !proof ||
                !createSourceMatches ||
                !reason.trim() ||
                (type === 'CORRECTION' && !isRecord(proof))
              }
              onClick={() => void create()}
            >
              {copy.create}
            </button>
            {proof && !createSourceMatches && <p>{copy.proofSourceMismatch}</p>}
          </fieldset>
        </details>
      )}
      {task && (
        <article className={styles.task}>
          <div className={styles.heading}>
            <strong className={styles.badge} data-state={task.state}>
              {copy[task.state]}
            </strong>
            <span>{copy[task.type]}</span>
            <span>{copy.technicalOnly}</span>
          </div>
          <p>{task.reason}</p>
          <dl>
            <dt>{copy.assignee}</dt>
            <dd>{task.assignee?.actorId ?? copy.unassigned}</dd>
            <dt>{copy.version}</dt>
            <dd>{task.rowVersion}</dd>
          </dl>
          {!readOnly && (
            <fieldset disabled={busy || parentBusy} className={styles.form}>
              <label htmlFor={`${id}-note`}>{copy.note}</label>
              <textarea
                id={`${id}-note`}
                value={note}
                maxLength={4096}
                onChange={(e) => setNote(e.target.value)}
              />
              {task.state === 'WORKING' && (
                <>
                  <label htmlFor={`${id}-target`}>{copy.target}</label>
                  <input
                    id={`${id}-target`}
                    value={target}
                    maxLength={36}
                    onChange={(e) => setTarget(e.target.value)}
                  />
                  {task.type === 'CORRECTION' && (
                    <>
                      <label htmlFor={`${id}-old`}>{copy.old}</label>
                      <select
                        id={`${id}-old`}
                        value={oldIndex}
                        onChange={(e) => setOldIndex(Number(e.target.value))}
                      >
                        {originalProofs.map((p, i) => (
                          <option key={i} value={i}>
                            {p.recordId}
                          </option>
                        ))}
                      </select>
                      <label htmlFor={`${id}-mapping`}>{copy.mapping}</label>
                      <textarea
                        id={`${id}-mapping`}
                        value={mapping}
                        maxLength={4096}
                        onChange={(e) => setMapping(e.target.value)}
                      />
                    </>
                  )}
                </>
              )}
              <div className={styles.actions}>
                {(task.state === 'OPEN'
                  ? ['CLAIM']
                  : task.state === 'WORKING'
                    ? ['HANDOFF', 'SUPPLEMENT', 'SUBMIT_REVIEW']
                    : task.state === 'REVIEW_PENDING'
                      ? ['CLOSE', 'RETURN']
                      : ['REOPEN']
                ).map((action) => (
                  <button
                    type="button"
                    key={action}
                    disabled={
                      !note.trim() ||
                      (action === 'HANDOFF' &&
                        !/^[0-9a-f-]{36}$/i.test(target)) ||
                      (action === 'SUPPLEMENT' && !supplementReady) ||
                      (action === 'SUBMIT_REVIEW' && task.evidence.length === 0)
                    }
                    onClick={() =>
                      void act(action as Parameters<typeof act>[0])
                    }
                  >
                    {copy[action as Parameters<typeof act>[0]]}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <details>
            <summary>{copy.technical}</summary>
            <dl>
              <dt>{copy.rule}</dt>
              <dd>
                {task.ruleId} · {task.ruleVersion}
              </dd>
            </dl>
            <pre>
              {JSON.stringify(
                {
                  followupId: task.followupId,
                  source: task.source,
                  responsibilities: task.responsibilities,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <h5>
            {copy.history} · {task.events.length}
          </h5>
          <ol className={styles.history}>
            {task.events.slice(0, historyLimit).map((event) => (
              <li key={event.eventId}>
                <strong>{copy[event.action]}</strong>
                <span>{copy[event.stateAfter]}</span>
                <time dateTime={event.createdAt}>{event.createdAt}</time>
                <p>{event.note}</p>
                <details>
                  <summary>{copy.technical}</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        actor: event.actor,
                        target: event.target,
                        evidence: event.evidence,
                        correction: event.correction,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
          {historyLimit < task.events.length && (
            <button
              type="button"
              onClick={() => setHistoryLimit((n) => Math.min(200, n + 20))}
            >
              {copy.moreHistory}
            </button>
          )}
        </article>
      )}
    </section>
  );
}
