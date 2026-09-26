import { z } from 'zod';
import { ExplorationResourceCoverageSchema } from '@wiser/data-contracts';
import type { QueryAdapterPgClient } from './query-adapters.js';
import type { AnalysisVersionRef } from './exploration-views.js';

const CoverageRow = z.object({
  resource_count: z.coerce.number().int().nonnegative().max(10000),
  temporal_count: z.coerce.number().int().nonnegative().max(10000),
  geometry_count: z.coerce.number().int().nonnegative().max(10000),
});

/** A version is counted once even if it has several extent records. RLS applies to both extent tables. */
const COVERAGE = `
with refs as materialized (
  select ref->>'dataItemId' data_item_id, ref->>'versionId' version_id
  from jsonb_array_elements($1::jsonb) ref
)
select count(*)::int resource_count,
  count(*) filter (where temporal.recorded)::int temporal_count,
  count(*) filter (where geometry.recorded)::int geometry_count
from refs
cross join lateral (
  select exists (
    select 1 from catalog.temporal_extent extent
    where extent.version_id = refs.version_id::uuid
      and extent.data_item_id = refs.data_item_id::uuid
  ) recorded
) temporal
cross join lateral (
  select exists (
    select 1 from catalog.spatial_extent extent
    where extent.version_id = refs.version_id::uuid
      and extent.data_item_id = refs.data_item_id::uuid
  ) recorded
) geometry`;

export async function loadExplorationResourceCoverage(
  client: Pick<QueryAdapterPgClient, 'query'>,
  refs: readonly AnalysisVersionRef[],
) {
  if (
    refs.length > 10000 ||
    new Set(refs.map((ref) => `${ref.dataItemId}:${ref.versionId}`)).size !==
      refs.length
  )
    throw new Error('Invalid fixed resource coverage membership');
  const result = await client.query(COVERAGE, [JSON.stringify(refs)]);
  const row = CoverageRow.parse(result.rows[0]);
  if (
    row.resource_count !== refs.length ||
    row.temporal_count > refs.length ||
    row.geometry_count > refs.length
  )
    throw new Error('Incomplete fixed resource coverage aggregation');
  return ExplorationResourceCoverageSchema.parse({
    temporal: {
      recordedVersionCount: row.temporal_count,
      unknownVersionCount: refs.length - row.temporal_count,
    },
    geometry: {
      recordedVersionCount: row.geometry_count,
      unknownVersionCount: refs.length - row.geometry_count,
    },
    approvedAssertionCount: null,
    effectiveActions: null,
  });
}
