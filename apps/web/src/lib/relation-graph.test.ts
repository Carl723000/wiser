import { expect, it } from 'vitest';
import {
  parseRelationSourceLinks,
  relationNodeIdentity,
} from './relation-graph';
it('accepts only bounded exact-version local platform links', () => {
  const root = 'https://water.example';
  const item = '11111111-1111-4111-8111-111111111111',
    version = '22222222-2222-4222-8222-222222222222';
  const path = `/zh-CN/data-foundation/catalog/${item}?versionId=${version}`;
  expect(parseRelationSourceLinks(root + path, root)).toEqual([
    { dataItemId: item, versionId: version },
  ]);
  expect(() =>
    parseRelationSourceLinks('https://other.example' + path, root),
  ).toThrow();
  expect(() =>
    parseRelationSourceLinks(`/zh-CN/data-foundation/catalog/${item}`, root),
  ).toThrow();
});
it('namespaces equal labels by source but follows an explicit reference', () => {
  const source = { dataItemId: 'a', versionId: 'v1', mappingVersion: 'm1' };
  const entity = {
    key: 'same',
    label: 'Same spelling',
    kind: 'PERSON' as const,
    externalId: null,
  };
  expect(relationNodeIdentity(source, entity)).not.toBe(
    relationNodeIdentity({ ...source, versionId: 'v2' }, entity),
  );
  expect(
    relationNodeIdentity(source, {
      ...entity,
      reference: { ...source, versionId: 'v2', entityKey: 'same' },
    }),
  ).toBe(relationNodeIdentity({ ...source, versionId: 'v2' }, entity));
});
