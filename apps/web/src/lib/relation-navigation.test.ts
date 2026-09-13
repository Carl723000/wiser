import { describe, expect, it } from 'vitest';
import { RelationListInputSchema } from '@wiser/data-contracts';
import { parseRelationSourceLinks } from './relation-graph';
import { readRelationView, relationViewHref } from './relation-navigation';
const base = {
  dataItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const source = {
  dataItemId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
};
const state = {
  ...base,
  sources: [source],
  status: 'PENDING_REVIEW' as const,
  preview: true,
  entity: null,
  pages: 1,
};
describe('relation view links', () => {
  it('restores explicit pending intent and source scope without storing evidence text', () => {
    const href = relationViewHref(
      'http://localhost/zh-CN/data-foundation/catalog/' +
        base.dataItemId +
        '?versionId=' +
        base.versionId,
      state,
    );
    const url = new URL(href, 'http://localhost');
    expect(url.hash).toBe('#business-relations');
    expect(url.searchParams.get('versionId')).toBe(base.versionId);
    expect(readRelationView(url.search, base)).toEqual(state);
    expect(readRelationView('', base)).toBeNull();
  });
  it('rejects mismatched resource, malformed, duplicate and overlarge state instead of widening the query', () => {
    for (const value of [
      { ...state, versionId: source.versionId },
      { ...state, sources: [source, source] },
      { ...state, preview: true, status: 'REJECTED' },
      { ...state, evidence: 'secret' },
      { ...state, pages: 11 },
      { ...state, entity: 'not-an-identity' },
    ]) {
      expect(() =>
        readRelationView(
          '?relations=' + encodeURIComponent(JSON.stringify(value)),
          base,
        ),
      ).toThrow();
    }
    expect(() => readRelationView('?relations=%7Bbad', base)).toThrow();
    expect(() =>
      readRelationView(
        '?relations=' + encodeURIComponent('x'.repeat(9000)),
        base,
      ),
    ).toThrow();
    expect(() =>
      readRelationView('?relations={}&relations={}', base),
    ).toThrow();
  });
});

it('restores a full 32-source case and rejects the next source consistently', () => {
  const sources = Array.from({ length: 32 }, (_, i) => ({
    dataItemId: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    versionId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
  }));
  for (const size of [12, 31]) {
    const view = { ...state, sources: sources.slice(0, size) };
    const links = view.sources
      .map(
        (s) =>
          `http://localhost/zh-CN/data-foundation/catalog/${s.dataItemId}?versionId=${s.versionId}`,
      )
      .join('\n');
    expect(parseRelationSourceLinks(links, 'http://localhost')).toEqual(
      view.sources,
    );
    expect(
      RelationListInputSchema.parse({ ...base, relatedSources: view.sources })
        .relatedSources,
    ).toEqual(view.sources);
    const href = relationViewHref(
      `http://localhost/zh-CN/data-foundation/catalog/${base.dataItemId}?versionId=${base.versionId}`,
      view,
    );
    expect(
      readRelationView(new URL(href, 'http://localhost').search, base),
    ).toEqual(view);
  }
  expect(() =>
    RelationListInputSchema.parse({ ...base, relatedSources: sources }),
  ).toThrow();
  expect(() =>
    readRelationView(
      '?relations=' + encodeURIComponent(JSON.stringify({ ...state, sources })),
      base,
    ),
  ).toThrow();
  expect(() =>
    parseRelationSourceLinks(
      sources
        .map(
          (s) =>
            `http://localhost/zh-CN/data-foundation/catalog/${s.dataItemId}?versionId=${s.versionId}`,
        )
        .join('\n'),
      'http://localhost',
    ),
  ).toThrow();
});
