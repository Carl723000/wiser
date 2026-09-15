import {
  RelationCandidateSchema,
  RelationEntitySchema,
  type RelationAssertion,
} from '@wiser/data-contracts';

const TimeRole =
  RelationCandidateSchema.shape.qualifiers.shape.context.unwrap().shape
    .timeRole;
export type RelationFilters = {
  kind: RelationAssertion['candidate']['subject']['kind'] | 'ALL';
  timeRole:
    | NonNullable<
        RelationAssertion['candidate']['qualifiers']['context']
      >['timeRole']
    | 'ALL';
  from: string | null;
  to: string | null;
  includeUndated: boolean;
};
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
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid filters');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !['kind', 'timeRole', 'from', 'to', 'includeUndated'].includes(k),
    )
  )
    throw Error('Unknown filter');
  const kind =
    v['kind'] === 'ALL'
      ? 'ALL'
      : RelationEntitySchema.shape.kind.parse(v['kind']);
  const timeRole =
    v['timeRole'] === 'ALL' ? 'ALL' : TimeRole.parse(v['timeRole']);
  for (const key of ['from', 'to'])
    if (v[key] !== null && (typeof v[key] !== 'string' || day(v[key]) === null))
      throw Error('Invalid filter date');
  if (typeof v['includeUndated'] !== 'boolean')
    throw Error('Invalid undated choice');
  const from = v['from'] as string | null,
    to = v['to'] as string | null;
  if (from && to && from > to) throw Error('Reversed filter dates');
  return { kind, timeRole, from, to, includeUndated: v['includeUndated'] };
}
// Source precision is retained: a year or month represents a possible interval,
// never an invented sampling date. Unrecognized or partial periods stay unknown.
export function sourceTime(
  value: string | null,
): readonly [number, number] | null {
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
