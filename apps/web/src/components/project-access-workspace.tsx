'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ProjectAccessMembersPageSchema,
  ProjectAccessProjectsPageSchema,
  type ProjectAccessProjectView,
  type ProjectAccessMemberView,
} from '@wiser/platform-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import styles from './project-access-workspace.module.css';
import { ProjectInvitations } from './project-invitations';
type Props = {
  locale: Locale;
  initial: { items: readonly ProjectAccessProjectView[]; hasMore: boolean };
  environmentLabel: string;
};
function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}
type Text = ReturnType<typeof getDictionary>['projectAccess'];
function statusLabel(status: string | null, t: Text) {
  return status === 'active'
    ? t.active
    : status === 'expired'
      ? t.expired
      : status === 'revoked'
        ? t.revoked
        : status === 'suspended'
          ? t.suspended
          : status === null
            ? t.noRole
            : t.unknown;
}
function roleLabel(role: string, t: Text) {
  return role === 'data-reader' ? t.readRole : role;
}
function failureLabel(code: string, t: Text) {
  return code === 'NOT_AUTHORIZED'
    ? t.denied
    : code === 'NOT_AUTHENTICATED'
      ? t.authentication
      : code === 'VERSION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT'
        ? t.conflict
        : code === 'SELF_CHANGE_FORBIDDEN' || code === 'PROTECTED_MEMBER'
          ? t.self
          : code === 'INVALID_EXPIRY' ||
              code === 'ROLE_NOT_ASSIGNABLE' ||
              code === 'VALIDATION_FAILED'
            ? t.invalid
            : t.unavailable;
}
async function result(response: Response): Promise<unknown> {
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(
      typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        typeof value.code === 'string'
        ? value.code
        : 'ACCESS_UNAVAILABLE',
    );
  }
  return (await response.json()) as unknown;
}
function MemberEditor({
  member,
  project,
  locale,
  onClose,
  onSaved,
  revoke,
}: {
  member: ProjectAccessMemberView;
  project: ProjectAccessProjectView;
  locale: Locale;
  onClose: () => void;
  onSaved: () => void;
  revoke: boolean;
}) {
  const t = getDictionary(locale).projectAccess;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const receipt = useRef<{ body: string; key: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const expires = formText(form, 'expires');
    const parsed = new Date(expires);
    if (!revoke && !Number.isFinite(parsed.valueOf())) {
      setError(t.invalid);
      return;
    }
    const command = {
      projectId: project.projectId,
      actorId: member.actorId,
      expectedVersion: member.version,
      reason: formText(form, 'reason'),
      ...(revoke
        ? {}
        : {
            roleKey: formText(form, 'role'),
            expiresAt: parsed.toISOString(),
          }),
    };
    const body = JSON.stringify(command);
    if (receipt.current?.body !== body)
      receipt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      await result(
        await fetch('/api/platform/access/' + (revoke ? 'revoke' : 'grant'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': receipt.current.key,
          },
          body,
        }),
      );
      onSaved();
    } catch (e) {
      setError(failureLabel(e instanceof Error ? e.message : '', t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.editor} aria-label={revoke ? t.revoke : t.edit}>
      <h3>
        {revoke ? t.revoke : t.edit} · {member.displayName || member.email}
      </h3>
      <p>{revoke ? t.revokeHint : t.expiryHint}</p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {!revoke ? (
          <>
            <label>
              {t.role}
              <select
                name="role"
                defaultValue={
                  member.roles.find((r) =>
                    project.assignableRoles.some(
                      (a) => a.roleKey === r.roleKey,
                    ),
                  )?.roleKey ?? project.assignableRoles[0]?.roleKey
                }
                required
              >
                {project.assignableRoles.map((r) => (
                  <option key={r.roleKey} value={r.roleKey}>
                    {roleLabel(r.roleKey, t)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.expires}
              <input type="datetime-local" name="expires" required />
            </label>
          </>
        ) : null}
        <label>
          {t.reason}
          <textarea
            name="reason"
            minLength={5}
            maxLength={1000}
            required
            rows={3}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <button
            disabled={busy || (!revoke && !project.assignableRoles.length)}
            type="submit"
          >
            {busy ? t.saving : revoke ? t.revoke : t.save}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            {t.cancel}
          </button>
        </div>
      </form>
    </section>
  );
}
export function ProjectAccessWorkspace({
  locale,
  initial,
  environmentLabel,
}: Props) {
  const t = getDictionary(locale).projectAccess;
  const [projects, setProjects] = useState(initial);
  const [projectId, setProjectId] = useState(initial.items[0]?.projectId ?? '');
  const [view, setView] = useState<'mine' | 'members'>('mine');
  const [projectPage, setProjectPage] = useState(0);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectLoading, setProjectLoading] = useState(false);
  const [members, setMembers] = useState<{
    items: ProjectAccessMemberView[];
    hasMore: boolean;
  }>({ items: [], hasMore: false });
  const [memberSearch, setMemberSearch] = useState('');
  const [memberPage, setMemberPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    member: ProjectAccessMemberView;
    revoke: boolean;
  } | null>(null);
  const project = projects.items.find((p) => p.projectId === projectId);
  const generation = useRef(0);
  const projectRequest = useRef<AbortController | null>(null);
  useEffect(() => () => projectRequest.current?.abort(), []);
  useEffect(() => {
    const serial = ++generation.current;
    setMembers({ items: [], hasMore: false });
    setEditing(null);
    setError(null);
    if (view !== 'members' || !project?.canManage) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const query = new URLSearchParams({
      projectId: project.projectId,
      search: memberSearch,
      offset: String(memberPage * 20),
      limit: '20',
    });
    void fetch('/api/platform/access/members?' + query.toString(), {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(result)
      .then((value) => {
        if (serial === generation.current && !controller.signal.aborted)
          setMembers(ProjectAccessMembersPageSchema.parse(value));
      })
      .catch((e) => {
        if (serial === generation.current && !controller.signal.aborted) {
          setMembers({ items: [], hasMore: false });
          setError(failureLabel(e instanceof Error ? e.message : '', t));
        }
      })
      .finally(() => {
        if (serial === generation.current && !controller.signal.aborted)
          setLoading(false);
      });
    return () => controller.abort();
  }, [
    project?.projectId,
    project?.canManage,
    view,
    memberSearch,
    memberPage,
    revision,
    t,
  ]);
  async function findProjects(search: string, page: number) {
    projectRequest.current?.abort();
    const controller = new AbortController();
    projectRequest.current = controller;
    setProjectLoading(true);
    setProjects({ items: [], hasMore: false });
    setProjectId('');
    setView('mine');
    setError(null);
    try {
      const value = ProjectAccessProjectsPageSchema.parse(
        await result(
          await fetch(
            '/api/platform/access/projects?' +
              new URLSearchParams({
                search,
                offset: String(page * 20),
                limit: '20',
              }).toString(),
            { signal: controller.signal, cache: 'no-store' },
          ),
        ),
      );
      if (!controller.signal.aborted) {
        setProjects(value);
        setProjectId(value.items[0]?.projectId ?? '');
        setProjectPage(page);
        setProjectSearch(search);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(failureLabel(e instanceof Error ? e.message : '', t));
    } finally {
      if (!controller.signal.aborted) setProjectLoading(false);
    }
  }
  return (
    <main id="main-content" className={styles.workspace}>
      <header className={styles.heading}>
        <div>
          <h1>{t.title}</h1>
          <p>{t.description}</p>
        </div>
        <span className={styles.environment}>
          {t.environment} · {environmentLabel}
        </span>
      </header>
      <form
        className={styles.search}
        onSubmit={(e) => {
          e.preventDefault();
          void findProjects(
            formText(new FormData(e.currentTarget), 'search'),
            0,
          );
        }}
      >
        <label>
          {t.search}
          <input name="search" maxLength={100} />
        </label>
        <button disabled={projectLoading} type="submit">
          {t.searchButton}
        </button>
      </form>
      {projectLoading ? <p role="status">{t.loading}</p> : null}
      <div className={styles.layout}>
        <aside className={styles.projects} aria-label={t.choose}>
          {projects.items.map((p) => (
            <button
              key={p.projectId}
              aria-pressed={projectId === p.projectId}
              onClick={() => {
                setProjectId(p.projectId);
                setMemberPage(0);
                setNotice(null);
                setView('mine');
              }}
            >
              {locale === 'zh-CN' ? p.nameZh : p.nameEn}
            </button>
          ))}
          <div className={styles.actions}>
            <button
              disabled={projectPage === 0 || projectLoading}
              onClick={() => void findProjects(projectSearch, projectPage - 1)}
            >
              {t.previous}
            </button>
            <button
              disabled={!projects.hasMore || projectLoading}
              onClick={() => void findProjects(projectSearch, projectPage + 1)}
            >
              {t.next}
            </button>
          </div>
        </aside>
        <section className={styles.content}>
          {project ? (
            <>
              <nav className={styles.tabs} aria-label={t.title}>
                <button
                  aria-pressed={view === 'mine'}
                  onClick={() => setView('mine')}
                >
                  {t.mine}
                </button>
                {project.canManage ? (
                  <button
                    aria-pressed={view === 'members'}
                    onClick={() => setView('members')}
                  >
                    {t.members}
                  </button>
                ) : null}
              </nav>
              <h2>{view === 'mine' ? t.mine : t.members}</h2>
              {view === 'mine' ? (
                <>
                  <dl className={styles.facts}>
                    <div>
                      <dt>{t.status}</dt>
                      <dd>
                        {statusLabel(
                          project.memberStatus === 'active' &&
                            project.roles.length === 0
                            ? null
                            : project.memberStatus,
                          t,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.role}</dt>
                      <dd>
                        {project.roles
                          .map((r) => roleLabel(r, t))
                          .join(' / ') || t.noRole}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.expires}</dt>
                      <dd>
                        {project.expiresAt
                          ? new Date(project.expiresAt).toLocaleString(locale)
                          : t.noExpiry}
                      </dd>
                    </div>
                  </dl>
                  <details>
                    <summary>{t.help}</summary>
                    <p>{t.expiryHint}</p>
                    <p>{t.readScope}</p>
                  </details>
                </>
              ) : (
                <>
                  <form
                    className={styles.search}
                    onSubmit={(e) => {
                      e.preventDefault();
                      setMemberSearch(
                        formText(new FormData(e.currentTarget), 'search'),
                      );
                      setMemberPage(0);
                      setRevision((r) => r + 1);
                    }}
                  >
                    <label>
                      {t.memberSearch}
                      <input name="search" maxLength={100} />
                    </label>
                    <button type="submit">{t.searchButton}</button>
                    <button
                      type="button"
                      onClick={() => setRevision((r) => r + 1)}
                    >
                      {t.refresh}
                    </button>
                  </form>
                  {loading ? (
                    <p role="status">{t.loading}</p>
                  ) : members.items.length ? (
                    <div className={styles.table}>
                      <table>
                        <thead>
                          <tr>
                            <th>{t.member}</th>
                            <th>{t.role}</th>
                            <th>{t.expires}</th>
                            <th>{t.status}</th>
                            <th>{t.scope}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.items.map((m) => (
                            <tr key={m.actorId}>
                              <td>
                                <strong>{m.displayName}</strong>
                                <span>{m.email}</span>
                              </td>
                              <td>
                                {m.roles
                                  .map((r) => roleLabel(r.roleKey, t))
                                  .join(' / ') || t.noRole}
                              </td>
                              <td>
                                {m.expiresAt
                                  ? new Date(m.expiresAt).toLocaleString(locale)
                                  : t.noExpiry}
                              </td>
                              <td>{statusLabel(m.status, t)}</td>
                              <td>
                                {m.protected ? (
                                  <span>{t.protected}</span>
                                ) : (
                                  <div className={styles.actions}>
                                    <button
                                      onClick={() =>
                                        setEditing({ member: m, revoke: false })
                                      }
                                    >
                                      {t.edit}
                                    </button>
                                    {m.status === 'active' ? (
                                      <button
                                        onClick={() =>
                                          setEditing({
                                            member: m,
                                            revoke: true,
                                          })
                                        }
                                      >
                                        {t.revoke}
                                      </button>
                                    ) : null}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : !error ? (
                    <p>{t.emptyMembers}</p>
                  ) : null}
                  <div className={styles.actions}>
                    <button
                      disabled={memberPage === 0 || loading}
                      onClick={() => setMemberPage((p) => p - 1)}
                    >
                      {t.previous}
                    </button>
                    <button
                      disabled={!members.hasMore || loading}
                      onClick={() => setMemberPage((p) => p + 1)}
                    >
                      {t.next}
                    </button>
                  </div>
                  {editing ? (
                    <MemberEditor
                      key={editing.member.actorId + String(editing.revoke)}
                      {...editing}
                      project={project}
                      locale={locale}
                      onClose={() => setEditing(null)}
                      onSaved={() => {
                        setEditing(null);
                        setNotice(t.saved);
                        setRevision((r) => r + 1);
                      }}
                    />
                  ) : null}
                  <ProjectInvitations
                    key={project.projectId}
                    locale={locale}
                    projectId={project.projectId}
                    roles={project.assignableRoles}
                    onChanged={() => setRevision((x) => x + 1)}
                  />
                </>
              )}
            </>
          ) : !projectLoading ? (
            <p>{t.emptyProjects}</p>
          ) : null}
          {error ? (
            <p className={styles.feedback} role="alert">
              {error}
            </p>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
        </section>
      </div>
    </main>
  );
}
