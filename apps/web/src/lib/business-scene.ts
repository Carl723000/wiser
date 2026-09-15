import type { RelationAssertion } from '@wiser/data-contracts';
export type SceneNode = { id: string; label: string; kind: string; group: string };
export type SceneEdge = { id: string; from: string; to: string; row: RelationAssertion };
export type BusinessScene = { nodes: SceneNode[]; edges: SceneEdge[] };
export function businessScene(_rows: readonly RelationAssertion[]): BusinessScene {
  return { nodes: [], edges: [] };
}
export function sceneNeighborhood(_scene: BusinessScene, _node: string | null, _edge: string | null, _depth = 1) {
  return { nodes: new Set<string>(), edges: new Set<string>() };
}
