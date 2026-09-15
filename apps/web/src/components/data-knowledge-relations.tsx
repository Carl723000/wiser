'use client';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  MAX_RELATION_RELATED_SOURCES,
  ImportRelationsInputSchema,
  ImportRelationsOutputSchema,
  RelationListOutputSchema,
  RelationOutputSchema,
  type RelationAssertion,
} from '@wiser/data-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import {
  relationRecordFocus,
  withRecordFocus,
} from '@/lib/exploration-record-focus';
import {
  parseRelationSourceLinks,
  parseRelationNodeIdentity,
  relationNodeIdentity,
} from '@/lib/relation-graph';
import {
  readRelationView,
  relationViewHref,
  relationSourceLinks,
  relationSourceExploreHref,
  type RelationViewState,
} from '@/lib/relation-navigation';
import {
  DEFAULT_RELATION_FILTERS,
  filterRelationRows,
  parseRelationFilters,
  type RelationFilters,
} from '@/lib/relation-filters';
import { selectRelationRevisions } from '@/lib/relation-revisions';
import { KnowledgeGraphCanvas } from './data-foundation-graph';
import styles from './data-reconciliation.module.css';

export function DataKnowledgeRelations({
  locale,
  dataItemId,
  versionId,
}: {
  readonly locale: Locale;
  readonly dataItemId: string;
  readonly versionId: string;
}) {
  const statusId = useId(),
    sourcesId = useId();
  const [sourceLinks, setSourceLinks] = useState('');
  const [revisionMode, setRevisionMode] = useState<'all' | 'current'>('all');
  const [filters, setFilters] = useState<RelationFilters>(
    DEFAULT_RELATION_FILTERS,
  );
  const [filterDraft, setFilterDraft] = useState<RelationFilters>(
    DEFAULT_RELATION_FILTERS,
  );
  const [preview, setPreview] = useState(false);
  const [opened, setOpened] = useState(false);
  const applied = useRef<RelationViewState | null>(null);
  const loadGeneration = useRef(0);
  const dict = getDictionary(locale),
    copy = dict.knowledgeRelations,
    common = dict.assessment;
  const [status, setStatus] = useState<RelationAssertion['status']>('APPROVED');
  const [page, setPage] = useState<ReturnType<
    typeof RelationListOutputSchema.parse
  > | null>(null);
  const [entity, setEntity] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [message, setMessage] = useState('');
  const [payload, setPayload] = useState<unknown>(null),
    [notes, setNotes] = useState<Record<string, string>>({});
  const requests = useRef<AbortController | null>(null),
    keys = useRef(new Map<string, string>());
  useEffect(() => () => requests.current?.abort(), []);
  useEffect(() => {
    function restore() {
      requests.current?.abort();
      loadGeneration.current++;
      applied.current = null;
      setPage(null);
      setEntity(null);
      setSourceLinks('');
      setStatus('APPROVED');
      setPreview(false);
      setRevisionMode('all');
      setFilters(DEFAULT_RELATION_FILTERS);
      setFilterDraft(DEFAULT_RELATION_FILTERS);
      setFailed(false);
      setBusy(false);
      setMessage('');
      setPayload(null);
      setNotes({});
      keys.current.clear();
      try {
        const view = readRelationView(window.location.search, {
          dataItemId,
          versionId,
        });
        setOpened(view !== null);
        if (!view) return;
        setSourceLinks(
          relationSourceLinks(view.sources, locale, window.location.origin),
        );
        setStatus(view.status);
        setPreview(view.preview);
        setRevisionMode(view.revisionMode ?? 'all');
        setFilters(view.filters ?? DEFAULT_RELATION_FILTERS);
        setFilterDraft(view.filters ?? DEFAULT_RELATION_FILTERS);
        void load(view.entity, undefined, view);
      } catch {
        setOpened(true);
        setFailed(true);
      }
    }
    restore();
    window.addEventListener('popstate', restore);
    return () => {
      window.removeEventListener('popstate', restore);
      requests.current?.abort();
      loadGeneration.current++;
    };
  }, [dataItemId, versionId, locale]);
  function sourceExploreHref(
    target: { dataItemId: string; versionId: string },
    tab: 'map' | 'records',
  ) {
    const view = applied.current;
    if (
      view &&
      [view, ...view.sources].some(
        (s) =>
          s.dataItemId === target.dataItemId &&
          s.versionId === target.versionId,
      )
    )
      return relationSourceExploreHref(locale, view, target, tab);
    return `/${locale}/data-foundation/explore?dataItem=${target.dataItemId}&version=${target.versionId}&view=${tab}`;
  }
  function saveView(view: RelationViewState) {
    const href = relationViewHref(window.location.href, view);
    if (
      window.location.pathname +
        window.location.search +
        window.location.hash !==
      href
    )
      window.history.pushState(window.history.state, '', href);
    applied.current = view;
  }
  function applyFilters(value: RelationFilters) {
    try {
      const next = parseRelationFilters(value);
      if (applied.current) saveView({ ...applied.current, filters: next });
      setFilters(next);
      setFilterDraft(next);
      setMessage('');
    } catch {
      setMessage(copy.badFilters);
    }
  }
  const revisions = useMemo(
    () =>
      selectRelationRevisions(
        page?.items ?? [],
        revisionMode,
        !!page &&
          !page.nextCursor &&
          entity === null &&
          !applied.current?.assertionId,
      ),
    [page, revisionMode, entity],
  );
  const visible = useMemo(
    () => filterRelationRows(revisions.items, filters),
    [revisions.items, filters],
  );
  const graph = useMemo(
    () => ({
      nodes: [
        ...new Map(
          visible.items
            .flatMap((r) =>
              [r.candidate.subject, r.candidate.object].map((e) => ({
                key: relationNodeIdentity(r, e),
                label: `${copy.kinds[e.kind]} · ${e.label}`,
                kind: e.kind,
              })),
            )
            .map((e) => [
              e.key,
              { entityId: e.key, label: e.label, kind: e.kind },
            ]),
        ).values(),
      ],
      edges: visible.items.map((r) => ({
        edgeId: r.assertionId,
        fromEntityId: relationNodeIdentity(r, r.candidate.subject),
        toEntityId: relationNodeIdentity(r, r.candidate.object),
        label: copy.predicates[r.candidate.predicate],
      })),
    }),
    [visible.items, copy.predicates, copy.kinds],
  );
  async function request(action: string, input: unknown, command = false) {
    requests.current?.abort();
    const controller = new AbortController();
    requests.current = controller;
    setBusy(true);
    setFailed(false);
    setMessage('');
    const identity = JSON.stringify([action, input]);
    let key = keys.current.get(identity);
    if (command && !key) {
      key = crypto.randomUUID();
      keys.current.set(identity, key);
    }
    try {
      const response = await fetch(`/api/data-foundation/relations/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(input),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (controller.signal.aborted) return null;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) setPage(null);
        throw Error('unavailable');
      }
      const value: unknown = await response.json();
      if (controller.signal.aborted) return null;
      const schema =
        action === 'import'
          ? ImportRelationsOutputSchema
          : action === 'list'
            ? RelationListOutputSchema
            : RelationOutputSchema;
      const parsed = schema.parse(value);
      if (command) keys.current.delete(identity);
      return parsed;
    } catch {
      if (!controller.signal.aborted) setFailed(true);
      return null;
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const fileRead = useRef(0);
  async function chooseFile(file: File | undefined) {
    const generation = ++fileRead.current;
    setPayload(null);
    if (!file) return;
    try {
      if (file.size > 262144) throw Error();
      const input = ImportRelationsInputSchema.parse(
        JSON.parse(await file.text()),
      );
      if (input.dataItemId !== dataItemId || input.versionId !== versionId)
        throw Error();
      if (generation === fileRead.current) {
        setPayload(input);
        setMessage('');
      }
    } catch {
      if (generation === fileRead.current) setMessage(copy.badFile);
    }
  }
  async function load(
    selected: string | null = entity,
    after?: string,
    restored?: RelationViewState,
  ) {
    const generation = ++loadGeneration.current;
    let relatedSources: { dataItemId: string; versionId: string }[],
      entityReference: ReturnType<typeof parseRelationNodeIdentity> | undefined;
    try {
      relatedSources =
        restored?.sources ??
        parseRelationSourceLinks(sourceLinks, window.location.origin);
      entityReference = selected
        ? parseRelationNodeIdentity(selected)
        : undefined;
      if (
        entityReference &&
        entityReference.versionId !== versionId &&
        !relatedSources.some((s) => s.versionId === entityReference?.versionId)
      ) {
        if (relatedSources.length >= MAX_RELATION_RELATED_SOURCES)
          throw Error();
        relatedSources.push({
          dataItemId: entityReference.dataItemId,
          versionId: entityReference.versionId,
        });
      }
    } catch {
      setMessage(copy.badSources);
      setPage(null);
      return;
    }
    const view: RelationViewState = restored ?? {
      dataItemId,
      versionId,
      sources: relatedSources,
      status,
      preview,
      entity: selected,
      pages: after ? (applied.current?.pages ?? 1) + 1 : 1,
      filters,
      revisionMode,
    };
    if (view.pages > 10) return;
    if (view.assertionId) {
      const value = await request('get', { assertionId: view.assertionId });
      if (generation !== loadGeneration.current || !value) return;
      const parsed = RelationOutputSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.assertion.assertionId !== view.assertionId ||
        parsed.data.assertion.status !== view.status ||
        ![view, ...view.sources].some(
          (s) =>
            s.dataItemId === parsed.data.assertion.dataItemId &&
            s.versionId === parsed.data.assertion.versionId,
        )
      ) {
        setPage(null);
        setFailed(true);
        return;
      }
      setPage({ items: [parsed.data.assertion], totalCount: 1 });
      setEntity(null);
      setOpened(true);
      applied.current = view;
      return;
    }
    let items = after ? [...(page?.items ?? [])] : [];
    let cursor = after;
    const steps = restored ? restored.pages : 1;
    for (let i = 0; i < steps; i++) {
      const value = await request('list', {
        dataItemId,
        versionId,
        status: view.status,
        first: 100,
        relatedSources,
        ...(entityReference ? { entityReference } : {}),
        ...(cursor ? { after: cursor } : {}),
      });
      if (generation !== loadGeneration.current || !value) return;
      const parsed = RelationListOutputSchema.safeParse(value);
      if (!parsed.success) {
        setPage(null);
        setFailed(true);
        return;
      }
      items = [
        ...new Map(
          [...items, ...parsed.data.items].map((row) => [row.assertionId, row]),
        ).values(),
      ];
      cursor = parsed.data.nextCursor;
      if (i === steps - 1 || !cursor) {
        setPage({ ...parsed.data, items });
        setEntity(selected);
        setOpened(true);
        view.pages = restored ? i + 1 : view.pages;
        applied.current = view;
        if (!restored) saveView(view);
        return;
      }
    }
  }
  async function showPreceding(row: RelationAssertion) {
    const assertionId = row.candidate.supersedesId;
    if (!assertionId) return;
    const generation = ++loadGeneration.current;
    const value = await request('get', { assertionId });
    if (generation !== loadGeneration.current || !value) return;
    const parsed = RelationOutputSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.assertion.assertionId !== assertionId ||
      parsed.data.assertion.dataItemId !== row.dataItemId
    ) {
      setPage(null);
      setFailed(true);
      return;
    }
    const previous = parsed.data.assertion;
    const current = applied.current ?? {
      dataItemId,
      versionId,
      sources: [],
      status,
      preview,
      entity: null,
      pages: 1,
    };
    const sources = [...current.sources];
    if (
      ![current, ...sources].some(
        (s) =>
          s.dataItemId === previous.dataItemId &&
          s.versionId === previous.versionId,
      )
    )
      sources.push({
        dataItemId: previous.dataItemId,
        versionId: previous.versionId,
      });
    const view: RelationViewState = {
      ...current,
      sources,
      assertionId,
      status: previous.status,
      preview:
        previous.status === 'PENDING_REVIEW' || previous.status === 'APPROVED',
      entity: null,
      pages: 1,
      filters: DEFAULT_RELATION_FILTERS,
    };
    try {
      saveView(view);
    } catch {
      setPage(null);
      setFailed(true);
      return;
    }
    setSourceLinks(
      relationSourceLinks(sources, locale, window.location.origin),
    );
    setStatus(view.status);
    setPreview(view.preview);
    setEntity(null);
    setFilters(DEFAULT_RELATION_FILTERS);
    setFilterDraft(DEFAULT_RELATION_FILTERS);
    setPage({ items: [previous], totalCount: 1 });
  }
  async function review(
    row: RelationAssertion,
    decision: 'APPROVED' | 'REJECTED' | 'CORRECTION_REQUIRED',
  ) {
    const value = await request(
      'review',
      {
        assertionId: row.assertionId,
        expectedVersion: row.version,
        decision,
        rationale: notes[row.assertionId]?.trim(),
      },
      true,
    );
    if (value) {
      const parsed = RelationOutputSchema.safeParse(value);
      if (parsed.success) {
        setPage(null);
        setMessage(copy.reviewed);
      } else setFailed(true);
    }
  }
  return (
    <details
      id="business-relations"
      className={styles.frame}
      open={opened}
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>{copy.title}</summary>
      <div className={styles.body}>
        <p>{copy.hint}</p>
        <label htmlFor={sourcesId}>{copy.relatedSources}</label>
        <textarea
          id={sourcesId}
          rows={2}
          value={sourceLinks}
          disabled={busy}
          onChange={(e) => {
            setSourceLinks(e.target.value);
            applied.current = null;
            setPage(null);
            setEntity(null);
            setMessage('');
          }}
        />
        <p>{copy.relatedHint}</p>
        <label htmlFor={statusId}>{copy.status}</label>
        <select
          id={statusId}
          value={status}
          disabled={busy}
          onChange={(e) => {
            setStatus(e.target.value as RelationAssertion['status']);
            applied.current = null;
            setPage(null);
            setEntity(null);
            setPreview(false);
            setRevisionMode('all');
          }}
        >
          {Object.entries(copy.statuses).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void load()}>
          {busy ? common.busy : copy.load}
        </button>
        {entity ? (
          <button type="button" disabled={busy} onClick={() => void load(null)}>
            {copy.all}
          </button>
        ) : null}
        {failed ? <p role="alert">{common.failure}</p> : null}
        {message ? <p role="status">{message}</p> : null}
        {page ? (
          <>
            <p>
              {copy.count}
              {page.totalCount}
            </p>
            <p>
              {status === 'APPROVED' ? copy.approvedHint : copy.candidateHint}
            </p>
            {page.items.length === 0 ? <p>{copy.empty}</p> : null}
            {status === 'PENDING_REVIEW' ? (
              <label>
                <input
                  type="checkbox"
                  checked={preview}
                  onChange={(e) => {
                    setPreview(e.target.checked);
                    if (applied.current)
                      saveView({
                        ...applied.current,
                        preview: e.target.checked,
                      });
                  }}
                />
                {copy.preview}
              </label>
            ) : null}
            <p>
              {copy.pageCount}
              {page.items.length}
              {page.nextCursor
                ? (applied.current?.pages ?? 0) >= 10
                  ? copy.loadingLimit
                  : copy.partial
                : copy.complete}
            </p>
            <fieldset disabled={busy}>
              <legend>{copy.filterTitle}</legend>
              <label>
                {copy.revisionDisplay}
                <select
                  aria-label={copy.revisionDisplay}
                  value={revisionMode}
                  onChange={(e) => {
                    const next = e.target.value as 'all' | 'current';
                    setRevisionMode(next);
                    if (applied.current)
                      saveView({ ...applied.current, revisionMode: next });
                  }}
                >
                  <option value="all">{copy.revisionAll}</option>
                  <option value="current">{copy.revisionCurrent}</option>
                </select>
              </label>
              {revisionMode === 'current' ? (
                <p role="status">
                  {revisions.deferred
                    ? copy.revisionDeferred
                    : `${copy.revisionHidden}${revisions.hiddenCount} · ${copy.revisionBranches}${revisions.branchCount}`}
                </p>
              ) : null}
              <p>{copy.filterHint}</p>
              <label>
                {copy.filterKind}
                <select
                  value={filterDraft.kind}
                  onChange={(e) =>
                    setFilterDraft({
                      ...filterDraft,
                      kind: e.target.value as RelationFilters['kind'],
                    })
                  }
                >
                  <option value="ALL">{copy.filterAll}</option>
                  {Object.entries(copy.kinds).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {copy.filterTimeRole}
                <select
                  value={filterDraft.timeRole}
                  onChange={(e) =>
                    setFilterDraft({
                      ...filterDraft,
                      timeRole: e.target.value as RelationFilters['timeRole'],
                    })
                  }
                >
                  <option value="ALL">{copy.filterAll}</option>
                  {Object.entries(copy.timeRoles).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {copy.filterFrom}
                <input
                  type="date"
                  value={filterDraft.from ?? ''}
                  onChange={(e) =>
                    setFilterDraft({
                      ...filterDraft,
                      from: e.target.value || null,
                    })
                  }
                />
              </label>
              <label>
                {copy.filterTo}
                <input
                  type="date"
                  value={filterDraft.to ?? ''}
                  onChange={(e) =>
                    setFilterDraft({
                      ...filterDraft,
                      to: e.target.value || null,
                    })
                  }
                />
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={filterDraft.includeUndated}
                  onChange={(e) =>
                    setFilterDraft({
                      ...filterDraft,
                      includeUndated: e.target.checked,
                    })
                  }
                />
                {copy.filterUndated}
              </label>
              <div className={styles.actions}>
                <button type="button" onClick={() => applyFilters(filterDraft)}>
                  {copy.filterApply}
                </button>
                <button
                  type="button"
                  onClick={() => applyFilters(DEFAULT_RELATION_FILTERS)}
                >
                  {copy.filterClear}
                </button>
              </div>
            </fieldset>
            <p role="status">
              {copy.filteredCount}
              {visible.items.length} · {copy.undatedCount}
              {visible.undatedCount}
            </p>
            {visible.items.length === 0 && page.items.length > 0 ? (
              <p>{copy.filteredEmpty}</p>
            ) : null}
            {(status === 'APPROVED' ||
              (status === 'PENDING_REVIEW' && preview)) &&
            visible.items.length > 0 ? (
              <KnowledgeGraphCanvas
                result={graph}
                selectedId={entity}
                onSelect={(id) => {
                  if (!busy) void load(id);
                }}
                locale={locale}
              />
            ) : null}
            {visible.items.map((row) => (
              <article key={row.assertionId}>
                <h3>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void load(
                        relationNodeIdentity(row, row.candidate.subject),
                      )
                    }
                  >
                    {row.candidate.subject.label}
                  </button>
                  {' → '}
                  {copy.predicates[row.candidate.predicate]}
                  {' → '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void load(relationNodeIdentity(row, row.candidate.object))
                    }
                  >
                    {row.candidate.object.label}
                  </button>
                </h3>
                <p>{copy.statuses[row.status]}</p>
                <p>
                  <Link
                    href={`/${locale}/data-foundation/catalog/${row.dataItemId}?version=${row.versionId}`}
                  >
                    {copy.source}
                  </Link>
                  {' · '}
                  <Link href={sourceExploreHref(row, 'map')}>
                    {copy.sourceMap}
                  </Link>
                  {' · '}
                  <Link href={sourceExploreHref(row, 'records')}>
                    {copy.sourceRecords}
                  </Link>
                </p>
                {[row.candidate.subject, row.candidate.object].map(
                  (endpoint, i) => {
                    const focus = relationRecordFocus(row, endpoint);
                    return focus ? (
                      <p key={'record-' + i}>
                        {endpoint.label}
                        {' · '}
                        <Link
                          href={withRecordFocus(
                            sourceExploreHref(focus, 'records'),
                            focus,
                          )}
                        >
                          {copy.boundRecord}
                        </Link>
                        {' · '}
                        <Link
                          href={withRecordFocus(
                            sourceExploreHref(focus, 'map'),
                            focus,
                          )}
                        >
                          {copy.boundRecordMap}
                        </Link>
                      </p>
                    ) : null;
                  },
                )}
                {[row.candidate.subject, row.candidate.object]
                  .filter((e) => e.reference)
                  .map((e, i) => (
                    <p key={i}>
                      {e.label}
                      {' · '}
                      <Link
                        href={`/${locale}/data-foundation/catalog/${e.reference!.dataItemId}?version=${e.reference!.versionId}`}
                      >
                        {copy.source}
                      </Link>
                      {' · '}
                      <Link href={sourceExploreHref(e.reference!, 'map')}>
                        {copy.sourceMap}
                      </Link>
                    </p>
                  ))}
                {row.candidate.qualifiers.context ? (
                  <dl className={styles.metrics}>
                    <div>
                      <dt>{copy.nature}</dt>
                      <dd>
                        {
                          copy.natures[
                            row.candidate.qualifiers.context.recordNature
                          ]
                        }
                      </dd>
                    </div>
                    <div>
                      <dt>{copy.timeRole}</dt>
                      <dd>
                        {
                          copy.timeRoles[
                            row.candidate.qualifiers.context.timeRole
                          ]
                        }
                      </dd>
                    </div>
                    <div>
                      <dt>{copy.period}</dt>
                      <dd>
                        {row.candidate.qualifiers.context.validFrom ??
                          copy.unknown}{' '}
                        —{' '}
                        {row.candidate.qualifiers.context.validTo ??
                          copy.unknown}
                      </dd>
                    </div>
                    <div>
                      <dt>{copy.locationRole}</dt>
                      <dd>
                        {
                          copy.locationRoles[
                            row.candidate.qualifiers.context.locationRole
                          ]
                        }
                      </dd>
                    </div>
                    <div>
                      <dt>{copy.applicability}</dt>
                      <dd>{row.candidate.qualifiers.context.applicability}</dd>
                    </div>
                  </dl>
                ) : null}
                <dl className={styles.metrics}>
                  {[
                    [
                      copy.method,
                      copy.methods[row.candidate.generation.method],
                    ],
                    [copy.measure, row.candidate.qualifiers.measure],
                    [copy.unit, row.candidate.qualifiers.unit],
                    [copy.value, row.candidate.qualifiers.reportedValue],
                    [copy.limit, row.candidate.qualifiers.reportedLimit],
                    [copy.time, row.candidate.qualifiers.observedAt],
                    [copy.spatialScope, row.candidate.qualifiers.spatialScope],
                    [
                      copy.conclusion,
                      row.candidate.qualifiers.reportedConclusion,
                    ],
                    [copy.external, row.candidate.object.externalId],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value ?? copy.unknown}</dd>
                    </div>
                  ))}
                </dl>
                {row.candidate.qualifiers.missing ? (
                  <p>{copy.missing}</p>
                ) : null}
                {row.candidate.qualifiers.limitations.length > 0 ? (
                  <p>
                    {copy.limits}:{' '}
                    {row.candidate.qualifiers.limitations.join(' / ')}
                  </p>
                ) : null}
                <h4>{copy.evidence}</h4>
                {row.candidate.evidence.map((e, i) => (
                  <div key={i}>
                    <p>
                      {copy.polarities[e.polarity]} · {e.locator}
                    </p>
                    {e.excerpt ? <blockquote>{e.excerpt}</blockquote> : null}
                    <Link
                      href={`/api/data-foundation/assets/${e.source?.versionId ?? row.versionId}/${e.assetId}`}
                    >
                      {copy.original}
                    </Link>
                  </div>
                ))}
                {row.candidate.supersedesId ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void showPreceding(row)}
                  >
                    {copy.supersedes}
                  </button>
                ) : null}
                <details>
                  <summary>{copy.history}</summary>
                  {row.reviews.map((r) => (
                    <p key={r.reviewId}>
                      {copy.statuses[r.decision]} ·{' '}
                      <time dateTime={r.createdAt}>{r.createdAt}</time> ·{' '}
                      {r.rationale}
                    </p>
                  ))}
                </details>
                <p>{copy.reviewHint}</p>
                <label>
                  {copy.note}
                  <textarea
                    value={notes[row.assertionId] ?? ''}
                    maxLength={1024}
                    disabled={busy}
                    onChange={(e) =>
                      setNotes((old) => ({
                        ...old,
                        [row.assertionId]: e.target.value,
                      }))
                    }
                  />
                </label>
                <div className={styles.actions}>
                  {(
                    [
                      ['APPROVED', copy.approve],
                      ['CORRECTION_REQUIRED', copy.correct],
                      ['REJECTED', copy.reject],
                    ] as const
                  ).map(([decision, label]) => (
                    <button
                      key={decision}
                      type="button"
                      disabled={busy || !notes[row.assertionId]?.trim()}
                      onClick={() => void review(row, decision)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </article>
            ))}
            {page.nextCursor && (applied.current?.pages ?? 0) < 10 ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(entity, page.nextCursor)}
              >
                {copy.more}
              </button>
            ) : null}
          </>
        ) : null}
        <details>
          <summary>{copy.importTitle}</summary>
          <p>{copy.importHint}</p>
          <label>
            {copy.file}
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => {
                void chooseFile(e.target.files?.[0]);
              }}
            />
          </label>
          <button
            type="button"
            disabled={busy || !payload}
            onClick={() =>
              void request('import', payload, true).then((v) => {
                if (v) {
                  setPayload(null);
                  setPage(null);
                  setMessage(copy.imported);
                }
              })
            }
          >
            {copy.importAction}
          </button>
        </details>
      </div>
    </details>
  );
}
