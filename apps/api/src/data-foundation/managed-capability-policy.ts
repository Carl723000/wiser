import type { DataCapabilityId } from '@wiser/data-contracts';

// Only paths with explicit resource or pending-intake ownership guards are admitted.
// Candidate reads require current project maintenance/review permission, immutable
// submitter/delegator or independent human review authority, and forced scoped RLS.
// Other maintenance workflows remain excluded until their own ownership checks.
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
  'data.ingestion.candidate.get',
  'data.ingestion.candidate.records',
  'data.ingestion.candidate.geometry',
  'data.uploadSession.create',
  'data.uploadSession.complete',
  'data.ingestion.create',
  'data.ingestion.submit',
  'data.ingestion.get',
]);
export function admitsManagedCapability(
  capabilityId: DataCapabilityId,
): boolean {
  return RESOURCE_AWARE.has(capabilityId);
}
