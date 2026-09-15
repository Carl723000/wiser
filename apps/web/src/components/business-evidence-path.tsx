'use client';
import type { RelationAssertion } from '@wiser/data-contracts';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { getDictionary, type Locale } from '@/lib/i18n';
import { businessEvidencePath } from '@/lib/business-evidence-path';
import { businessObjectSources } from '@/lib/business-object-sources';
import { relationNodeIdentity } from '@/lib/relation-graph';
import { KnowledgeGraphCanvas } from './data-foundation-graph';
import styles from './data-explorer-business.module.css';

export function BusinessEvidencePathPanel({
  rows,
  locale,
}: {
  rows: readonly RelationAssertion[];
  locale: Locale;
}) {
  const copy = getDictionary(locale).knowledgeRelations;
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [fromSearch, setFromSearch] = useState(''),
    [toSearch, setToSearch] = useState(''),
    [applied, setApplied] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const sources = useMemo(() => businessObjectSources(rows), [rows]);
  const nodes = useMemo(
    () =>
      new Map(
        rows.flatMap((row) =>
          [row.candidate.subject, row.candidate.object].map(
            (entity) => [relationNodeIdentity(row, entity), entity] as const,
          ),
        ),
      ),
    [rows],
  );
  const options = useMemo(
    () =>
      [...nodes]
        .map(([id, entity]) => {
          const source = sources.get(id)!;
          return {
            id,
            label: `${copy.kinds[entity.kind]} · ${entity.label} — ${source.title || copy.businessObjectSource + source.sourceNumber}${source.objectNumber ? ` · ${copy.businessObjectNumber} ${source.objectNumber}` : ''}`,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [nodes, sources, copy, locale],
  );
  const path = useMemo(
    () => (applied ? businessEvidencePath(rows, from, to) : null),
    [rows, from, to, applied],
  );
  const graph = useMemo(
    () =>
      path
        ? {
            nodes: path.nodeIds.map((id) => ({
              entityId: id,
              label:
                copy.kinds[nodes.get(id)!.kind] + ' · ' + nodes.get(id)!.label,
              kind: nodes.get(id)!.kind,
            })),
            edges: path.steps.map(({ row }) => ({
              edgeId: row.assertionId,
              fromEntityId: relationNodeIdentity(row, row.candidate.subject),
              toEntityId: relationNodeIdentity(row, row.candidate.object),
              label: copy.predicates[row.candidate.predicate],
            })),
          }
        : null,
    [path, nodes, copy],
  );
  return (
    <details>
      <summary>{copy.businessPathTitle}</summary>
      <p>{copy.businessPathHint}</p>
      <p>{copy.businessPathTemporary}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(true);
          setSelected(null);
        }}
        className={styles.pathForm}
      >
        {(
          [
            {
              name: copy.businessPathFrom,
              value: from,
              set: setFrom,
              search: fromSearch,
              setSearch: setFromSearch,
              searchLabel: copy.businessPathSearchFrom,
            },
            {
              name: copy.businessPathTo,
              value: to,
              set: setTo,
              search: toSearch,
              setSearch: setToSearch,
              searchLabel: copy.businessPathSearchTo,
            },
          ] as const
        ).map((field) => (
          <div key={field.name}>
            <label>
              {field.searchLabel}
              <input
                type="search"
                value={field.search}
                onChange={(e) => field.setSearch(e.target.value)}
              />
            </label>
            <label>
              {field.name}
              <select
                value={field.value}
                onChange={(e) => {
                  field.set(e.target.value);
                  setApplied(false);
                  setSelected(null);
                }}
              >
                <option value="">{copy.businessPathChoose}</option>
                {options
                  .filter(
                    (option) =>
                      option.id === field.value ||
                      option.label
                        .toLocaleLowerCase(locale)
                        .includes(
                          field.search.trim().toLocaleLowerCase(locale),
                        ),
                  )
                  .map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        ))}
        <button disabled={!from || !to || from === to} type="submit">
          {copy.businessPathFind}
        </button>
      </form>
      {applied && !path ? (
        <p role="status">{copy.businessPathMissing}</p>
      ) : null}
      {path && graph ? (
        <>
          <p role="status">
            {copy.businessPathCount}
            {path.steps.length}
          </p>
          <KnowledgeGraphCanvas
            result={graph}
            locale={locale}
            selectedId={selected}
            onSelect={setSelected}
            path={{
              nodeIds: path.nodeIds,
              edgeIds: path.steps.map((s) => s.row.assertionId),
            }}
          />
          <ol
            className={`${styles.objectList} ${styles.pathObjects}`}
            aria-label={copy.businessPathObjects}
          >
            {path.nodeIds.map((id) => {
              const source = sources.get(id)!;
              return (
                <li key={id}>
                  <button
                    onClick={() => setSelected(id)}
                    aria-pressed={selected === id}
                  >
                    {options.find((o) => o.id === id)!.label}
                  </button>
                  <Link
                    href={`/${locale}/data-foundation/catalog/${source.dataItemId}?version=${source.versionId}`}
                  >
                    {copy.source}
                  </Link>
                </li>
              );
            })}
          </ol>
          <ol>
            {path.steps.map(({ row, forward }) => (
              <li key={row.assertionId} className={styles.evidence}>
                <strong>
                  {row.candidate.subject.label} →{' '}
                  {copy.predicates[row.candidate.predicate]} →{' '}
                  {row.candidate.object.label}
                </strong>
                {!forward ? <p>{copy.businessPathReverse}</p> : null}
                <p>{row.candidate.qualifiers?.context?.applicability}</p>
                <Link
                  href={`/${locale}/data-foundation/catalog/${row.dataItemId}?version=${row.versionId}`}
                >
                  {copy.source}
                </Link>
                <details>
                  <summary>
                    {copy.businessOriginalEvidence} (
                    {row.candidate.evidence.length})
                  </summary>
                  {row.candidate.evidence.map((e, i) => (
                    <div key={i}>
                      <Link
                        href={`/api/data-foundation/assets/${e.source?.versionId ?? row.versionId}/${e.assetId}`}
                      >
                        {e.locator}
                      </Link>
                      {e.excerpt ? <blockquote>{e.excerpt}</blockquote> : null}
                    </div>
                  ))}
                </details>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </details>
  );
}
