import type { RelationAssertion } from '@wiser/data-contracts';
import { relationNodeIdentity } from './relation-graph';
export interface BusinessEvidencePath {
  nodeIds: string[];
  steps: { row: RelationAssertion; forward: boolean }[];
}
export function businessEvidencePath(
  rows: readonly RelationAssertion[],
  from: string,
  to: string,
): BusinessEvidencePath | null {
  const neighbors = new Map<
    string,
    { next: string; row: RelationAssertion; forward: boolean }[]
  >();
  for (const row of [...rows].sort((a, b) =>
    a.assertionId < b.assertionId ? -1 : a.assertionId > b.assertionId ? 1 : 0,
  )) {
    const a = relationNodeIdentity(row, row.candidate.subject),
      b = relationNodeIdentity(row, row.candidate.object);
    for (const [start, next, forward] of [
      [a, b, true],
      [b, a, false],
    ] as const) {
      const values = neighbors.get(start) ?? [];
      values.push({ next, row, forward });
      neighbors.set(start, values);
    }
  }
  if (!neighbors.has(from) || !neighbors.has(to)) return null;
  const queue = [{ id: from, depth: 0 }],
    seen = new Set([from]);
  const previous = new Map<
    string,
    { id: string; row: RelationAssertion; forward: boolean }
  >();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (current.id === to) {
      const result: BusinessEvidencePath = { nodeIds: [to], steps: [] };
      let id = to;
      while (id !== from) {
        const step = previous.get(id)!;
        result.steps.unshift({ row: step.row, forward: step.forward });
        result.nodeIds.unshift(step.id);
        id = step.id;
      }
      return result;
    }
    if (current.depth === 8) continue;
    for (const step of neighbors.get(current.id) ?? []) {
      if (seen.has(step.next)) continue;
      seen.add(step.next);
      previous.set(step.next, {
        id: current.id,
        row: step.row,
        forward: step.forward,
      });
      queue.push({ id: step.next, depth: current.depth + 1 });
    }
  }
  return null;
}
