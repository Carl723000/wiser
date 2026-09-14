import { readRecordFocus } from './exploration-record-focus';
import type { RelationAssertion } from '@wiser/data-contracts';
import { relationNodeIdentity } from './relation-graph';
/** Overview keeps business evidence and its existing connectors; all rows remain explorable. */
export function businessGraphRows(
  rows: readonly RelationAssertion[],
  mode: 'overview' | 'all',
  selected: string | null,
) {
  if (selected)
    return rows.filter((r) =>
      [r.candidate.subject, r.candidate.object].some(
        (e) => relationNodeIdentity(r, e) === selected,
      ),
    );
  if (mode === 'all') return [...rows];
  const endpoints = (r: RelationAssertion) =>
    [r.candidate.subject, r.candidate.object].map((e) =>
      relationNodeIdentity(r, e),
    );
  const business = rows.filter(
    (r) =>
      r.candidate.qualifiers?.context?.recordNature !== 'SOURCE_RELATION' &&
      ![r.candidate.subject, r.candidate.object].some(
        (e) => e.kind === 'OBSERVATION',
      ),
  );
  const seeds = new Set(business.flatMap(endpoints));
  const businessIds = new Set(business.map((r) => r.assertionId));
  // Keep a shared identity hub only when actual assertions connect multiple seed objects.
  const hubs = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.candidate.predicate !== 'IDENTITY_MATCH') continue;
    const ids = endpoints(r);
    for (const id of ids) {
      if (seeds.has(id)) continue;
      const neighbors = hubs.get(id) ?? new Set<string>();
      for (const other of ids) if (seeds.has(other)) neighbors.add(other);
      hubs.set(id, neighbors);
    }
  }
  for (const [id, neighbors] of hubs) if (neighbors.size >= 2) seeds.add(id);
  return rows.filter(
    (r) =>
      businessIds.has(r.assertionId) ||
      endpoints(r).every((id) => seeds.has(id)),
  );
}

/** Any explicitly bound record may be browsed; its entity kind retains its original meaning. */
export function businessRecordFocus(
  row: RelationAssertion,
  entity: RelationAssertion['candidate']['subject'],
) {
  if (!entity.externalId?.startsWith('urn:wiser:record:')) return null;
  const ref = entity.reference ?? row;
  try {
    return readRecordFocus(
      JSON.stringify({
        dataItemId: ref.dataItemId,
        versionId: ref.versionId,
        recordId: entity.externalId.slice('urn:wiser:record:'.length),
      }),
    );
  } catch {
    return null;
  }
}
