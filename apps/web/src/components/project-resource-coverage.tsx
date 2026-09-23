'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ExplorationResultSchema,
  type ExplorationResult,
  type ExplorationReadiness,
  type QuerySpec,
} from '@wiser/data-contracts';
import { catalogHref } from '@/lib/catalog-route';
import { getDictionary, type Locale } from '@/lib/i18n';
import { ContextHelp } from './context-help';
import styles from './project-resource-coverage.module.css';

export type CoverageResourceSelection = {
  dataItemId: string;
  versionId: string;
  name: string;
};
type Props = {
  locale: Locale;
  tenantId: string;
  projectId: string;
  onChoose?: (resource: CoverageResourceSelection) => void;
};
type ResourceKind = NonNullable<QuerySpec['kinds']>[number];
type Filters = {
  text?: string;
  kind?: ResourceKind;
  records?: ExplorationReadiness;
  spatial?: ExplorationReadiness;
};
type Cursor = { queryId?: string; after?: string };
export function ProjectResourceCoverage(props: Props) {
  return <Coverage key={`${props.tenantId}:${props.projectId}`} {...props} />;
}
function Coverage({ locale, tenantId, projectId, onChoose }: Props) {
  const dictionary = getDictionary(locale);
  const t = dictionary.resourceCoverage;
  const states = dictionary.dataFoundation.explorer.readiness;
  const kinds = dictionary.dataFoundation.explorer.kinds;
  const [filters, setFilters] = useState<Filters>({});
  const [cursor, setCursor] = useState<Cursor>({});
  const [previous, setPrevious] = useState<Cursor[]>([]);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<ExplorationResult | null>(null);
  const [error, setError] = useState<
    'denied' | 'expired' | 'unavailable' | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const request = new URLSearchParams({ tenantId, projectId });
  for (const [key, value] of Object.entries(cursor.queryId ? cursor : filters))
    if (value) request.set(key, value);
  const address = '/api/platform/resources?' + request.toString();
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setSelected(null);
    setError(null);
    setLoading(true);
    void fetch(address, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 401 || response.status === 403
              ? 'denied'
              : response.status === 409 || response.status === 410
                ? 'expired'
                : 'unavailable',
          );
        const value = ExplorationResultSchema.parse(await response.json());
        if (Date.parse(value.expiresAt) <= Date.now())
          throw new Error('expired');
        if (!controller.signal.aborted) setResult(value);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setResult(null);
        setError(
          reason instanceof Error &&
            (reason.message === 'denied' || reason.message === 'expired')
            ? reason.message
            : 'unavailable',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [address, revision]);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => {
        setResult(null);
        setSelected(null);
        setError('expired');
      },
      Math.max(
        0,
        Math.min(2147483647, Date.parse(result.expiresAt) - Date.now()),
      ),
    );
    return () => clearTimeout(timer);
  }, [result]);
  function query(next: Filters) {
    setResult(null);
    setSelected(null);
    setFilters(next);
    setCursor({});
    setPrevious([]);
    setRevision((n) => n + 1);
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('text');
    const text = typeof value === 'string' ? value.trim() : '';
    query({ ...filters, ...(text ? { text } : { text: undefined }) });
  }
  const number = (value: number | undefined | null) =>
    value == null ? t.unknown : value.toLocaleString(locale);
  const details = result?.resources.find((r) => r.versionId === selected);
  return (
    <section className={styles.coverage} aria-label={t.title}>
      <div className={styles.heading}>
        <span>{t.scope}</span>
        <ContextHelp label={t.help}>{t.helpText}</ContextHelp>
      </div>
      <form className={styles.filters} onSubmit={search}>
        <label>
          {t.search}
          <input
            key={filters.text ?? ''}
            name="text"
            defaultValue={filters.text ?? ''}
            maxLength={512}
          />
        </label>
        <label>
          {dictionary.dataFoundation.explorer.kindLabel}
          <select
            value={filters.kind ?? ''}
            onChange={(event) =>
              query({
                ...filters,
                kind: event.target.value
                  ? (event.target.value as ResourceKind)
                  : undefined,
              })
            }
          >
            <option value="">
              {dictionary.dataFoundation.explorer.allKinds}
            </option>
            {Object.entries(kinds).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">{t.searchButton}</button>
        <button type="button" onClick={() => query(filters)}>
          {t.refresh}
        </button>
      </form>
      {Object.values(filters).some(Boolean) ? (
        <div className={styles.active}>
          <span>
            {t.filtered}:{' '}
            {[
              filters.text,
              filters.kind && kinds[filters.kind],
              filters.records && states[filters.records],
              filters.spatial && states[filters.spatial],
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <button onClick={() => query({})}>{t.clear}</button>
        </div>
      ) : null}
      {loading ? <p role="status">{t.loading}</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {t[error]}
        </p>
      ) : null}
      {result ? (
        <>
          <dl className={styles.metrics}>
            <div>
              <dt>{t.total}</dt>
              <dd data-testid="coverage-resource-total">
                {number(result.totalCount)}
              </dd>
            </div>
            <div>
              <dt>{t.analyzed}</dt>
              <dd>{number(result.summary?.analyzedResourceCount)}</dd>
            </div>
            <div>
              <dt>{t.records}</dt>
              <dd>{number(result.summary?.indexedRecordCount)}</dd>
            </div>
            <div>
              <dt>{t.features}</dt>
              <dd>{number(result.summary?.indexedFeatureCount)}</dd>
            </div>
          </dl>
          {result.summary ? (
            <div className={styles.distributions}>
              {(['records', 'spatial'] as const).map((kind) => (
                <section key={kind}>
                  <h3>
                    {kind === 'records' ? t.recordStatus : t.spatialStatus}
                  </h3>
                  <div className={styles.statuses}>
                    {result.summary?.[kind].map((entry) => (
                      <button
                        key={entry.status}
                        data-state={entry.status}
                        aria-label={t.drill
                          .replace(
                            '{kind}',
                            kind === 'records'
                              ? t.recordStatus
                              : t.spatialStatus,
                          )
                          .replace('{status}', states[entry.status])
                          .replace('{count}', number(entry.count))}
                        onClick={() =>
                          query({ ...filters, [kind]: entry.status })
                        }
                      >
                        <span>{states[entry.status]}</span>
                        <strong>{number(entry.count)}</strong>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
          <div className={styles.freshness}>
            <span>
              {t.updated}: {new Date(result.createdAt).toLocaleString(locale)}
            </span>
            <span>
              {t.page}: {previous.length + 1}
            </span>
          </div>
          {result.resources.length ? (
            <div className={styles.table}>
              <table>
                <thead>
                  <tr>
                    <th>{t.source}</th>
                    <th>{t.provider}</th>
                    <th>{dictionary.dataFoundation.explorer.kindLabel}</th>
                    <th>{t.content}</th>
                    <th>{t.spatial}</th>
                    <th>{t.graph}</th>
                    {onChoose ? (
                      <th>{dictionary.resourceDefinitions.selection}</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {result.resources.map((r) => (
                    <tr key={`${r.dataItemId}:${r.versionId}`}>
                      <td>
                        <button
                          aria-expanded={selected === r.versionId}
                          onClick={() =>
                            setSelected(
                              selected === r.versionId ? null : r.versionId,
                            )
                          }
                        >
                          {r.name}
                        </button>
                      </td>
                      <td>{r.provider || t.unknownProvider}</td>
                      <td>{kinds[r.kind as ResourceKind] ?? t.unknownKind}</td>
                      {(['records', 'spatial', 'graph'] as const).map(
                        (kind) => (
                          <td key={kind}>
                            <span
                              className={styles.badge}
                              data-state={r.readiness[kind]}
                            >
                              {states[r.readiness[kind]]}
                            </span>
                          </td>
                        ),
                      )}
                      {onChoose ? (
                        <td>
                          <button
                            type="button"
                            onClick={() =>
                              onChoose({
                                dataItemId: r.dataItemId,
                                versionId: r.versionId,
                                name: r.name,
                              })
                            }
                          >
                            {dictionary.resourceDefinitions.pick}
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>{t.empty}</p>
          )}
          {details ? (
            <section className={styles.details} aria-label={t.details}>
              <div className={styles.heading}>
                <h3>{details.name}</h3>
                <button onClick={() => setSelected(null)}>{t.close}</button>
              </div>
              <dl>
                <div>
                  <dt>{t.provider}</dt>
                  <dd>{details.provider || t.unknownProvider}</dd>
                </div>
                <div>
                  <dt>{dictionary.dataFoundation.explorer.kindLabel}</dt>
                  <dd>
                    {kinds[details.kind as ResourceKind] ?? t.unknownKind}
                  </dd>
                </div>
                <div>
                  <dt>{t.processingStatus}</dt>
                  <dd>
                    {details.analysis
                      ? t.processingStates[details.analysis.status]
                      : t.processingUnknown}
                  </dd>
                </div>
                <div>
                  <dt>{t.version}</dt>
                  <dd>{details.versionId}</dd>
                </div>
                <div>
                  <dt>{t.assets}</dt>
                  <dd>{number(details.assetCount)}</dd>
                </div>
                <div>
                  <dt>{t.records}</dt>
                  <dd>{number(details.recordCount)}</dd>
                </div>
                <div>
                  <dt>{t.features}</dt>
                  <dd>{number(details.featureCount)}</dd>
                </div>
              </dl>
              <Link
                href={catalogHref(
                  locale,
                  details.dataItemId,
                  details.versionId,
                )}
                prefetch={false}
              >
                {t.openVersion}
              </Link>
              {details.limitations.length ? (
                <>
                  <h4>{t.limitations}</h4>
                  <ul>
                    {details.limitations.map((limitation, index) => (
                      <li key={index}>{limitation}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}
          <div className={styles.pagination}>
            <button
              disabled={previous.length === 0 || loading}
              onClick={() => {
                setCursor(previous[previous.length - 1]);
                setPrevious(previous.slice(0, -1));
              }}
            >
              {t.previous}
            </button>
            <button
              disabled={!result.nextCursor || loading}
              onClick={() => {
                setPrevious([
                  ...previous,
                  {
                    queryId: result.queryId,
                    ...(cursor.after ? { after: cursor.after } : {}),
                  },
                ]);
                setCursor({
                  queryId: result.queryId,
                  ...(result.nextCursor ? { after: result.nextCursor } : {}),
                });
              }}
            >
              {t.next}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
