'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  RelationListOutputSchema,
  type RelationAssertion,
  type BusinessQuery,
} from '@wiser/data-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import { businessGraphRows, businessRecordFocus } from '@/lib/business-graph';
import { relationNodeIdentity } from '@/lib/relation-graph';
import { withRecordFocus } from '@/lib/exploration-record-focus';
import { explorationHref } from '@/lib/exploration-navigation';
import {
  invalidatesExploration,
  type InvalidateExploration,
} from '@/lib/exploration-request';
import { KnowledgeGraphCanvas } from './data-foundation-graph';
import { useExplorationViewState } from './exploration-view-context';
import styles from './data-reconciliation.module.css';
import businessStyles from './data-explorer-business.module.css';

export function DataExplorerBusiness({
  queryId,
  scope,
  locale,
  onInvalidated,
  onApply,
}: {
  readonly queryId: string;
  readonly scope: BusinessQuery;
  readonly locale: Locale;
  readonly onInvalidated: InvalidateExploration;
  readonly onApply: (scope: BusinessQuery) => void;
}) {
  const copy = getDictionary(locale).knowledgeRelations;
  const search = useSearchParams(),
    router = useRouter(),
    pathname = usePathname();
  type Kind = RelationAssertion['candidate']['subject']['kind'];
  const readKind = search.get('businessKind');
  const kind: Kind | null =
    readKind && Object.hasOwn(copy.kinds, readKind) ? (readKind as Kind) : null;
  const [rows, setRows] = useState<RelationAssertion[]>([]),
    [busy, setBusy] = useState(true),
    [failed, setFailed] = useState(false),
    [loaded, setLoaded] = useState(0);
  const [mode, setMode] = useState<'overview' | 'all'>('overview'),
    [listPage, setListPage] = useState(0);
  const selected = search.get('businessEntity');
  const [draft, setDraft] = useState(scope.filters);
  const viewState = useExplorationViewState();
  useEffect(() => {
    const controller = new AbortController();
    viewState?.report('graph', null);
    void (async () => {
      try {
        let after: string | undefined, total: number | undefined;
        const items: RelationAssertion[] = [];
        const cursors = new Set<string>();
        do {
          const response = await fetch('/api/data-foundation/relations/list', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              queryId,
              status: scope.status,
              first: 100,
              ...(after ? { after } : {}),
            }),
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!response.ok) {
            if (invalidatesExploration(response.status))
              onInvalidated(queryId, response.status);
            throw Error('Unavailable');
          }
          const page = RelationListOutputSchema.parse(await response.json());
          if (total !== undefined && total !== page.totalCount)
            throw Error('Changed scope');
          total = page.totalCount;
          items.push(...page.items);
          after = page.nextCursor;
          if (after && cursors.has(after)) throw Error('Repeated cursor');
          if (after) cursors.add(after);
          if (items.length > 2000) throw Error('Scope too large');
          if (!controller.signal.aborted) setLoaded(items.length);
        } while (after);
        if (
          items.length !== total ||
          new Set(items.map((r) => r.assertionId)).size !== items.length
        )
          throw Error('Incomplete scope');
        if (!controller.signal.aborted) {
          setRows(items);
          viewState?.report('graph', { queryId, view: 'graph', first: 25 });
        }
      } catch {
        if (!controller.signal.aborted) {
          setRows([]);
          setFailed(true);
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [queryId, scope.status, onInvalidated, viewState]);
  const visible = useMemo(
    () => businessGraphRows(rows, mode, selected, kind),
    [rows, mode, selected, kind],
  );
  const graph = useMemo(() => {
    const degree = new Map<string, number>();
    for (const r of visible)
      for (const e of [r.candidate.subject, r.candidate.object]) {
        const id = relationNodeIdentity(r, e);
        degree.set(id, (degree.get(id) ?? 0) + 1);
      }
    const representatives = new Map<string, string>();
    for (const r of visible)
      for (const e of [r.candidate.subject, r.candidate.object]) {
        const id = relationNodeIdentity(r, e),
          prior = representatives.get(e.kind);
        if (!prior || (degree.get(id) ?? 0) > (degree.get(prior) ?? 0))
          representatives.set(e.kind, id);
      }
    const anchors = new Set(representatives.values());
    return {
      nodes: [
        ...new Map(
          visible.flatMap((r) =>
            [r.candidate.subject, r.candidate.object].map((e) => {
              const id = relationNodeIdentity(r, e);
              return [
                id,
                {
                  entityId: id,
                  label: copy.kinds[e.kind] + ' · ' + e.label,
                  kind: e.kind,
                  overviewLabel: anchors.has(id),
                },
              ] as const;
            }),
          ),
        ).values(),
      ],
      edges: visible.map((r) => ({
        edgeId: r.assertionId,
        fromEntityId: relationNodeIdentity(r, r.candidate.subject),
        toEntityId: relationNodeIdentity(r, r.candidate.object),
        label: copy.predicates[r.candidate.predicate],
      })),
    };
  }, [visible, copy]);
  const kinds = useMemo(
    () =>
      [
        ...new Set(
          rows.flatMap((r) => [
            r.candidate.subject.kind,
            r.candidate.object.kind,
          ]),
        ),
      ].sort(),
    [rows],
  );
  const select = (id: string | null, nextKind: Kind | null = kind) => {
    setListPage(0);
    const params = new URLSearchParams(search.toString());
    if (id) params.set('businessEntity', id);
    else params.delete('businessEntity');
    if (nextKind) params.set('businessKind', nextKind);
    else params.delete('businessKind');
    router.replace(pathname + '?' + params.toString(), { scroll: false });
  };
  return (
    <section
      className={`${styles.frame} ${styles.body} ${businessStyles.compact}`}
      aria-label={copy.businessTitle}
    >
      <h2>{copy.businessTitle}</h2>
      <p>{copy.businessHint}</p>
      <p>
        {copy.statuses[scope.status]} · {copy.pageCount}
        {loaded}
        {busy ? ' · ' + copy.businessLoading : ''}
      </p>
      {scope.status === 'PENDING_REVIEW' ? (
        <p>{copy.recordRelationPending}</p>
      ) : null}
      <details>
        <summary>
          {copy.businessScope} · {scope.filters.from ?? copy.filterAll} —{' '}
          {scope.filters.to ?? copy.filterAll}
        </summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onApply({ ...scope, filters: draft });
          }}
        >
          <fieldset className={businessStyles.timeFilters}>
            <legend>{copy.businessScope}</legend>
            <label>
              {copy.filterTimeRole}
              <select
                value={draft.timeRole}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    timeRole: e.target.value as typeof draft.timeRole,
                  })
                }
              >
                <option value="ALL">{copy.filterAll}</option>
                {Object.entries(copy.timeRoles).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {copy.filterFrom}
              <input
                type="date"
                value={draft.from ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, from: e.target.value || null })
                }
              />
            </label>
            <label>
              {copy.filterTo}
              <input
                type="date"
                value={draft.to ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, to: e.target.value || null })
                }
              />
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={draft.includeUndated}
                onChange={(e) =>
                  setDraft({ ...draft, includeUndated: e.target.checked })
                }
              />
              {copy.filterUndated}
            </label>
            <button
              type="submit"
              disabled={
                busy || Boolean(draft.from && draft.to && draft.from > draft.to)
              }
            >
              {copy.businessApply}
            </button>
          </fieldset>
        </form>
      </details>
      {failed ? <p role="alert">{copy.recordRelationFailed}</p> : null}
      {!busy && !failed ? (
        <>
          <div className={styles.actions}>
            <button
              onClick={() => {
                setMode('overview');
                select(null, null);
              }}
              aria-pressed={mode === 'overview' && !selected && !kind}
            >
              {copy.businessOverview}
            </button>
            <button
              onClick={() => {
                setMode('all');
                select(null, null);
              }}
              aria-pressed={mode === 'all' && !selected && !kind}
            >
              {copy.businessAll}
            </button>
            {selected ? (
              <button onClick={() => select(null)}>
                {copy.businessClearFocus}
              </button>
            ) : null}
          </div>
          <div
            className={businessStyles.categories}
            aria-label={copy.businessCategories}
          >
            {kinds.map((k) => (
              <button
                key={k}
                aria-pressed={kind === k && !selected}
                onClick={() => select(null, k)}
              >
                {copy.kinds[k]}
              </button>
            ))}
          </div>
          {kind ? <p>{copy.businessCategoryHint}</p> : null}
          <p>
            {copy.businessVisible}
            {visible.length} / {rows.length} · {copy.businessOverviewHint}
          </p>
          {visible.length ? (
            <KnowledgeGraphCanvas
              result={graph}
              locale={locale}
              selectedId={selected}
              onSelect={select}
            />
          ) : (
            <p>{copy.filteredEmpty}</p>
          )}
          <details>
            <summary>
              {copy.businessObjects} ({graph.nodes.length})
            </summary>
            <ul>
              {graph.nodes.map((n) => (
                <li key={n.entityId}>
                  <button onClick={() => select(n.entityId)}>{n.label}</button>
                </li>
              ))}
            </ul>
          </details>
          <h3>{copy.businessEvidence}</h3>
          {visible.slice(listPage * 20, listPage * 20 + 20).map((row) => (
            <article className={businessStyles.evidence} key={row.assertionId}>
              <h4>
                {row.candidate.subject.label} →{' '}
                {copy.predicates[row.candidate.predicate]} →{' '}
                {row.candidate.object.label}
              </h4>
              <p>
                {row.candidate.qualifiers.context
                  ? copy.natures[row.candidate.qualifiers.context.recordNature]
                  : ''}{' '}
                ·{' '}
                {row.candidate.qualifiers.context?.validFrom ??
                  row.candidate.qualifiers.observedAt ??
                  copy.timeRoles.UNKNOWN}{' '}
                — {row.candidate.qualifiers.context?.validTo ?? ''}
              </p>
              {row.candidate.qualifiers.context ? (
                <p>{row.candidate.qualifiers.context.applicability}</p>
              ) : null}
              {[...new Set(row.candidate.qualifiers.limitations)]
                .filter(
                  (v) => v !== row.candidate.qualifiers.context?.applicability,
                )
                .map((v) => (
                  <p key={v}>{v}</p>
                ))}
              <Link
                href={`/${locale}/data-foundation/catalog/${row.dataItemId}?versionId=${row.versionId}`}
              >
                {copy.source}
              </Link>
              {[row.candidate.subject, row.candidate.object].map(
                (entity, i) => {
                  const focus = businessRecordFocus(row, entity);
                  return focus ? (
                    <p key={i}>
                      <Link
                        href={withRecordFocus(
                          explorationHref(locale, queryId, 'records'),
                          focus,
                        )}
                      >
                        {copy.boundRecord}
                      </Link>
                      {' · '}
                      <Link
                        href={withRecordFocus(
                          explorationHref(locale, queryId, 'map'),
                          focus,
                        )}
                      >
                        {copy.boundRecordMap}
                      </Link>
                    </p>
                  ) : null;
                },
              )}
              <details>
                <summary>
                  {copy.businessOriginalEvidence} (
                  {row.candidate.evidence.length})
                </summary>
                <ul>
                  {row.candidate.evidence.map((e, i) => (
                    <li key={i}>
                      <Link
                        href={`/api/data-foundation/assets/${row.versionId}/${e.assetId}`}
                      >
                        {e.locator}
                      </Link>
                      {e.excerpt ? <blockquote>{e.excerpt}</blockquote> : null}
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
          <div className={styles.actions}>
            <button
              disabled={!listPage}
              onClick={() => setListPage((v) => v - 1)}
            >
              {getDictionary(locale).dataFoundation.explorer.previous}
            </button>
            <span>
              {listPage + 1} / {Math.max(1, Math.ceil(visible.length / 20))}
            </span>
            <button
              disabled={(listPage + 1) * 20 >= visible.length}
              onClick={() => setListPage((v) => v + 1)}
            >
              {getDictionary(locale).dataFoundation.explorer.next}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
