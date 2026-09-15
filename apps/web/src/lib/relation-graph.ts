import { readCatalogVersion } from './catalog-route';
import {
  MAX_RELATION_RELATED_SOURCES,
  RelationEntityReferenceSchema,
  type RelationAssertion,
  type RelationCandidate,
} from '@wiser/data-contracts';

type Source = Pick<
  RelationAssertion,
  'dataItemId' | 'versionId' | 'mappingVersion'
>;
export function relationNodeReference(
  source: Source,
  entity: RelationCandidate['subject'],
) {
  return (
    entity.reference ?? {
      dataItemId: source.dataItemId,
      versionId: source.versionId,
      mappingVersion: source.mappingVersion,
      entityKey: entity.key,
    }
  );
}
export function relationNodeIdentity(
  source: Source,
  entity: RelationCandidate['subject'],
) {
  const r = relationNodeReference(source, entity);
  return JSON.stringify([
    r.dataItemId,
    r.versionId,
    r.mappingVersion,
    r.entityKey,
  ]);
}
export function parseRelationSourceLinks(
  value: string,
  origin: string,
): { dataItemId: string; versionId: string }[] {
  const links = value.trim() ? value.trim().split(/\s+/) : [];
  if (links.length > MAX_RELATION_RELATED_SOURCES)
    throw Error('Too many sources');
  return [
    ...new Map(
      links.map((text) => {
        const url = new URL(text, origin);
        const match =
          /^\/(?:zh-CN|en)\/data-foundation\/catalog\/([a-f\d-]+)$/.exec(
            url.pathname,
          );
        if (url.origin !== origin || url.username || url.password || !match)
          throw Error('Expected a platform source link');
        const r = RelationEntityReferenceSchema.parse({
          dataItemId: match[1],
          versionId: readCatalogVersion(url.searchParams),
          mappingVersion: 'parse',
          entityKey: 'parse',
        });
        return [
          r.versionId,
          { dataItemId: r.dataItemId, versionId: r.versionId },
        ] as const;
      }),
    ).values(),
  ];
}
export function parseRelationNodeIdentity(value: string) {
  const tuple: unknown = JSON.parse(value);
  if (!Array.isArray(tuple) || tuple.length !== 4)
    throw Error('Invalid selection');
  return RelationEntityReferenceSchema.parse({
    dataItemId: (tuple as unknown[])[0],
    versionId: (tuple as unknown[])[1],
    mappingVersion: (tuple as unknown[])[2],
    entityKey: (tuple as unknown[])[3],
  });
}
