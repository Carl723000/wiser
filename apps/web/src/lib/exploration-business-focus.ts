import { RelationEntitySchema } from '@wiser/data-contracts';
import { parseRelationNodeIdentity } from './relation-graph';
/** Retain diagram focus only within the same authorized query; it is not a data filter. */
export function withBusinessFocus(
  href: string,
  search: string,
  openedSaved?: { readonly viewId: string; readonly queryId: string },
): string {
  const url = new URL(href, 'http://local');
  const source = new URLSearchParams(search);
  const query = source.getAll('query');
  const saved = source.getAll('saved');
  const target = url.searchParams.get('query');
  const sameQuery = query.length === 1 && query[0] === target;
  const sameSaved =
    query.length === 0 &&
    saved.length === 1 &&
    openedSaved?.viewId === saved[0] &&
    openedSaved.queryId === target;
  if (!sameQuery && !sameSaved) return href;
  const modes = source.getAll('businessMode');
  if (modes.length === 1 && modes[0] === 'all')
    url.searchParams.set('businessMode', 'all');
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
