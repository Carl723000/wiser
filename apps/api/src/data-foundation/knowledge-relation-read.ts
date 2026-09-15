import { z } from 'zod';
import {
  RelationAssertionSchema,
  type RelationAssertion,
} from '@wiser/data-contracts';
export const RELATION_SELECT = `select b.*,a.status,a.row_version,a.created_at,
 coalesce((select jsonb_agg(jsonb_build_object('reviewId',r.review_record_id,'reviewerId',r.reviewer_actor_id,'decision',r.decision,'rationale',r.rationale,'createdAt',r.created_at) order by r.row_version) from knowledge.review_record r where r.assertion_id=a.assertion_id),'[]'::jsonb) reviews
 from knowledge.assertion_binding b join knowledge.assertion a using(tenant_id,project_id,assertion_id)`;

export function readRelationAssertion(
  row: Record<string, unknown>,
): RelationAssertion {
  return RelationAssertionSchema.parse({
    assertionId: row['assertion_id'],
    dataItemId: row['data_item_id'],
    versionId: row['version_id'],
    version: Number(row['row_version']),
    mappingVersion: row['mapping_version'],
    candidate: row['candidate'],
    status: row['status'],
    confidence: null,
    createdAt: z.coerce.date().parse(row['created_at']).toISOString(),
    reviews: z
      .array(z.record(z.string(), z.unknown()))
      .parse(row['reviews'])
      .map((r) => ({
        ...r,
        createdAt: z.coerce.date().parse(r['createdAt']).toISOString(),
      })),
  });
}
