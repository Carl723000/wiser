import { describe, expect, it } from 'vitest';
import { RelationListInputSchema } from '@wiser/data-contracts';
import { parseRelationSourceLinks } from './relation-graph';
import {
  readRelationView,
  relationViewHref,
  relationSourceExploreHref,
  relationReturnHref,
  withRelationReturn,
} from './relation-navigation';
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

describe('business graph to source exploration round trip', () => {
  it('carries the exact graph scope and focus through a source map and query tab link', () => {
    const focused = {
      ...state,
      pages: 2,
      entity: JSON.stringify([base.dataItemId, base.versionId, 'v1', 'river']),
    };
    const map = relationSourceExploreHref('zh-CN', focused, source, 'map');
    const mapUrl = new URL(map, 'http://localhost');
    expect(mapUrl.searchParams.get('dataItem')).toBe(source.dataItemId);
    expect(mapUrl.searchParams.get('version')).toBe(source.versionId);
    const records = withRelationReturn(
      '/zh-CN/data-foundation/explore?query=opaque&view=records',
      mapUrl.search,
    );
    const back = relationReturnHref(
      new URL(records, 'http://localhost').search,
      'zh-CN',
    );
    expect(back).not.toBeNull();
    expect(
      readRelationView(new URL(back!, 'http://localhost').search, base),
    ).toEqual(focused);
  });
  it('does not allow unrelated target sources or arbitrary return destinations', () => {
    expect(() =>
      relationSourceExploreHref(
        'en',
        state,
        { ...source, versionId: base.versionId },
        'map',
      ),
    ).toThrow();
    for (const text of [
      'https://elsewhere.test',
      JSON.stringify({ ...state, redirect: 'https://elsewhere.test' }),
      'x'.repeat(9000),
    ]) {
      expect(
        relationReturnHref(
          '?returnRelations=' + encodeURIComponent(text),
          'en',
        ),
      ).toBeNull();
    }
    expect(
      relationReturnHref('?returnRelations={}&returnRelations={}', 'en'),
    ).toBeNull();
    expect(
      withRelationReturn(
        '/en/data-foundation/explore?query=opaque',
        '?returnRelations=bad',
      ),
    ).toBe('/en/data-foundation/explore?query=opaque');
  });
});

it('restores strict type and time conditions through a source round trip', () => {
  const filters = {
    kind: 'OBSERVATION',
    timeRole: 'OBSERVATION_TIME',
    from: '2026-06-01',
    to: '2026-09-10',
    includeUndated: false,
  } as const;
  const view = { ...state, filters };
  const href = relationSourceExploreHref('zh-CN', view, source, 'records');
  const back = relationReturnHref(
    new URL(href, 'http://localhost').search,
    'zh-CN',
  );
  expect(
    readRelationView(new URL(back!, 'http://localhost').search, base),
  ).toEqual(view);
  expect(() =>
    readRelationView(
      '?relations=' +
        encodeURIComponent(
          JSON.stringify({
            ...view,
            filters: { ...filters, to: '2025-01-01' },
          }),
        ),
      base,
    ),
  ).toThrow();
});

it('restores one exact history assertion and rejects conflicting focus', () => {
  const history = {
    ...state,
    assertionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  expect(
    readRelationView(
      '?relations=' + encodeURIComponent(JSON.stringify(history)),
      base,
    ),
  ).toEqual(history);
  for (const changed of [
    { ...history, assertionId: 'invalid' },
    { ...history, pages: 2 },
    {
      ...history,
      entity: JSON.stringify([base.dataItemId, base.versionId, 'v1', 'point']),
    },
  ])
    expect(() =>
      readRelationView(
        '?relations=' + encodeURIComponent(JSON.stringify(changed)),
        base,
      ),
    ).toThrow();
});
