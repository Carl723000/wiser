import { describe, expect, it } from 'vitest';
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
