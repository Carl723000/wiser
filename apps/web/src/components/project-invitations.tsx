'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ProjectAccessInvitationViewSchema,
  ProjectAccessInvitationsPageSchema,
  type ProjectAccessInvitationView,
  type ProjectAccessRoleView,
} from '@wiser/platform-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import styles from './project-access-workspace.module.css';
function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
}
async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error('Invitation unavailable');
  return response.json() as Promise<unknown>;
}
export function ProjectInvitations({
  locale,
  projectId,
  roles,
  onChanged,
}: {
  locale: Locale;
  projectId: string;
  roles: readonly ProjectAccessRoleView[];
  onChanged: () => void;
}) {
  const t = getDictionary(locale).projectAccess,
    words = t.invitation;
  const [items, setItems] = useState<readonly ProjectAccessInvitationView[]>(
      [],
    ),
    [more, setMore] = useState(false),
    [page, setPage] = useState(0),
    [revision, setRevision] = useState(0),
    [search, setSearch] = useState('');
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(false),
    [loadError, setLoadError] = useState(false);
  const createReceipt = useRef<{ body: string; key: string } | null>(null),
    deliveryKeys = useRef(new Map<string, string>());
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setMore(false);
    setLoading(true);
    setLoadError(false);
    const q = new URLSearchParams({
      projectId,
      limit: '20',
      offset: String(page * 20),
      search,
    });
    void fetch('/api/platform/access/invitations?' + q.toString(), {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(json)
      .then((value) => ProjectAccessInvitationsPageSchema.parse(value))
      .then((value) => {
        if (!controller.signal.aborted) {
          setItems(value.items);
          setMore(value.hasMore);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, page, revision, search]);
  async function deliver(item: ProjectAccessInvitationView) {
    const body = JSON.stringify({
      projectId,
      invitationId: item.id,
      expectedVersion: item.version,
    });
    let key = deliveryKeys.current.get(body);
    if (!key) {
      key = crypto.randomUUID();
      deliveryKeys.current.set(body, key);
    }
    return ProjectAccessInvitationViewSchema.parse(
      await json(
        await fetch('/api/platform/access/deliver-invitation', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body,
        }),
      ),
    );
  }
  async function retry(item: ProjectAccessInvitationView) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await deliver(item);
      onChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setRevision((x) => x + 1);
    }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget),
      date = new Date(field(form, 'expires'));
    if (!Number.isFinite(date.valueOf())) {
      setError(true);
      return;
    }
    const body = JSON.stringify({
      projectId,
      email: field(form, 'email'),
      roleKey: field(form, 'role'),
      expiresAt: date.toISOString(),
      reason: field(form, 'reason'),
    });
    if (createReceipt.current?.body !== body)
      createReceipt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setError(false);
    try {
      const item = ProjectAccessInvitationViewSchema.parse(
        await json(
          await fetch('/api/platform/access/invite', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': createReceipt.current.key,
            },
            body,
          }),
        ),
      );
      setOpen(false);
      await deliver(item);
      onChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setRevision((x) => x + 1);
    }
  }
  function status(item: ProjectAccessInvitationView) {
    return item.status === 'granted'
      ? words.granted
      : item.status === 'sending'
        ? words.sending
        : item.status === 'failed'
          ? item.lastErrorCode === 'GRANT_UNAVAILABLE'
            ? words.grantFailed
            : words.deliveryUnknown
          : words.pending;
  }
  return (
    <section className={styles.editor} aria-label={words.title}>
      <h3>{words.title}</h3>
      <div className={styles.actions}>
        <button
          disabled={busy || roles.length === 0}
          onClick={() => setOpen(!open)}
        >
          {words.invite}
        </button>
        <button
          disabled={busy || loading}
          onClick={() => setRevision((x) => x + 1)}
        >
          {words.refresh}
        </button>
      </div>
      {open ? (
        <form
          onSubmit={(e) => {
            void invite(e);
          }}
        >
          <label>
            {words.email}
            <input
              name="email"
              type="email"
              maxLength={254}
              required
              disabled={busy}
            />
          </label>
          <label>
            {t.role}
            <select name="role" required disabled={busy}>
              {roles.map((r) => (
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
          <label>
            {t.reason}
            <textarea
              name="reason"
              minLength={5}
              maxLength={1000}
              required
              disabled={busy}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? t.saving : words.submit}
          </button>
        </form>
      ) : null}
      <details>
        <summary>{t.help}</summary>
        <p>{words.help}</p>
      </details>
      <form
        className={styles.search}
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(field(new FormData(e.currentTarget), 'search'));
          setPage(0);
        }}
      >
        <label>
          {words.search}
          <input name="search" type="search" maxLength={100} />
        </label>
        <button type="submit" disabled={busy}>
          {t.searchButton}
        </button>
      </form>
      {error || loadError ? <p role="alert">{words.unavailable}</p> : null}
      {loading ? <p role="status">{t.loading}</p> : null}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>{words.email}</th>
              <th>{t.role}</th>
              <th>{t.expires}</th>
              <th>{t.status}</th>
              <th>{words.accountStatus}</th>
              <th>{t.scope}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.email}</td>
                <td>
                  {item.roleKey === 'data-reader' ? t.readRole : item.roleKey}
                </td>
                <td>{new Date(item.expiresAt).toLocaleString(locale)}</td>
                <td>{status(item)}</td>
                <td>
                  {item.deliveryMode === 'existing'
                    ? words.existing
                    : item.acceptedAt
                      ? words.accepted
                      : words.awaiting}
                </td>
                <td>
                  {item.status !== 'granted' ? (
                    <button
                      disabled={busy}
                      onClick={() => {
                        void retry(item);
                      }}
                    >
                      {words.retry}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && !loadError && items.length === 0 ? (
        <p>{words.empty}</p>
      ) : null}
      <div className={styles.actions}>
        <button
          disabled={page === 0 || busy || loading}
          onClick={() => setPage((x) => x - 1)}
        >
          {t.previous}
        </button>
        <button
          disabled={!more || busy || loading}
          onClick={() => setPage((x) => x + 1)}
        >
          {t.next}
        </button>
      </div>
    </section>
  );
}
