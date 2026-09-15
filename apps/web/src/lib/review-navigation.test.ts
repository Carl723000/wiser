import { catalogHref, readCatalogVersion } from './catalog-route';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { relationViewHref, relationSourceLinks } from './relation-navigation';
const dataItemId = randomUUID(),
  versionId = randomUUID();
it('accepts the actual catalog version query parameter when saving a relation view', () => {
  const view = {
    dataItemId,
    versionId,
    sources: [],
    status: 'APPROVED' as const,
    preview: false,
    entity: null,
    pages: 1,
  };
  expect(() =>
    relationViewHref(
      `http://local/zh-CN/data-foundation/catalog/${dataItemId}?version=${versionId}`,
      view,
    ),
  ).not.toThrow();
});
it('emits the version parameter consumed by the catalog page for pinned source links', () => {
  const href = relationSourceLinks(
    [{ dataItemId, versionId }],
    'zh-CN',
    'http://local',
  );
  expect(new URL(href).searchParams.get('version')).toBe(versionId);
});

it('keeps two historical versions distinct and rejects ambiguous or malformed pins', () => {
  const newer = randomUUID();
  for (const v of [versionId, newer]) {
    const url = new URL(catalogHref('zh-CN', dataItemId, v), 'http://local');
    expect(readCatalogVersion(Object.fromEntries(url.searchParams))).toBe(v);
    expect(readCatalogVersion({ versionId: v })).toBe(v);
  }
  expect(
    readCatalogVersion({ version: versionId, versionId: newer }),
  ).toBeNull();
  expect(readCatalogVersion({ version: [versionId, versionId] })).toBeNull();
  expect(readCatalogVersion({ version: 'bad' })).toBeNull();
  expect(readCatalogVersion({})).toBeUndefined();
});
