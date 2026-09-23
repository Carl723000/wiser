'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ExternalSourceManagementPageSchema,
  ResourcePolicyProposalSchema,
  ResourcePolicyRequestViewSchema,
  type ExternalSourceManagementPage,
} from '@wiser/platform-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import { ContextHelp } from './context-help';
import styles from './project-access-workspace.module.css';

type Item = ExternalSourceManagementPage['items'][number];
type Props = {
  projectId: string;
  locale: Locale;
  onSaved?: () => void;
};

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

export function ProjectExternalSources(props: Props) {
  return <ExternalSources key={props.projectId} {...props} />;
}

function ExternalSources({ projectId, locale, onSaved }: Props) {
  const t = getDictionary(locale).externalSources;
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: ExternalSourceManagementPage | null;
    error: string;
  }>({ key: '', data: null, error: '' });
  const [chosen, setChosen] = useState<{ item: Item; policyId: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const key = `${projectId}:${page}:${revision}`;
  const data = state.key === key ? state.data : null;
  useEffect(() => {
    const controller = new AbortController();
    if (document.visibilityState !== 'hidden')
      void fetch(
        '/api/platform/access/external-sources?' +
          new URLSearchParams({
            projectId,
            offset: String(page * 20),
            limit: '20',
          }).toString(),
        { cache: 'no-store', signal: controller.signal },
      )
        .then(json)
        .then((value) => ExternalSourceManagementPageSchema.parse(value))
        .then((value) => {
          if (!controller.signal.aborted)
            setState({ key, data: value, error: '' });
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted) {
            setChosen(null);
            setState({
              key,
              data: null,
              error:
                caught instanceof Error ? caught.message : 'ACCESS_UNAVAILABLE',
            });
          }
        });
    return () => controller.abort();
  }, [key, page, projectId]);
  useEffect(() => {
    const invalidate = () => {
      setChosen(null);
      setState({ key: '', data: null, error: '' });
      setRevision((value) => value + 1);
    };
    window.addEventListener('focus', invalidate);
    document.addEventListener('visibilitychange', invalidate);
    return () => {
      window.removeEventListener('focus', invalidate);
      document.removeEventListener('visibilitychange', invalidate);
      mutation.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!data) return;
    const next = Math.min(
      ...data.items
        .map((item) => (item.expiresAt ? Date.parse(item.expiresAt) : Infinity))
        .filter((time) => time > Date.now()),
    );
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(
      () => {
        setChosen(null);
        setRevision((value) => value + 1);
      },
      Math.min(30_000, next - Date.now() + 1),
    );
    return () => window.clearTimeout(timer);
  }, [data]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen || !data?.canPropose || busy) return;
    const selected = data.items.find(
      (item) => item.sourceId === chosen.item.sourceId,
    );
    if (
      !selected?.eligibleForProposal ||
      selected.providerPermissionStatus !== 'VERIFIED' ||
      !selected.licenseBasis ||
      !selected.expiresAt ||
      Date.parse(selected.expiresAt) <= Date.now()
    ) {
      setChosen(null);
      setError(t.changed);
      return;
    }
    const form = new FormData(event.currentTarget);
    const actions = form.getAll('actions');
    if (
      !actions.length ||
      actions.some(
        (action) =>
          !selected.allowedActions.includes(action as 'source.discover'),
      )
    ) {
      setError(t.invalid);
      return;
    }
    const startValue = form.get('startsAt');
    const endValue = form.get('expiresAt');
    const start = new Date(typeof startValue === 'string' ? startValue : '');
    const end = new Date(typeof endValue === 'string' ? endValue : '');
    const command = ResourcePolicyProposalSchema.safeParse({
      projectId,
      policyId: chosen.policyId,
      expectedPolicyVersion: selected.expectedPolicyVersion,
      resource: { kind: 'external-source', sourceId: selected.sourceId },
      allowedActions: actions,
      managementRoles: form.getAll('roles'),
      licenseBasis: selected.licenseBasis,
      startsAt: Number.isFinite(start.valueOf()) ? start.toISOString() : '',
      expiresAt: Number.isFinite(end.valueOf()) ? end.toISOString() : '',
      maxGrantDays: Number(form.get('maxGrantDays')),
      reason: form.get('reason'),
    });
    if (!command.success) {
      setError(t.invalid);
      return;
    }
    const body = JSON.stringify(command.data);
    if (retry.current?.body !== body)
      retry.current = { body, key: crypto.randomUUID() };
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      ResourcePolicyRequestViewSchema.parse(
        await json(
          await fetch('/api/platform/access/source-policy-propose', {
            method: 'POST',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              'idempotency-key': retry.current.key,
            },
            body,
          }),
        ),
      );
      if (!controller.signal.aborted) {
        setChosen(null);
        setSaved(true);
        setRevision((value) => value + 1);
        onSaved?.();
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        const code = caught instanceof Error ? caught.message : '';
        setError(
          code === 'NOT_AUTHORIZED'
            ? t.denied
            : code === 'RESOURCE_UNAVAILABLE' || code === 'VERSION_CONFLICT'
              ? t.changed
              : t.unavailable,
        );
        if (
          code === 'NOT_AUTHORIZED' ||
          code === 'RESOURCE_UNAVAILABLE' ||
          code === 'VERSION_CONFLICT'
        ) {
          setChosen(null);
          setRevision((value) => value + 1);
        }
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label={t.title}>
      <div className={styles.actions}>
        <h3>{t.title}</h3>
        <ContextHelp label={t.help}>{t.scope}</ContextHelp>
      </div>
      {saved ? <p role="status">{t.saved}</p> : null}
      {state.key === key && state.error ? (
        <p role="alert">
          {state.error === 'NOT_AUTHORIZED' ? t.denied : t.unavailable}
        </p>
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
          <ul className={styles.sourceCatalogList}>
            {data.items.map((item) => (
              <li key={item.sourceId}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.provider}</span>
                  <dl className={styles.facts}>
                    <div>
                      <dt>{t.providerPermission}</dt>
                      <dd>
                        {t.providerStatuses[item.providerPermissionStatus]}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.wiserPermission}</dt>
                      <dd>{t.wiserStatuses[item.wiserPolicyStatus]}</dd>
                    </div>
                    <div>
                      <dt>{t.connection}</dt>
                      <dd>{t.unknownConnection}</dd>
                    </div>
                    <div>
                      <dt>{t.fields}</dt>
                      <dd>
                        {item.allowedFields.length
                          ? item.allowedFields
                              .map((field) => t.fieldNames[field])
                              .join(' · ')
                          : t.unknown}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.years}</dt>
                      <dd>
                        {item.fromYear !== null && item.toYear !== null
                          ? `${item.fromYear}—${item.toYear}`
                          : t.unknown}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.expiry}</dt>
                      <dd>
                        {item.expiresAt ? (
                          <time dateTime={item.expiresAt}>
                            {new Date(item.expiresAt).toLocaleString(locale)}
                          </time>
                        ) : (
                          t.unknown
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
                {data.canPropose &&
                item.eligibleForProposal &&
                item.expiresAt &&
                Date.parse(item.expiresAt) > Date.now() ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setChosen({
                        item,
                        policyId: item.policyId ?? crypto.randomUUID(),
                      });
                      setError('');
                      retry.current = null;
                    }}
                  >
                    {t.choose}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={page === 0 || busy}
              onClick={() => {
                setPage((value) => value - 1);
                setChosen(null);
              }}
            >
              {t.previous}
            </button>
            <button
              type="button"
              disabled={!data.hasMore || page >= 500 || busy}
              onClick={() => {
                setPage((value) => value + 1);
                setChosen(null);
              }}
            >
              {t.next}
            </button>
          </div>
        </>
      ) : null}
      {chosen && data ? (
        <section className={styles.editor} aria-label={t.proposal}>
          <h4>{t.proposal}</h4>
          <p>
            {chosen.item.name} · {chosen.item.provider}
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <fieldset className={styles.sourceChoiceGrid}>
              <legend>{t.actions}</legend>
              {chosen.item.allowedActions.map((action) => (
                <label key={action}>
                  <input type="checkbox" name="actions" value={action} />
                  {t.actionNames[action]}
                </label>
              ))}
            </fieldset>
            <fieldset className={styles.sourceChoiceGrid}>
              <legend>{t.roles}</legend>
              {data.managementRoleOptions.map((role) => (
                <label key={role}>
                  <input type="checkbox" name="roles" value={role} />
                  {role}
                </label>
              ))}
              {!data.managementRoleOptions.length ? <p>{t.noRoles}</p> : null}
            </fieldset>
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
              {t.reason}
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
                disabled={busy || !data.managementRoleOptions.length}
              >
                {busy ? t.saving : t.submit}
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
  );
}
