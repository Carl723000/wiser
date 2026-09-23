'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ResourceManagementCatalogPageSchema,
  ResourcePolicyProposalSchema,
  ResourcePolicyRequestsPageSchema,
  ResourcePolicyRequestViewSchema,
  ResourcePolicyRevokeReceiptSchema,
  type ResourceManagementCatalogPage,
  type ResourcePolicyRequestsPage,
} from '@wiser/platform-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import { ContextHelp } from './context-help';
import styles from './project-access-workspace.module.css';
type Props = { projectId: string; viewerId: string; locale: Locale };
type Row = ResourcePolicyRequestsPage['items'][number];
type CatalogItem = ResourceManagementCatalogPage['items'][number];
type Action = 'publish' | 'reject' | 'withdraw' | 'revoke';
const policyActions = [
  'source.discover',
  'content.read',
  'original.read',
  'result.export',
] as const;
async function json(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok)
    throw Error(
      value &&
        typeof value === 'object' &&
        'code' in value &&
        typeof value.code === 'string'
        ? value.code
        : 'ACCESS_UNAVAILABLE',
    );
  return value;
}
export function ProjectSourcePolicies(props: Props) {
  return <SourceWorkspace key={props.projectId} {...props} />;
}
function SourceWorkspace({ projectId, viewerId, locale }: Props) {
  const t = getDictionary(locale).sourcePolicies,
    d = getDictionary(locale).resourceDefinitions;
  const [page, setPage] = useState(0),
    [filter, setFilter] = useState(''),
    [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: ResourcePolicyRequestsPage | null;
    error: string;
  }>({ key: '', data: null, error: '' });
  const [catalogOpen, setCatalogOpen] = useState(false),
    [catalogPage, setCatalogPage] = useState(0),
    [catalogDraft, setCatalogDraft] = useState(''),
    [catalogSearch, setCatalogSearch] = useState(''),
    [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogState, setCatalogState] = useState<{
    key: string;
    data: ResourceManagementCatalogPage | null;
    error: string;
  }>({ key: '', data: null, error: '' });
  const [chosen, setChosen] = useState<{
      item: CatalogItem;
      policyId: string;
      roleOptions: string[];
    } | null>(null),
    [proposalError, setProposalError] = useState('');
  const [editor, setEditor] = useState<{ row: Row; action: Action } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editor) reasonInput.current?.focus();
  }, [editor]);
  const retry = useRef<{ body: string; key: string } | null>(null),
    proposalRetry = useRef<{ body: string; key: string } | null>(null),
    mutation = useRef<AbortController | null>(null);
  const key = `${page}:${filter}:${revision}`,
    data = state.key === key ? state.data : null;
  const catalogKey = `${projectId}:${catalogPage}:${catalogSearch}:${catalogRevision}`,
    catalog = catalogState.key === catalogKey ? catalogState.data : null;
  const errorText = (code: string) =>
    code === 'NOT_AUTHORIZED'
      ? t.denied
      : [
            'VERSION_CONFLICT',
            'REQUEST_STATE_CONFLICT',
            'SELF_CHANGE_FORBIDDEN',
            'IDEMPOTENCY_CONFLICT',
          ].includes(code)
        ? t.conflict
        : t.unavailable;
  function refresh() {
    setEditor(null);
    setRevision((x) => x + 1);
  }
  useEffect(() => {
    const c = new AbortController();
    if (document.visibilityState !== 'hidden')
      void fetch(
        '/api/platform/access/source-policy-requests?' +
          new URLSearchParams({
            projectId,
            offset: String(page * 20),
            limit: '20',
            ...(filter ? { status: filter } : {}),
          }).toString(),
        { cache: 'no-store', signal: c.signal },
      )
        .then(json)
        .then((x) => ResourcePolicyRequestsPageSchema.parse(x))
        .then((value) => {
          if (!c.signal.aborted) setState({ key, data: value, error: '' });
        })
        .catch((e: unknown) => {
          if (!c.signal.aborted) {
            setState({
              key,
              data: null,
              error: e instanceof Error ? e.message : 'ACCESS_UNAVAILABLE',
            });
            setEditor(null);
          }
        });
    return () => c.abort();
  }, [projectId, page, filter, key]);
  useEffect(() => {
    if (!catalogOpen || !data?.canPropose) return;
    const controller = new AbortController();
    void fetch(
      '/api/platform/access/management-catalog?' +
        new URLSearchParams({
          projectId,
          offset: String(catalogPage * 20),
          limit: '20',
          search: catalogSearch,
        }).toString(),
      { cache: 'no-store', signal: controller.signal },
    )
      .then(json)
      .then((value) => ResourceManagementCatalogPageSchema.parse(value))
      .then((value) => {
        if (!controller.signal.aborted)
          setCatalogState({ key: catalogKey, data: value, error: '' });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          if (error instanceof Error && error.message === 'NOT_AUTHORIZED')
            setChosen(null);
          setCatalogState({
            key: catalogKey,
            data: null,
            error:
              error instanceof Error ? error.message : 'ACCESS_UNAVAILABLE',
          });
        }
      });
    return () => controller.abort();
  }, [
    catalogOpen,
    catalogKey,
    catalogPage,
    catalogSearch,
    data?.canPropose,
    projectId,
  ]);
  useEffect(() => {
    const refreshState = () => {
      setEditor(null);
      setChosen(null);
      setCatalogOpen(false);
      setState({ key: '', data: null, error: '' });
      setRevision((x) => x + 1);
    };
    window.addEventListener('focus', refreshState);
    document.addEventListener('visibilitychange', refreshState);
    return () => {
      window.removeEventListener('focus', refreshState);
      document.removeEventListener('visibilitychange', refreshState);
      mutation.current?.abort();
    };
  }, []);
  // Never retain an effective-state label across a known start or expiry boundary.
  useEffect(() => {
    if (!data) return;
    const now = Date.now(),
      times = data.items
        .flatMap((r) => [Date.parse(r.startsAt), Date.parse(r.expiresAt)])
        .filter((x) => x > now);
    if (!times.length) return;
    const timer = window.setTimeout(
      () => {
        setEditor(null);
        setRevision((x) => x + 1);
      },
      Math.min(30000, Math.min(...times) - now + 1),
    );
    return () => window.clearTimeout(timer);
  }, [data]);
  const current = (r: Row) =>
    r.publicationState === 'active' && Date.parse(r.expiresAt) <= Date.now()
      ? 'expired'
      : r.publicationState;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !data || busy) return;
    const value = new FormData(event.currentTarget).get('reason'),
      reason = typeof value === 'string' ? value.trim() : '';
    if (reason.length < 5) {
      setError(t.invalid);
      return;
    }
    const { row, action } = editor;
    const body = JSON.stringify(
      action === 'revoke'
        ? {
            projectId,
            policyId: row.policyId,
            policyVersion: row.publishedVersion,
            reason,
          }
        : {
            projectId,
            requestId: row.id,
            expectedVersion: row.version,
            reason,
            ...(action === 'publish' || action === 'reject'
              ? { decision: action }
              : {}),
          },
    );
    if (retry.current?.body !== body)
      retry.current = { body, key: crypto.randomUUID() };
    const c = new AbortController();
    mutation.current = c;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const value = await json(
        await fetch(
          '/api/platform/access/source-policy-' +
            (action === 'publish' || action === 'reject' ? 'decide' : action),
          {
            method: 'POST',
            cache: 'no-store',
            signal: c.signal,
            headers: {
              'content-type': 'application/json',
              'idempotency-key': retry.current.key,
            },
            body,
          },
        ),
      );
      if (action === 'revoke') ResourcePolicyRevokeReceiptSchema.parse(value);
      else ResourcePolicyRequestViewSchema.parse(value);
      if (!c.signal.aborted) {
        setSaved(
          action === 'publish'
            ? t.savedPublish
            : action === 'reject'
              ? t.savedReject
              : action === 'withdraw'
                ? t.savedWithdraw
                : t.savedRevoke,
        );
        refresh();
      }
    } catch (e) {
      if (!c.signal.aborted) {
        const code = e instanceof Error ? e.message : '';
        setError(errorText(code));
        if (code === 'NOT_AUTHORIZED') {
          setState({ key, data: null, error: code });
          setEditor(null);
        }
      }
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  function edit(row: Row, action: Action) {
    setEditor({ row, action });
    setCatalogOpen(false);
    setChosen(null);
    setError('');
    setSaved('');
    retry.current = null;
  }
  async function submitProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen || !data?.canPropose || busy) return;
    const form = new FormData(event.currentTarget);
    const start = new Date(String(form.get('startsAt') ?? '')),
      end = new Date(String(form.get('expiresAt') ?? ''));
    const command = ResourcePolicyProposalSchema.safeParse({
      projectId,
      policyId: chosen.policyId,
      expectedPolicyVersion: chosen.item.expectedPolicyVersion,
      resource: {
        kind: 'version',
        dataItemId: chosen.item.dataItemId,
        versionId: chosen.item.versionId,
      },
      allowedActions: form.getAll('actions'),
      managementRoles: form.getAll('roles'),
      licenseBasis: form.get('licenseBasis'),
      startsAt: Number.isFinite(start.valueOf()) ? start.toISOString() : '',
      expiresAt: Number.isFinite(end.valueOf()) ? end.toISOString() : '',
      maxGrantDays: Number(form.get('maxGrantDays')),
      reason: form.get('reason'),
    });
    if (!command.success) {
      setProposalError(t.proposalInvalid);
      return;
    }
    const body = JSON.stringify(command.data);
    if (proposalRetry.current?.body !== body)
      proposalRetry.current = { body, key: crypto.randomUUID() };
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setProposalError('');
    setSaved('');
    try {
      ResourcePolicyRequestViewSchema.parse(
        await json(
          await fetch('/api/platform/access/source-policy-propose', {
            method: 'POST',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              'idempotency-key': proposalRetry.current.key,
            },
            body,
          }),
        ),
      );
      if (!controller.signal.aborted) {
        setSaved(t.savedProposal);
        setChosen(null);
        setCatalogOpen(false);
        setCatalogRevision((value) => value + 1);
        refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code =
          error instanceof Error ? error.message : 'ACCESS_UNAVAILABLE';
        setProposalError(errorText(code));
        if (code === 'VERSION_CONFLICT' || code === 'RESOURCE_UNAVAILABLE') {
          setChosen(null);
          setCatalogRevision((value) => value + 1);
        }
        if (code === 'NOT_AUTHORIZED') {
          setChosen(null);
          setCatalogOpen(false);
          setState({ key, data: null, error: code });
        }
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label={t.title}>
      <div className={styles.actions}>
        <ContextHelp label={t.help}>{t.helpText}</ContextHelp>
        {data?.canPropose ? (
          <button
            disabled={busy}
            aria-expanded={catalogOpen}
            onClick={() => {
              setCatalogOpen((value) => !value);
              setChosen(null);
              setEditor(null);
              setProposalError('');
            }}
          >
            {t.create}
          </button>
        ) : null}
        <label>
          {t.history}
          <select
            value={filter}
            disabled={busy}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
              setEditor(null);
            }}
          >
            <option value="">{t.all}</option>
            {(['pending', 'published', 'rejected', 'withdrawn'] as const).map(
              (s) => (
                <option key={s} value={s}>
                  {t[s]}
                </option>
              ),
            )}
          </select>
        </label>
        <button disabled={busy} onClick={refresh}>
          {t.refresh}
        </button>
      </div>
      {saved ? <p role="status">{saved}</p> : null}
      {state.key === key && state.error ? (
        <p role="alert">{errorText(state.error)}</p>
      ) : !data ? (
        <p role="status">{t.loading}</p>
      ) : null}
      {data ? (
        <>
          <p>
            {t.checked} ·{' '}
            <time dateTime={data.checkedAt}>
              {new Date(data.checkedAt).toLocaleString(locale)}
            </time>
          </p>
          {!data.items.length ? <p>{t.empty}</p> : null}
          {data.items.map((row) => (
            <article key={row.id} className={styles.editor}>
              <h3>{row.licenseBasis}</h3>
              <dl className={styles.facts}>
                <div>
                  <dt>{t.history}</dt>
                  <dd>
                    <span className={styles.badge} data-status={row.status}>
                      {t[row.status]}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>{t.current}</dt>
                  <dd>
                    <span className={styles.badge} data-status={current(row)}>
                      {t[current(row)]}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>{t.term}</dt>
                  <dd>
                    <time dateTime={row.startsAt}>
                      {new Date(row.startsAt).toLocaleString(locale)}
                    </time>{' '}
                    —{' '}
                    <time dateTime={row.expiresAt}>
                      {new Date(row.expiresAt).toLocaleString(locale)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>{d.actions}</dt>
                  <dd>{row.allowedActions.map((a) => d[a]).join(' · ')}</dd>
                </div>
                <div>
                  <dt>{t.days}</dt>
                  <dd>{row.maxGrantDays}</dd>
                </div>
              </dl>
              <details>
                <summary>{t.details}</summary>
                <p>
                  {t.resource} ·{' '}
                  {row.resource.kind === 'version'
                    ? t.versionResource
                    : t.externalResource}
                </p>
                {row.resource.kind === 'version' ? (
                  <a
                    href={`/${locale}/data-foundation/catalog/${row.resource.dataItemId}?versionId=${row.resource.versionId}`}
                  >
                    {t.openResource}
                  </a>
                ) : (
                  <p>{row.resource.sourceId}</p>
                )}
                <p>
                  {t.roles} · {row.managementRoles.join(' · ')}
                </p>
                <p>{row.reason}</p>
                {row.decisionReason ? <p>{row.decisionReason}</p> : null}
              </details>
              <div className={styles.actions}>
                {row.status === 'pending' &&
                data.canApprove &&
                row.applicantId !== viewerId ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => edit(row, 'publish')}
                    >
                      {t.publish}
                    </button>
                    <button disabled={busy} onClick={() => edit(row, 'reject')}>
                      {t.reject}
                    </button>
                  </>
                ) : null}
                {row.status === 'pending' &&
                data.canPropose &&
                row.applicantId === viewerId ? (
                  <button disabled={busy} onClick={() => edit(row, 'withdraw')}>
                    {t.withdraw}
                  </button>
                ) : null}
                {row.status === 'published' &&
                data.canPropose &&
                ['active', 'scheduled'].includes(current(row)) ? (
                  <button disabled={busy} onClick={() => edit(row, 'revoke')}>
                    {t.revoke}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          <div className={styles.actions}>
            <button
              disabled={busy || page === 0}
              onClick={() => {
                setPage((x) => x - 1);
                setEditor(null);
              }}
            >
              {t.previous}
            </button>
            <button
              disabled={busy || !data.hasMore || page >= 500}
              onClick={() => {
                setPage((x) => x + 1);
                setEditor(null);
              }}
            >
              {t.next}
            </button>
          </div>
        </>
      ) : null}
      {catalogOpen && data?.canPropose ? (
        <section className={styles.editor} aria-label={t.catalog}>
          <h3>{t.catalog}</h3>
          {proposalError ? <p role="alert">{proposalError}</p> : null}
          <form
            className={styles.search}
            onSubmit={(event) => {
              event.preventDefault();
              setCatalogSearch(catalogDraft.trim());
              setCatalogPage(0);
              setChosen(null);
            }}
          >
            <label>
              {t.catalogSearch}
              <input
                value={catalogDraft}
                onChange={(event) => setCatalogDraft(event.target.value)}
                maxLength={120}
                disabled={busy}
              />
            </label>
            <button disabled={busy} type="submit">
              {t.catalogQuery}
            </button>
          </form>
          {catalogState.key === catalogKey && catalogState.error ? (
            <p role="alert">{errorText(catalogState.error)}</p>
          ) : !catalog ? (
            <p role="status">{t.catalogLoading}</p>
          ) : (
            <>
              {!catalog.items.length ? <p>{t.catalogEmpty}</p> : null}
              <ul className={styles.sourceCatalogList}>
                {catalog.items.map((item) => (
                  <li
                    key={`${item.dataItemId}:${item.versionId}`}
                    data-version-id={item.versionId}
                  >
                    <div>
                      <strong>{item.name}</strong>
                      <span>
                        {item.sourceOrganization} · {t.versionNumber}
                        {item.versionNumber}
                        {t.versionSuffix} · {t[item.securityLevel]}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setChosen({
                          item,
                          policyId: item.policyId ?? crypto.randomUUID(),
                          roleOptions: catalog.managementRoleOptions,
                        });
                        setProposalError('');
                        proposalRetry.current = null;
                      }}
                      aria-label={`${t.chooseSource}${item.sourceOrganization}${t.sourceGenitive}${t.versionNumber}${item.versionNumber}${t.versionSuffix}`}
                    >
                      {t.choose}
                    </button>
                  </li>
                ))}
              </ul>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={busy || catalogPage === 0}
                  onClick={() => setCatalogPage((value) => value - 1)}
                >
                  {t.previous}
                </button>
                <button
                  type="button"
                  disabled={busy || !catalog.hasMore || catalogPage >= 500}
                  onClick={() => setCatalogPage((value) => value + 1)}
                >
                  {t.next}
                </button>
              </div>
            </>
          )}
          {chosen ? (
            <section className={styles.editor} aria-label={t.proposal}>
              <h3>{t.proposal}</h3>
              <p>
                <strong>{chosen.item.name}</strong> ·{' '}
                {chosen.item.sourceOrganization} · {t.versionNumber}
                {chosen.item.versionNumber}
                {t.versionSuffix}
              </p>
              <form
                onSubmit={(event) => {
                  void submitProposal(event);
                }}
              >
                <fieldset className={styles.sourceChoiceGrid}>
                  <legend>{d.actions}</legend>
                  {policyActions.map((action) => (
                    <label key={action}>
                      <input type="checkbox" name="actions" value={action} />
                      {d[action]}
                    </label>
                  ))}
                </fieldset>
                <fieldset className={styles.sourceChoiceGrid}>
                  <legend>{t.roles}</legend>
                  {chosen.roleOptions.length ? (
                    chosen.roleOptions.map((role) => (
                      <label key={role}>
                        <input type="checkbox" name="roles" value={role} />
                        {role}
                      </label>
                    ))
                  ) : (
                    <p>{t.noRoles}</p>
                  )}
                </fieldset>
                <label>
                  {t.license}
                  <textarea
                    name="licenseBasis"
                    minLength={5}
                    maxLength={1000}
                    required
                    rows={2}
                  />
                </label>
                <div className={styles.sourceDates}>
                  <label>
                    {t.startsAt}
                    <input type="datetime-local" name="startsAt" required />
                  </label>
                  <label>
                    {t.expiresAt}
                    <input type="datetime-local" name="expiresAt" required />
                  </label>
                  <label>
                    {t.maxGrantDays}
                    <input
                      type="number"
                      name="maxGrantDays"
                      min={1}
                      max={366}
                      defaultValue={30}
                      required
                    />
                  </label>
                </div>
                <label>
                  {t.proposalReason}
                  <textarea
                    name="reason"
                    minLength={5}
                    maxLength={1000}
                    required
                    rows={2}
                  />
                </label>
                <div className={styles.actions}>
                  <button
                    type="submit"
                    disabled={busy || !chosen.roleOptions.length}
                  >
                    {busy ? t.saving : t.submitProposal}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setChosen(null)}
                  >
                    {t.cancel}
                  </button>
                </div>
              </form>
            </section>
          ) : null}
        </section>
      ) : null}
      {editor && data ? (
        <section className={styles.editor} aria-label={t[editor.action]}>
          <h3>{t[editor.action]}</h3>
          <p>{editor.row.licenseBasis}</p>
          {editor.action === 'publish' ? (
            <p>{t.publishImpact}</p>
          ) : editor.action === 'revoke' ? (
            <p>{t.revokeImpact}</p>
          ) : null}
          <form
            onSubmit={(e) => {
              void submit(e);
            }}
          >
            <label>
              {t.reason}
              <textarea
                ref={reasonInput}
                name="reason"
                required
                minLength={5}
                maxLength={1000}
                rows={3}
              />
            </label>
            {error ? <p role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <button disabled={busy} type="submit">
                {busy
                  ? t.saving
                  : editor.action === 'publish'
                    ? t.confirmPublish
                    : editor.action === 'reject'
                      ? t.confirmReject
                      : editor.action === 'withdraw'
                        ? t.confirmWithdraw
                        : t.confirmRevoke}
              </button>
              <button
                disabled={busy}
                type="button"
                onClick={() => setEditor(null)}
              >
                {t.cancel}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </section>
  );
}
