import type { RelationAssertion } from '@wiser/data-contracts';
import { relationNodeIdentity, relationNodeReference } from './relation-graph';

/** Captions use only the authorized rows, never the owning row of a foreign reference. */
export function businessObjectSources(rows: readonly RelationAssertion[]) {
  const titles = new Map<string, Set<string>>();
  const nodes = new Map<
    string,
    { dataItemId: string; versionId: string; source: string; group: string }
  >();
  for (const row of rows) {
    for (const entity of [row.candidate.subject, row.candidate.object]) {
      const ref = relationNodeReference(row, entity);
      const source = JSON.stringify([ref.dataItemId, ref.versionId]);
      const id = relationNodeIdentity(row, entity);
      nodes.set(id, {
        dataItemId: ref.dataItemId,
        versionId: ref.versionId,
        source,
        group: JSON.stringify([source, entity.kind, entity.label]),
      });
      if (
        !entity.reference &&
        entity.kind === 'DOCUMENT' &&
        entity.label.trim()
      ) {
        const values = titles.get(source) ?? new Set<string>();
        values.add(entity.label.trim());
        titles.set(source, values);
      }
    }
  }
  const sources = [...new Set([...nodes.values()].map((n) => n.source))].sort();
  const groups = new Map<string, string[]>();
  for (const [id, node] of nodes) {
    const ids = groups.get(node.group) ?? [];
    ids.push(id);
    groups.set(node.group, ids);
  }
  for (const ids of groups.values()) ids.sort();
  return new Map(
    [...nodes].map(([id, node]) => {
      const group = groups.get(node.group)!;
      return [
        id,
        {
          dataItemId: node.dataItemId,
          versionId: node.versionId,
          title: [...(titles.get(node.source) ?? [])].sort().join(' · '),
          sourceNumber: sources.indexOf(node.source) + 1,
          objectNumber: group.length > 1 ? group.indexOf(id) + 1 : null,
        },
      ] as const;
    }),
  );
}
