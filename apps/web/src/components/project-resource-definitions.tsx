'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ResourceDefinitionsPageSchema,
  ResourceDefinitionReceiptSchema,
  ResourcePackageCommandSchema,
  ResourcePresetCommandSchema,
  ResourceAccessActionSchema,
  type ProjectAccessProjectView,
  type ResourceDefinitionsPage,
} from '@wiser/platform-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import { ContextHelp } from './context-help';
import {
  ProjectResourceCoverage,
  type CoverageResourceSelection,
} from './project-resource-coverage';
import styles from './project-access-workspace.module.css';
type Definition = ResourceDefinitionsPage['items'][number];
type Props = {
  project: ProjectAccessProjectView;
  locale: Locale;
  kind: 'package' | 'preset';
};
type Text = ReturnType<typeof getDictionary>['resourceDefinitions'];
function message(code: string, t: Text) {
  return code === 'NOT_AUTHORIZED' || code === 'NOT_AUTHENTICATED'
    ? t.denied
    : code === 'RESOURCE_POLICY_NOT_ENABLED'
      ? t.disabled
      : code === 'VERSION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT'
        ? t.conflict
        : code === 'VALIDATION_FAILED'
          ? t.invalid
          : code === 'RESOURCE_UNAVAILABLE'
            ? t.resourceUnavailable
            : t.unavailable;
}
async function read(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        typeof value.code === 'string'
        ? value.code
        : 'ACCESS_UNAVAILABLE',
    );
  }
  return value;
}
function Editor({
  project,
  locale,
  kind,
  initial,
  close,
  saved,
}: Props & {
  initial: Definition | null;
  close: () => void;
  saved: () => void;
}) {
  const t = getDictionary(locale).resourceDefinitions;
  const [selected, setSelected] = useState<CoverageResourceSelection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useRef(initial?.id ?? crypto.randomUUID());
  const receipt = useRef<{ body: string; key: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const common = {
      projectId: project.projectId,
      expectedVersion: initial?.version ?? 0,
      name: form.get('name'),
      reason: form.get('reason'),
    };
    const command =
      kind === 'preset'
        ? ResourcePresetCommandSchema.safeParse({
            ...common,
            presetId: id.current,
            actions: form.getAll('actions'),
            maxDays: Number(form.get('days')),
            approvalLevel: form.get('approval'),
          })
        : ResourcePackageCommandSchema.safeParse({
            ...common,
            packageId: id.current,
            resources: selected.map((r) => ({
              kind: 'version',
              dataItemId: r.dataItemId,
              versionId: r.versionId,
            })),
            allowedActions: form.getAll('actions'),
            licenseBasis: form.get('license'),
          });
    if (!command.success) {
      setError(t.invalid);
      return;
    }
    const body = JSON.stringify(command.data);
    if (receipt.current?.body !== body)
      receipt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      ResourceDefinitionReceiptSchema.parse(
        await read(
          await fetch('/api/platform/access/resource-' + kind, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': receipt.current.key,
            },
            body,
          }),
        ),
      );
      if (alive.current) saved();
    } catch (error) {
      if (alive.current)
        setError(message(error instanceof Error ? error.message : '', t));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const actions =
    initial?.kind === 'preset' ? initial.actions : ['content.read'];
  return (
    <section
      className={styles.editor}
      aria-label={kind === 'preset' ? t.createPreset : t.createPackage}
    >
      <h3>
        {initial
          ? t.newVersion
          : kind === 'preset'
            ? t.createPreset
            : t.createPackage}
      </h3>
      {kind === 'package' ? (
        <>
          <ProjectResourceCoverage
            locale={locale}
            tenantId={project.tenantId}
            projectId={project.projectId}
            onChoose={(resource) => {
              if (busy) return;
              if (
                selected.some(
                  (r) =>
                    r.versionId === resource.versionId &&
                    r.dataItemId === resource.dataItemId,
                )
              )
                return;
              if (selected.length >= 1000) {
                setError(t.limit);
                return;
              }
              setSelected([...selected, resource]);
            }}
          />
          <h4>
            {t.selection} · {selected.length}
          </h4>
          <ContextHelp label={t.selection}>{t.selectionHelp}</ContextHelp>
          <ul>
            {selected.map((r) => (
              <li key={r.dataItemId + ':' + r.versionId}>
                {r.name}{' '}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setSelected(selected.filter((v) => v !== r))}
                >
                  {t.remove}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          {t.name}
          <input
            name="name"
            required
            maxLength={160}
            defaultValue={initial?.name ?? ''}
            disabled={busy}
          />
        </label>
        <fieldset disabled={busy}>
          <legend>{t.actions}</legend>
          {ResourceAccessActionSchema.options
            .filter(
              (action) => kind === 'preset' || action !== 'external.directory',
            )
            .map((action) => (
              <label key={action}>
                <input
                  type="checkbox"
                  name="actions"
                  value={action}
                  defaultChecked={actions.includes(action)}
                />
                {t[action]}
              </label>
            ))}
        </fieldset>
        {kind === 'preset' ? (
          <>
            <label>
              {t.days}
              <input
                type="number"
                name="days"
                min={1}
                max={366}
                defaultValue={initial?.kind === 'preset' ? initial.maxDays : 30}
                disabled={busy}
                required
              />
            </label>
            <label>
              {t.approval}
              <select
                name="approval"
                defaultValue={
                  initial?.kind === 'preset'
                    ? initial.approvalLevel
                    : 'ordinary'
                }
                disabled={busy}
              >
                <option value="ordinary">{t.ordinary}</option>
                <option value="important">{t.important}</option>
              </select>
            </label>
          </>
        ) : (
          <label>
            {t.license}
            <textarea
              name="license"
              required
              minLength={5}
              maxLength={1000}
              disabled={busy}
            />
          </label>
        )}
        <label>
          {t.reason}
          <textarea
            name="reason"
            required
            minLength={5}
            maxLength={1000}
            disabled={busy}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <button type="submit" disabled={busy}>
            {kind === 'preset' ? t.savePreset : t.savePackage}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            {t.cancel}
          </button>
        </div>
      </form>
    </section>
  );
}
export function ProjectResourceDefinitions(props: Props) {
  if (!props.project.canManage || !props.project.resourceAccessEnabled)
    return null;
  return (
    <Definitions key={props.project.projectId + ':' + props.kind} {...props} />
  );
}
function Definitions({ project, locale, kind }: Props) {
  const t = getDictionary(locale).resourceDefinitions;
  const [page, setPage] = useState(0),
    [search, setSearch] = useState(''),
    [revision, setRevision] = useState(0);
  const [result, setResult] = useState<ResourceDefinitionsPage | null>(null);
  const [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Definition | null | undefined>(
    undefined,
  );
  const [notice, setNotice] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    setLoading(true);
    const query = new URLSearchParams({
      projectId: project.projectId,
      kind,
      offset: String(page * 20),
      limit: '20',
      search,
    });
    void fetch(
      '/api/platform/access/resource-definitions?' + query.toString(),
      {
        cache: 'no-store',
        signal: controller.signal,
      },
    )
      .then(read)
      .then((value) => {
        if (!controller.signal.aborted)
          setResult(ResourceDefinitionsPageSchema.parse(value));
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setResult(null);
          setEditing(undefined);
          setError(message(error instanceof Error ? error.message : '', t));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [project.projectId, kind, page, search, revision, t]);
  return (
    <section aria-label={kind === 'preset' ? t.presets : t.packages}>
      <div className={styles.actions}>
        <ContextHelp label={t.help}>{t.helpText}</ContextHelp>
        <button
          disabled={loading || error !== null}
          onClick={() => {
            setEditing(null);
            setNotice(false);
          }}
        >
          {kind === 'preset' ? t.createPreset : t.createPackage}
        </button>
        <button disabled={loading} onClick={() => setRevision((v) => v + 1)}>
          {t.refresh}
        </button>
      </div>
      {notice ? <p role="status">{t.saved}</p> : null}
      {editing !== undefined ? (
        <Editor
          key={editing?.id ?? 'new'}
          project={project}
          locale={locale}
          kind={kind}
          initial={editing}
          close={() => setEditing(undefined)}
          saved={() => {
            setEditing(undefined);
            setNotice(true);
            setRevision((v) => v + 1);
          }}
        />
      ) : null}
      <form
        className={styles.search}
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          const value = new FormData(event.currentTarget).get('search');
          setSearch(typeof value === 'string' ? value : '');
        }}
      >
        <label>
          {t.search}
          <input name="search" maxLength={160} />
        </label>
        <button type="submit">{t.query}</button>
      </form>
      {loading ? <p>{t.loading}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <>
          {result.items.length ? (
            <div className={styles.table}>
              <table>
                <thead>
                  <tr>
                    <th>{t.name}</th>
                    <th>{t.version}</th>
                    <th>{t.actions}</th>
                    <th>{kind === 'preset' ? t.days : t.resourceCount}</th>
                    <th>{t.approval}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td>{item.version}</td>
                      <td>
                        {(item.kind === 'preset'
                          ? item.actions
                          : item.allowedActions
                        ).map((action) => (
                          <span key={action} className={styles.badge}>
                            {t[action]}
                          </span>
                        ))}
                      </td>
                      <td>
                        {item.kind === 'preset'
                          ? item.maxDays
                          : item.resourceCount}
                      </td>
                      <td>
                        {item.kind === 'preset' ? (
                          <>
                            <span className={styles.badge}>
                              {t[item.approvalLevel]}
                            </span>{' '}
                            <button
                              onClick={() => {
                                setEditing(item);
                                setNotice(false);
                              }}
                            >
                              {t.newVersion}
                            </button>
                          </>
                        ) : (
                          item.licenseBasis
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>{t.empty}</p>
          )}
          <div className={styles.actions}>
            <button
              disabled={page === 0 || loading}
              onClick={() => setPage((v) => v - 1)}
            >
              {t.previous}
            </button>
            <button
              disabled={!result.hasMore || loading}
              onClick={() => setPage((v) => v + 1)}
            >
              {t.next}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
