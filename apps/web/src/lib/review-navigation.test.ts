import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { relationViewHref, relationSourceLinks } from './relation-navigation';
const dataItemId = randomUUID(),
  versionId = randomUUID(),
  analysisId = randomUUID(),
  assetId = randomUUID(),
  recordId = randomUUID(),
  assertionId = randomUUID();
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
