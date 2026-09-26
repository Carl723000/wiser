import type { DataCapabilityId } from '@wiser/data-contracts';

// Only resource-aware read paths are admitted during managed-project rollout.
// Maintenance workflows require their own ownership checks before inclusion.
const RESOURCE_AWARE = new Set<DataCapabilityId>([
  'data.catalog.search',
  'data.catalog.get',
  'data.catalog.versions.list',
  'data.catalog.versions.get',
  'data.query',
  'data.search.federated',
  'data.knowledge.search',
  'data.graph.expand',
  'data.graph.findPath',
  'data.geo.query',
  'data.geo.intersect',
  'data.explore.query',
  'data.explore.export',
  'data.explore.view.create',
  'data.explore.view.list',
  'data.explore.view.open',
  'data.explore.view.revoke',
  'data.assessment.get',
  'data.assessment.list',
  'data.assessment.overview',
  'data.knowledge.relations.get',
  'data.knowledge.relations.list',
  'data.external.metadata.read',
]);
export function admitsManagedCapability(
  capabilityId: DataCapabilityId,
): boolean {
  return RESOURCE_AWARE.has(capabilityId);
}
