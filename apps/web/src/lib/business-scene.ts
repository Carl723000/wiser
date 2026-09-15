import { businessObjectSources } from './business-object-sources';
import { sourceTime } from './relation-filters';
import type { RelationAssertion } from '@wiser/data-contracts';
import { relationNodeIdentity } from './relation-graph';
import { businessRecordFocus } from './business-graph';
export type SceneNode = {
  id: string;
  label: string;
  kind: RelationAssertion['candidate']['subject']['kind'];
  group: string;
  classificationBasis: string | null;
  sourceTitle?: string;
  record: ReturnType<typeof businessRecordFocus>;
  periods: string[];
};
export type SceneEdge = {
  id: string;
  from: string;
  to: string;
  row: RelationAssertion;
};
export type BusinessScene = { nodes: SceneNode[]; edges: SceneEdge[] };
/** Display taxonomy, based on the object's own source title. Unknown stays explicit.
 * These rules do not classify scientific conclusions or change registered metadata. */
export function sourceCategory(title: string) {
  const rules: readonly [string, RegExp][] = [
    ['spatial', /Sentinel|遥感|影像|像元|产品元数据|参考位置|绿光|近红外/i],
    ['policy', /条例|规划|政策/],
    ['literature', /论文|研究|补充表|补充材料|样本多样性/],
    ['reports', /公报|月报|报告|水质.*状况|地表水.*公布/],
    ['exchange', /会议|大会|季刊|联盟/],
    ['monitoring', /雨量|雨情|水情|流量|站码|来源表/],
  ];
  return (
    rules.find(([, pattern]) => pattern.test(title))?.[0] ?? 'unclassified'
  );
}
export function businessScene(
  rows: readonly RelationAssertion[],
): BusinessScene {
  const sources = businessObjectSources(rows);
  const nodes = new Map<string, SceneNode>();
  const owned = new Set<string>();
  const periods = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const entity of [row.candidate.subject, row.candidate.object]) {
      const id = relationNodeIdentity(row, entity);
      const period =
        row.candidate.qualifiers.context?.validFrom ??
        (row.candidate.qualifiers.context?.timeRole === 'OBSERVATION_TIME'
          ? row.candidate.qualifiers.observedAt
          : null);
      if (
        period &&
        sourceTime(period) &&
        !entity.reference &&
        ((entity.kind === 'OBSERVATION' &&
          row.candidate.qualifiers.context?.timeRole === 'OBSERVATION_TIME') ||
          (entity.kind === 'EVENT' &&
            row.candidate.qualifiers.context?.timeRole === 'EVENT_TIME'))
      ) {
        const dates = periods.get(id) ?? new Set<string>();
        dates.add(period);
        periods.set(id, dates);
      }
      if (owned.has(id) || (entity.reference && nodes.has(id))) continue;
      if (!entity.reference) owned.add(id);
      nodes.set(id, {
        id,
        label: entity.label,
        sourceTitle: sources.get(id)?.title,
        kind: entity.kind,
        group:
          entity.kind === 'DOCUMENT'
            ? !entity.reference
              ? sourceCategory(entity.label)
              : 'unclassified'
            : entity.kind,
        classificationBasis:
          entity.kind === 'DOCUMENT' && !entity.reference ? entity.label : null,
        record: businessRecordFocus(row, entity),
        periods: [],
      });
    }
  }
  return {
    nodes: [...nodes.values()]
      .map((n) => ({ ...n, periods: [...(periods.get(n.id) ?? [])].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id, 'en')),
    edges: rows.map((row) => ({
      id: row.assertionId,
      from: relationNodeIdentity(row, row.candidate.subject),
      to: relationNodeIdentity(row, row.candidate.object),
      row,
    })),
  };
}
/** Undirected reading neighborhood; retained assertions always keep their original direction. */
export function sceneNeighborhood(
  scene: BusinessScene,
  node: string | null,
  edge: string | null,
  depth = 1,
) {
  const nodes = new Set<string>(),
    edges = new Set<string>();
  if (edge) {
    const match = scene.edges.find((e) => e.id === edge);
    if (match) {
      nodes.add(match.from);
      nodes.add(match.to);
      edges.add(match.id);
    }
    return { nodes, edges };
  }
  if (!node || !scene.nodes.some((n) => n.id === node)) return { nodes, edges };
  nodes.add(node);
  let frontier = new Set([node]);
  for (let step = 0; step < Math.max(1, Math.min(2, depth)); step++) {
    const next = new Set<string>();
    for (const e of scene.edges) {
      if (!frontier.has(e.from) && !frontier.has(e.to)) continue;
      edges.add(e.id);
      for (const id of [e.from, e.to]) if (!nodes.has(id)) next.add(id);
    }
    for (const id of next) nodes.add(id);
    frontier = next;
  }
  return { nodes, edges };
}
