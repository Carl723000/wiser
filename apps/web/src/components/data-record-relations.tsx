'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  RelationListOutputSchema,
  type RelationAssertion,
} from '@wiser/data-contracts';
import {
  relationRecordFocus,
  type RecordFocus,
} from '@/lib/exploration-record-focus';
import { businessRecordFocus } from '@/lib/business-graph';
import { relationNodeIdentity } from '@/lib/relation-graph';
import {
  readRelationView,
  relationViewHref,
  type RelationViewState,
} from '@/lib/relation-navigation';
import { filterRelationRows } from '@/lib/relation-filters';
import { getDictionary, type Locale } from '@/lib/i18n';

type Props = {
  locale: Locale;
  record: RecordFocus;
  returnGraph: string | null;
  business?: { queryId: string; status: RelationAssertion['status'] };
};
export function DataRecordRelations(props: Props) {
  return (
    <RecordRelations
      key={JSON.stringify([props.record, props.returnGraph, props.business])}
      {...props}
    />
  );
}
function RecordRelations({ locale, record, returnGraph, business }: Props) {
  const copy = getDictionary(locale).knowledgeRelations;
  const [scope] = useState<RelationViewState>(() => {
    if (returnGraph) {
      const url = new URL(returnGraph, 'http://local');
      const dataItemId = url.pathname.split('/').at(-1)!;
      const versionId = url.searchParams.get('versionId')!;
      try {
        const view = readRelationView(url.search, { dataItemId, versionId });
        if (
          view &&
          [view, ...view.sources].some(
            (s) =>
              s.dataItemId === record.dataItemId &&
              s.versionId === record.versionId,
          )
        )
          return view;
      } catch {
        /* Invalid navigation never widens the record scope. */
      }
    }
    return {
      dataItemId: record.dataItemId,
      versionId: record.versionId,
      sources: [],
      status: 'APPROVED',
      preview: false,
      entity: null,
      pages: 1,
    };
  });
  const [status, setStatus] = useState<RelationAssertion['status']>(
    business?.status ??
      (scope.status === 'PENDING_REVIEW' && scope.preview
        ? 'PENDING_REVIEW'
        : 'APPROVED'),
  );
  const [rows, setRows] = useState<RelationAssertion[]>([]);
  const [next, setNext] = useState<string>();
  const [checked, setChecked] = useState(0);
  const [total, setTotal] = useState(0);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const clear = () => {
    controller.current?.abort();
    setRows([]);
    setNext(undefined);
    setChecked(0);
    setTotal(0);
    setStarted(false);
    setBusy(false);
    setFailed(false);
  };
  async function load(after?: string) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setFailed(false);
    if (!after) {
      setRows([]);
      setChecked(0);
    }
    try {
      const collected: RelationAssertion[] = [];
      const cursors = new Set<string>();
      let cursor = after,
        count: number | undefined;
      do {
        const response = await fetch('/api/data-foundation/relations/list', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(business
              ? { queryId: business.queryId }
              : {
                  dataItemId: scope.dataItemId,
                  versionId: scope.versionId,
                  relatedSources: scope.sources,
                }),
            status,
            first: 100,
            ...(cursor ? { after: cursor } : {}),
          }),
          signal: request.signal,
        });
        if (!response.ok) throw Error('Unavailable');
        const page = RelationListOutputSchema.parse(await response.json());
        if (request.signal.aborted) return;
        const sources = [scope, ...scope.sources];
        if (
          page.items.some(
            (row) =>
              row.status !== status ||
              (!business &&
                !sources.some(
                  (source) =>
                    source.dataItemId === row.dataItemId &&
                    source.versionId === row.versionId,
                )),
          ) ||
          (count !== undefined && count !== page.totalCount) ||
          (cursor && page.nextCursor === cursor) ||
          (page.nextCursor && cursors.has(page.nextCursor))
        )
          throw Error('Invalid result');
        count = page.totalCount;
        collected.push(...page.items);
        cursor = page.nextCursor;
        if (cursor) cursors.add(cursor);
        if (business && collected.length > 2000) throw Error('Scope too large');
      } while (business && cursor);
      if (
        business &&
        (collected.length !== count ||
          new Set(collected.map((r) => r.assertionId)).size !==
            collected.length)
      )
        throw Error('Incomplete scope');
      setRows((previous) => [
        ...new Map(
          [...(after ? previous : []), ...collected].map((row) => [
            row.assertionId,
            row,
          ]),
        ).values(),
      ]);
      setChecked((previous) => (after ? previous : 0) + collected.length);
      setTotal(count);
      setNext(cursor);
      setStarted(true);
    } catch {
      if (request.signal.aborted) return;
      setRows([]);
      setNext(undefined);
      setChecked(0);
      setStarted(false);
      setFailed(true);
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  const matches = new Map<string, { label: string; href: string }>();
  const visible = scope.filters
    ? filterRelationRows(rows, scope.filters).items
    : rows;
  for (const row of visible)
    for (const entity of [row.candidate.subject, row.candidate.object]) {
      const focus = business
        ? businessRecordFocus(row, entity)
        : relationRecordFocus(row, entity);
      if (
        !focus ||
        focus.recordId !== record.recordId ||
        focus.versionId !== record.versionId ||
        focus.dataItemId !== record.dataItemId
      )
        continue;
      const pin = entity.reference ?? row;
      if (
        !business &&
        ![scope, ...scope.sources].some(
          (s) =>
            s.dataItemId === pin.dataItemId && s.versionId === pin.versionId,
        )
      )
        continue;
      const identity = relationNodeIdentity(row, entity);
      const { assertionId: _history, ...view } = scope;
      const href = business
        ? `/${locale}/data-foundation/explore?${new URLSearchParams({ query: business.queryId, view: 'graph', businessEntity: identity })}`
        : relationViewHref(
            `http://local/${locale}/data-foundation/catalog/${scope.dataItemId}?versionId=${scope.versionId}`,
            {
              ...view,
              status,
              preview: status === 'PENDING_REVIEW',
              entity: identity,
              pages: 1,
            },
          );
      matches.set(identity, { label: entity.label, href });
    }
  return (
    <section aria-label={copy.recordRelations}>
      <h3>{copy.recordRelations}</h3>
      <p>{copy.recordRelationHint}</p>
      <label>
        {copy.recordRelationStatus}
        <select
          value={status}
          disabled={busy || Boolean(business)}
          onChange={(event) => {
            clear();
            setStatus(
              event.target.value === 'PENDING_REVIEW'
                ? 'PENDING_REVIEW'
                : 'APPROVED',
            );
          }}
        >
          {business && !['APPROVED', 'PENDING_REVIEW'].includes(status) ? (
            <option value={status}>{copy.statuses[status]}</option>
          ) : null}
          <option value="APPROVED">{copy.statuses.APPROVED}</option>
          <option value="PENDING_REVIEW">{copy.statuses.PENDING_REVIEW}</option>
        </select>
      </label>
      {status === 'PENDING_REVIEW' ? <p>{copy.recordRelationPending}</p> : null}
      <button disabled={busy} onClick={() => void load()}>
        {copy.findRecordRelations}
      </button>
      {failed ? <p role="alert">{copy.recordRelationFailed}</p> : null}
      {started ? (
        <>
          <p>
            {copy.recordRelationChecked} {checked} / {total}
          </p>
          <ul>
            {[...matches].map(([key, value]) => (
              <li key={key}>
                <Link href={value.href}>{value.label}</Link>
              </li>
            ))}
          </ul>
          {next ? (
            <>
              <p>{copy.recordRelationPartial}</p>
              <button disabled={busy} onClick={() => void load(next)}>
                {copy.recordRelationMore}
              </button>
            </>
          ) : matches.size === 0 ? (
            <p>{copy.recordRelationEmpty}</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
