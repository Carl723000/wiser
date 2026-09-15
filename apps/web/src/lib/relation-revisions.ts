import type { RelationAssertion } from '@wiser/data-contracts';

/** Presentation only. Never review, merge identities, or infer the newest from dates. */
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
