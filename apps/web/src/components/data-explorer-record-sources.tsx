'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  RelationListOutputSchema,
  type RelationAssertion,
} from '@wiser/data-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import {
  invalidatesExploration,
  type InvalidateExploration,
} from '@/lib/exploration-request';
import { businessRecordFocus } from '@/lib/business-graph';
import { businessObjectSources } from '@/lib/business-object-sources';
import { relationNodeIdentity } from '@/lib/relation-graph';
import {
  withRecordFocus,
  type RecordFocus,
} from '@/lib/exploration-record-focus';
import { explorationHref } from '@/lib/exploration-navigation';
import styles from './data-explorer-business.module.css';
import shared from './data-reconciliation.module.css';

export function DataExplorerRecordSources({
  locale,
  queryId,
  status,
  versionId,
  onInvalidated,
}: {
  readonly locale: Locale;
  readonly queryId: string;
  readonly status: RelationAssertion['status'];
  readonly versionId: string | null;
  readonly onInvalidated: InvalidateExploration;
}) {
  const copy = getDictionary(locale).knowledgeRelations;
  const paging = getDictionary(locale).dataFoundation.explorer;
  const [rows, setRows] = useState<RelationAssertion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    setFailed(false);
    setSelected('');
    setSearch('');
    setPage(0);
    void (async () => {
      try {
        const items: RelationAssertion[] = [];
        const seen = new Set<string>();
        let after: string | undefined, total: number | undefined;
        do {
          const response = await fetch('/api/data-foundation/relations/list', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              queryId,
              status,
              first: 100,
              ...(after ? { after } : {}),
            }),
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!response.ok) {
            if (
              !controller.signal.aborted &&
              invalidatesExploration(response.status)
            )
              onInvalidated(queryId, response.status);
            throw Error('Unavailable');
          }
          const part = RelationListOutputSchema.parse(await response.json());
          if (total !== undefined && total !== part.totalCount)
            throw Error('Changed scope');
          total = part.totalCount;
          items.push(...part.items);
          after = part.nextCursor;
          if (items.length > 2000 || (after && seen.has(after)))
            throw Error('Incomplete scope');
          if (after) seen.add(after);
        } while (after);
        if (
          items.length !== total ||
          new Set(items.map((r) => r.assertionId)).size !== items.length
        )
          throw Error('Incomplete scope');
        if (!controller.signal.aborted) setRows(items);
      } catch {
        if (!controller.signal.aborted) {
          setRows(null);
          setFailed(true);
        }
      }
    })();
    return () => controller.abort();
  }, [queryId, status, onInvalidated]);
  const entries = useMemo(() => {
    const sources = businessObjectSources(rows ?? []);
    const unique = new Map<
      string,
      { focus: RecordFocus; label: string; source: string }
    >();
    for (const row of rows ?? [])
      for (const entity of [row.candidate.subject, row.candidate.object]) {
        const focus = businessRecordFocus(row, entity);
        if (!focus) continue;
        const caption = sources.get(relationNodeIdentity(row, entity));
        const key = JSON.stringify([
          focus.dataItemId,
          focus.versionId,
          focus.recordId,
        ]);
        if (!unique.has(key))
          unique.set(key, {
            focus,
            label: entity.label,
            source:
              caption?.title ||
              `${copy.businessObjectSource}${caption?.sourceNumber ?? ''}`,
          });
      }
    return [...unique.values()];
  }, [rows, copy]);
  const sources = [
    ...new Map(entries.map((e) => [e.focus.versionId, e.source])).entries(),
  ];
  const active =
    selected ||
    (sources.some(([id]) => id === versionId) ? versionId : sources[0]?.[0]) ||
    '';
  const matches = entries.filter(
    (e) =>
      e.focus.versionId === active &&
      `${e.label} ${e.source}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const graphHref = explorationHref(locale, queryId, 'graph');
  return (
    <section
      className={`${shared.frame} ${shared.body} ${styles.compact}`}
      aria-label={copy.recordDirectoryTitle}
    >
      <h3>{copy.recordDirectoryTitle}</h3>
      <p>{copy.recordDirectoryHint}</p>
      {failed ? (
        <p role="alert">{copy.recordDirectoryFailed}</p>
      ) : rows === null ? (
        <p role="status">{copy.recordDirectoryLoading}</p>
      ) : entries.length === 0 ? (
        <p>{copy.recordDirectoryEmpty}</p>
      ) : (
        <>
          <p>
            {entries.length}
            {copy.recordDirectoryCount}
          </p>
          <div className={styles.pathForm}>
            <label>
              {copy.recordDirectorySource}
              <select
                value={active}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setPage(0);
                }}
              >
                {sources.map(([id, title]) => (
                  <option key={id} value={id}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {copy.recordDirectorySearch}
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </label>
          </div>
          <ul className={styles.pathObjects}>
            {matches.slice(page * 25, (page + 1) * 25).map((entry) => (
              <li key={entry.focus.recordId}>
                <Link
                  href={withRecordFocus(
                    explorationHref(locale, queryId, 'records'),
                    entry.focus,
                  )}
                >
                  {entry.label}
                </Link>
              </li>
            ))}
          </ul>
          {matches.length === 0 ? <p>{copy.recordDirectoryNoMatch}</p> : null}
          {matches.length > 25 ? (
            <div className={styles.categories}>
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                {paging.previous}
              </button>
              <span>
                {page + 1} / {Math.ceil(matches.length / 25)}
              </span>
              <button
                disabled={(page + 1) * 25 >= matches.length}
                onClick={() => setPage(page + 1)}
              >
                {paging.next}
              </button>
            </div>
          ) : null}
        </>
      )}
      <Link href={graphHref}>{copy.recordDirectoryGraph}</Link>
    </section>
  );
}
