import {
  BusinessRelationFiltersSchema,
  type RelationAssertion,
  type BusinessRelationFilters,
} from '@wiser/data-contracts';

export type RelationFilters = BusinessRelationFilters;
export const DEFAULT_RELATION_FILTERS: RelationFilters = {
  kind: 'ALL',
  timeRole: 'ALL',
  from: null,
  to: null,
  includeUndated: true,
};
function day(value: string): number | null {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
    ? time
    : null;
}
export function parseRelationFilters(value: unknown): RelationFilters {
  return BusinessRelationFiltersSchema.parse(value);
}
// Source precision is retained: a year or month represents a possible interval,
// never an invented sampling date. Unrecognized or partial periods stay unknown.
function sourceTime(value: string | null): readonly [number, number] | null {
  if (!value) return null;
  if (/^[1-9]\d{3}$/.test(value))
    return [
      Date.parse(value + '-01-01T00:00:00Z'),
      Date.parse(value + '-12-31T00:00:00Z') + 86400000 - 1,
    ];
  if (/^[1-9]\d{3}-\d{2}$/.test(value)) {
    const start = day(value + '-01');
    if (start === null) return null;
    const next = new Date(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return [start, next.getTime() - 1];
  }
  const full = day(value);
  if (full !== null) return [full, full + 86400000 - 1];
  if (
    /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    day(value.slice(0, 10)) !== null
  ) {
    const time = Date.parse(value);
    if (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
    )
      return [time, time];
  }
  return null;
}
function period(row: RelationAssertion): readonly [number, number] | null {
  const q = row.candidate.qualifiers,
    c = q.context;
  if (!c || c.timeRole === 'UNKNOWN') return null;
  if (
    c.validFrom === null &&
    c.validTo === null &&
    c.timeRole === 'OBSERVATION_TIME'
  )
    return sourceTime(q.observedAt);
  const start = sourceTime(c.validFrom),
    end = sourceTime(c.validTo);
  if (!start || !end || start[0] > end[1]) return null;
  return [start[0], end[1]];
}
export function filterRelationRows(
  rows: readonly RelationAssertion[],
  filters: RelationFilters,
) {
  const f = parseRelationFilters(filters);
  const start = f.from ? day(f.from)! : Number.NEGATIVE_INFINITY;
  const end = f.to ? day(f.to)! + 86400000 - 1 : Number.POSITIVE_INFINITY;
  let undatedCount = 0;
  const items = rows.filter((row) => {
    const c = row.candidate;
    if (
      f.kind !== 'ALL' &&
      c.subject.kind !== f.kind &&
      c.object.kind !== f.kind
    )
      return false;
    if (
      f.timeRole !== 'ALL' &&
      (c.qualifiers.context?.timeRole ?? 'UNKNOWN') !== f.timeRole
    )
      return false;
    const interval = period(row);
    if (!interval) undatedCount++;
    if (!f.from && !f.to) return true;
    return interval
      ? interval[0] <= end && interval[1] >= start
      : f.includeUndated;
  });
  return { items, undatedCount };
}

/** A deterministic current-revision view; never changes review authority. */
export function selectRelationRevisions(
  rows: readonly RelationAssertion[],
  mode: 'all' | 'current',
  complete: boolean,
) {
  const deferred = mode === 'current' && !complete;
  if (mode === 'all' || deferred)
    return { items: rows, hiddenCount: 0, branchCount: 0, deferred };
  const byId = new Map(rows.map((r) => [r.assertionId, r]));
  const links = new Map<string, string>();
  for (const next of rows) {
    const previous = byId.get(next.candidate.supersedesId ?? '');
    if (
      previous &&
      previous.assertionId !== next.assertionId &&
      previous.dataItemId === next.dataItemId &&
      previous.status === next.status &&
      ['APPROVED', 'PENDING_REVIEW'].includes(next.status) &&
      previous.candidate.subject.key === next.candidate.subject.key &&
      previous.candidate.object.key === next.candidate.object.key &&
      previous.candidate.predicate === next.candidate.predicate
    )
      links.set(next.assertionId, previous.assertionId);
  }
  const cycles = new Set<string>();
  for (const first of links.keys()) {
    const path: string[] = [],
      seen = new Map<string, number>();
    let id: string | undefined = first;
    while (id !== undefined && !seen.has(id)) {
      seen.set(id, path.length);
      path.push(id);
      id = links.get(id);
    }
    if (id !== undefined)
      for (const member of path.slice(seen.get(id))) cycles.add(member);
  }
  const successors = new Map<string, number>();
  for (const [next, previous] of links)
    if (!cycles.has(next) && !cycles.has(previous))
      successors.set(previous, (successors.get(previous) ?? 0) + 1);
  const items = rows.filter((r) => !successors.has(r.assertionId));
  return {
    items,
    hiddenCount: rows.length - items.length,
    branchCount: [...successors.values()].filter((count) => count > 1).length,
    deferred: false,
  };
}
