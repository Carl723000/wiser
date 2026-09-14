import { RelationEntitySchema } from '@wiser/data-contracts';
import { parseRelationNodeIdentity } from './relation-graph';
/** Retain diagram focus only within the same authorized query; it is not a data filter. */
export function withBusinessFocus(href: string, search: string): string {
  const url = new URL(href, 'http://local');
  const source = new URLSearchParams(search);
  const query = source.getAll('query');
  if (query.length !== 1 || query[0] !== url.searchParams.get('query'))
    return href;
  const kinds = source.getAll('businessKind');
  if (
    kinds.length === 1 &&
    RelationEntitySchema.shape.kind.safeParse(kinds[0]).success
  )
    url.searchParams.set('businessKind', kinds[0]);
  const entities = source.getAll('businessEntity');
  if (entities.length === 1 && entities[0].length <= 2048) {
    try {
      parseRelationNodeIdentity(entities[0]);
      url.searchParams.set('businessEntity', entities[0]);
    } catch {
      /* Invalid focus must not change the authorized query. */
    }
  }
  return url.pathname + url.search;
}
