import { describe, expect, it } from 'vitest';
import type { RelationAssertion } from '@wiser/data-contracts';
import {
  DEFAULT_RELATION_FILTERS,
  filterRelationRows,
  parseRelationFilters,
} from './relation-filters';
function row(
  id: string,
  from: string | null,
  to: string | null,
  role = 'OBSERVATION_TIME',
) {
  return {
    assertionId: id,
    candidate: {
      subject: { kind: 'OBSERVATION' },
      object: { kind: 'PLACE' },
      qualifiers: {
        observedAt: null,
        context: { timeRole: role, validFrom: from, validTo: to },
      },
    },
  } as RelationAssertion;
}
const filters = {
  ...DEFAULT_RELATION_FILTERS,
  from: '2019-06-01',
  to: '2019-06-30',
  includeUndated: false,
};
describe('loaded business relation filters', () => {
  it('uses source periods including coarse years without substituting publication dates', () => {
    const rows = [
      row('year', '2019', '2019'),
      row('month', '2019-06', '2019-06'),
      row('other', '2026-06-01', '2026-06-30'),
      row('publication', '2019-06-01', '2019-06-01', 'PUBLICATION_TIME'),
    ];
    expect(
      filterRelationRows(rows, {
        ...filters,
        timeRole: 'OBSERVATION_TIME',
      }).items.map((r) => r.assertionId),
    ).toEqual(['year', 'month']);
    expect(
      filterRelationRows(rows, {
        ...filters,
        timeRole: 'PUBLICATION_TIME',
      }).items.map((r) => r.assertionId),
    ).toEqual(['publication']);
  });
  it('retains unknown or incomplete periods only by explicit option and never fills missing endpoints', () => {
    const rows = [
      row('unknown', null, null),
      row('open', '2019-01-01', null),
      row('invalid', '2019-02-30', '2019-06-03'),
      row('reversed', '2020', '2019'),
    ];
    expect(filterRelationRows(rows, filters)).toEqual({
      items: [],
      undatedCount: 4,
    });
    expect(
      filterRelationRows(rows, { ...filters, includeUndated: true }).items,
    ).toEqual(rows);
    expect(filterRelationRows(rows, DEFAULT_RELATION_FILTERS).items).toEqual(
      rows,
    );
  });
  it('uses a point observation only with an explicit observation role, keeping other source dates distinct', () => {
    const observation = row('observation', null, null);
    observation.candidate.qualifiers.observedAt = '2019-06-02T08:00:00Z';
    const publication = row('publication', null, null, 'PUBLICATION_TIME');
    publication.candidate.qualifiers.observedAt =
      observation.candidate.qualifiers.observedAt;
    expect(
      filterRelationRows([observation, publication], filters).items,
    ).toEqual([observation]);
  });
  it('matches either endpoint kind without collapsing source identities or mutating input', () => {
    const rows = [row('a', '2019', '2019')];
    const before = JSON.stringify(rows);
    expect(
      filterRelationRows(rows, { ...DEFAULT_RELATION_FILTERS, kind: 'PLACE' })
        .items,
    ).toEqual(rows);
    expect(
      filterRelationRows(rows, { ...DEFAULT_RELATION_FILTERS, kind: 'PERSON' })
        .items,
    ).toEqual([]);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('rejects impossible, reversed and unknown URL filter state instead of broadening it', () => {
    expect(parseRelationFilters(filters)).toEqual(filters);
    for (const bad of [
      { ...filters, from: '2019-02-30' },
      { ...filters, from: '2020-01-01' },
      { ...filters, kind: 'UNKNOWN_KIND' },
      { ...filters, redirect: 'https://elsewhere.test' },
      { ...filters, includeUndated: 'true' },
    ])
      expect(() => parseRelationFilters(bad)).toThrow();
  });
});
