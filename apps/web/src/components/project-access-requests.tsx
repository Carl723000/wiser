'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ProjectAccessRequestsPageSchema,
  ProjectAccessRequestViewSchema,
  ProjectAccessEventsPageSchema,
  type ProjectAccessRequestView,
  type ProjectAccessProjectView,
  type ProjectAccessEventView,
} from '@wiser/platform-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import styles from './project-access-workspace.module.css';
function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
}
async function json(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      value &&
        typeof value === 'object' &&
        'code' in value &&
        typeof value.code === 'string'
        ? value.code
        : 'ACCESS_UNAVAILABLE',
    );
  return value;
}
type Action = 'approve' | 'reject' | 'withdraw' | 'execute';
export function ProjectAccessRequests({
  locale,
  project,
  viewerId,
  review = false,
  initialApplicationOpen = false,
}: {
  locale: Locale;
  project: ProjectAccessProjectView;
  viewerId: string;
  review?: boolean;
  initialApplicationOpen?: boolean;
}) {
  const t = getDictionary(locale).projectAccess,
    w = t.request;
  const [items, setItems] = useState<readonly ProjectAccessRequestView[]>([]),
    [hasMore, setHasMore] = useState(false),
    [page, setPage] = useState(0),
    [search, setSearch] = useState(''),
    [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(false),
    [open, setOpen] = useState(
      initialApplicationOpen && !review && project.requestsEnabled,
    );
  const [selected, setSelected] = useState<{
    item: ProjectAccessRequestView;
    action: Action;
  } | null>(null);
  const receipts = useRef(new Map<string, string>());
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setHasMore(false);
    setLoading(true);
    setLoadError(false);
    void fetch(
      '/api/platform/access/requests?' +
        new URLSearchParams({
          projectId: project.projectId,
          offset: String(page * 20),
          limit: '20',
          search,
        }).toString(),
      { cache: 'no-store', signal: controller.signal },
    )
      .then(json)
      .then((x) => ProjectAccessRequestsPageSchema.parse(x))
      .then((x) => {
        if (!controller.signal.aborted) {
          setItems(x.items);
          setHasMore(x.hasMore);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [project.projectId, page, search, revision]);
  function message(code: string) {
    return code === 'NOT_AUTHORIZED' || code === 'NOT_AUTHENTICATED'
      ? w.denied
      : code === 'VERSION_CONFLICT' ||
          code === 'REQUEST_STATE_CONFLICT' ||
          code === 'REQUEST_ALREADY_PENDING' ||
          code === 'IDEMPOTENCY_CONFLICT'
        ? w.conflict
        : code === 'INVALID_EXPIRY' ||
            code === 'ROLE_NOT_ASSIGNABLE' ||
            code === 'VALIDATION_FAILED'
          ? w.invalid
          : w.unavailable;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    let path: string, command: unknown;
    if (selected) {
      path =
        selected.action === 'execute'
          ? 'execute-request'
          : selected.action === 'withdraw'
            ? 'withdraw-request'
            : 'decide-request';
      command = {
        projectId: project.projectId,
        requestId: selected.item.id,
        expectedVersion: selected.item.version,
        ...(selected.action === 'execute'
          ? {}
          : { reason: field(form, 'reason') }),
        ...(selected.action === 'approve' || selected.action === 'reject'
          ? { decision: selected.action }
          : {}),
      };
    } else {
      const expires = new Date(field(form, 'expires'));
      if (!Number.isFinite(expires.valueOf())) {
        setError(w.invalid);
        return;
      }
      path = 'request';
      command = {
        projectId: project.projectId,
        roleKey: field(form, 'role'),
        expiresAt: expires.toISOString(),
        reason: field(form, 'reason'),
      };
    }
    const body = JSON.stringify(command),
      fingerprint = path + body;
    let key = receipts.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      receipts.current.set(fingerprint, key);
    }
    setBusy(true);
    setError(null);
    setNotice(false);
    try {
      const result = ProjectAccessRequestViewSchema.parse(
        await json(
          await fetch('/api/platform/access/' + path, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body,
          }),
        ),
      );
      setOpen(false);
      setSelected(null);
      setNotice(true);
      if (result.status === 'execution_failed')
        setError(
          result.lastErrorCode === 'VERSION_CONFLICT'
            ? w.versionFailure
            : w.policyFailure,
        );
    } catch (e) {
      setError(message(e instanceof Error ? e.message : ''));
    } finally {
      setBusy(false);
      setRevision((x) => x + 1);
    }
  }
  function choose(item: ProjectAccessRequestView, action: Action) {
    setSelected({ item, action });
    setOpen(false);
    setError(null);
    setNotice(false);
  }
  return (
    <section className={styles.editor} aria-label={w.title}>
      <h3>{w.title}</h3>
      <p className={styles.flow}>{w.steps}</p>
      <div className={styles.actions}>
        {!review && project.requestsEnabled ? (
          <button
            disabled={busy || project.assignableRoles.length === 0}
            onClick={() => {
              setOpen(!open);
              setSelected(null);
              setError(null);
            }}
          >
            {w.apply}
          </button>
        ) : null}
        <button
          disabled={busy || loading}
          onClick={() => {
            setSelected(null);
            setRevision((x) => x + 1);
          }}
        >
          {w.refresh}
        </button>
      </div>
      <details>
        <summary>{t.help}</summary>
        <p>{review ? w.approvalHelp : w.applyHelp}</p>
      </details>
      {open || selected ? (
        <form
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          {selected ? (
            <p>
              {selected.item.applicantEmail} ·{' '}
              {selected.item.roleKey === 'data-reader'
                ? t.readRole
                : selected.item.roleKey}{' '}
              · {w[selected.action]}
            </p>
          ) : (
            <>
              <label>
                {t.role}
                <select name="role" required disabled={busy}>
                  {project.assignableRoles.map((r) => (
                    <option key={r.roleKey} value={r.roleKey}>
                      {r.roleKey === 'data-reader' ? t.readRole : r.roleKey}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t.expires}
                <input
                  name="expires"
                  type="datetime-local"
                  required
                  disabled={busy}
                />
              </label>
            </>
          )}
          {selected?.action !== 'execute' ? (
            <label>
              {selected ? w.decisionReason : t.reason}
              <textarea
                name="reason"
                minLength={5}
                maxLength={1000}
                required
                disabled={busy}
              />
            </label>
          ) : null}
          <div className={styles.actions}>
            <button type="submit" disabled={busy}>
              {busy ? t.saving : selected ? w.confirm : w.submit}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setOpen(false);
              }}
            >
              {w.cancel}
            </button>
          </div>
        </form>
      ) : null}
      <form
        className={styles.search}
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(field(new FormData(e.currentTarget), 'search'));
          setPage(0);
          setSelected(null);
        }}
      >
        <label>
          {w.search}
          <input type="search" name="search" maxLength={100} />
        </label>
        <button disabled={busy}>{t.searchButton}</button>
      </form>
      {error || loadError ? <p role="alert">{error ?? w.unavailable}</p> : null}
      {notice ? <p role="status">{w.saved}</p> : null}
      {loading ? <p role="status">{t.loading}</p> : null}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>{w.applicant}</th>
              <th>{t.role}</th>
              <th>{t.expires}</th>
              <th>{t.reason}</th>
              <th>{w.result}</th>
              <th>{w.currentAccess}</th>
              <th>{w.decision}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.applicantEmail}</td>
                <td>
                  <span className={styles.roleBadge}>
                    {item.roleKey === 'data-reader' ? t.readRole : item.roleKey}
                  </span>
                </td>
                <td>{new Date(item.expiresAt).toLocaleString(locale)}</td>
                <td>{item.reason}</td>
                <td>
                  <span className={styles.badge} data-status={item.status}>
                    {w[item.status]}
                  </span>
                  {item.decisionReason ? (
                    <details>
                      <summary>{w.decisionReason}</summary>
                      <p>{item.decisionReason}</p>
                    </details>
                  ) : null}
                  {item.lastErrorCode ? (
                    <p>
                      {item.lastErrorCode === 'VERSION_CONFLICT'
                        ? w.versionFailure
                        : w.policyFailure}
                    </p>
                  ) : null}
                </td>
                <td>
                  <span className={styles.badge} data-status={item.accessState}>
                    {item.accessState === 'expired'
                      ? w.accessExpired
                      : w[item.accessState]}
                  </span>
                </td>
                <td>
                  <div className={styles.actions}>
                    {review &&
                    project.canApprove &&
                    item.applicantId !== viewerId &&
                    item.status === 'pending' ? (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => choose(item, 'approve')}
                        >
                          {w.approve}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => choose(item, 'reject')}
                        >
                          {w.reject}
                        </button>
                      </>
                    ) : null}
                    {review &&
                    project.canApprove &&
                    item.decidedBy === viewerId &&
                    (item.status === 'approved' ||
                      item.status === 'execution_failed') ? (
                      <button
                        disabled={busy}
                        onClick={() => choose(item, 'execute')}
                      >
                        {item.status === 'approved' ? w.execute : w.retry}
                      </button>
                    ) : null}
                    {item.applicantId === viewerId &&
                    ['pending', 'approved', 'execution_failed'].includes(
                      item.status,
                    ) ? (
                      <button
                        disabled={busy}
                        onClick={() => choose(item, 'withdraw')}
                      >
                        {w.withdraw}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !loadError && items.length === 0 ? <p>{w.empty}</p> : null}
      <div className={styles.actions}>
        <button
          disabled={busy || loading || page === 0}
          onClick={() => {
            setPage((x) => x - 1);
            setSelected(null);
          }}
        >
          {t.previous}
        </button>
        <button
          disabled={busy || loading || !hasMore}
          onClick={() => {
            setPage((x) => x + 1);
            setSelected(null);
          }}
        >
          {t.next}
        </button>
      </div>
      {review ? (
        <ProjectAccessHistory
          key={revision}
          locale={locale}
          projectId={project.projectId}
        />
      ) : null}
    </section>
  );
}
function ProjectAccessHistory({
  locale,
  projectId,
}: {
  locale: Locale;
  projectId: string;
}) {
  const t = getDictionary(locale).projectAccess,
    w = t.request;
  const [open, setOpen] = useState(false),
    [items, setItems] = useState<readonly ProjectAccessEventView[]>([]),
    [page, setPage] = useState(0),
    [more, setMore] = useState(false),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setItems([]);
    setMore(false);
    setError(false);
    setLoading(true);
    void fetch(
      '/api/platform/access/events?' +
        new URLSearchParams({
          projectId,
          offset: String(page * 20),
          limit: '20',
        }).toString(),
      { cache: 'no-store', signal: controller.signal },
    )
      .then(json)
      .then((x) => ProjectAccessEventsPageSchema.parse(x))
      .then((x) => {
        if (!controller.signal.aborted) {
          setItems(x.items);
          setMore(x.hasMore);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, page, open]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{w.history}</summary>
      <p>{w.historyHelp}</p>
      {error ? <p role="alert">{w.unavailable}</p> : null}
      {loading ? <p role="status">{t.loading}</p> : null}
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            {new Date(item.createdAt).toLocaleString(locale)} ·{' '}
            {w.events[item.action as keyof typeof w.events] ?? w.action} ·{' '}
            {item.reason}
            <details>
              <summary>{w.operator}</summary>
              <code>{item.actorId}</code>
            </details>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <button
          disabled={loading || page === 0}
          onClick={() => setPage((x) => x - 1)}
        >
          {t.previous}
        </button>
        <button
          disabled={loading || !more}
          onClick={() => setPage((x) => x + 1)}
        >
          {t.next}
        </button>
      </div>
    </details>
  );
}
