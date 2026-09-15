import { expect, it } from 'vitest';
import type { RelationAssertion } from '@wiser/data-contracts';
import { selectRelationRevisions } from './relation-revisions';
function row(id: string, supersedesId: string | null = null) {
  return {
    assertionId: id,
    dataItemId: 'source',
    versionId: 'version',
    status: 'PENDING_REVIEW',
    mappingVersion: id,
    candidate: {
      subject: { key: 'observation' },
      predicate: 'OBSERVES_ENTITY',
      object: { key: 'river' },
      supersedesId,
    },
  } as RelationAssertion;
}
it('retains all history unless current mode has a complete unfiltered source scope', () => {
  const rows = [row('old'), row('new', 'old')];
  expect(selectRelationRevisions(rows, 'all', true).items).toEqual(rows);
  expect(selectRelationRevisions(rows, 'current', false)).toMatchObject({
    items: rows,
    deferred: true,
    hiddenCount: 0,
  });
  expect(selectRelationRevisions(rows, 'current', true)).toMatchObject({
    items: [rows[1]],
    hiddenCount: 1,
    deferred: false,
  });
  expect(rows[0].candidate.supersedesId).toBeNull();
});
it('keeps competing corrections and reports their branch without choosing a winner', () => {
  const rows = [row('a'), row('b', 'a'), row('c', 'a'), row('d', 'b')];
  expect(selectRelationRevisions(rows, 'current', true)).toMatchObject({
    items: [rows[2], rows[3]],
    hiddenCount: 2,
    branchCount: 1,
  });
});
it('never lets a pending correction hide approved knowledge, another source, or another triple', () => {
  const old = row('old');
  old.status = 'APPROVED';
  const other = row('other');
  other.dataItemId = 'other-source';
  const changed = row('changed');
  changed.candidate.predicate = 'DERIVED_FROM';
  const rows = [
    old,
    row('new', 'old'),
    other,
    row('foreign', 'other'),
    changed,
    row('different', 'changed'),
    row('unknown', 'absent'),
  ];
  expect(selectRelationRevisions(rows, 'current', true).items).toEqual(rows);
});
it('preserves cycles and self references rather than hiding all their evidence', () => {
  const rows = [row('a', 'b'), row('b', 'a'), row('c', 'c')];
  expect(selectRelationRevisions(rows, 'current', true)).toMatchObject({
    items: rows,
    hiddenCount: 0,
  });
});
it('does not promote rejected or correction-required assertions to current replacements', () => {
  const a = row('a'),
    b = row('b', 'a');
  a.status = 'REJECTED';
  b.status = 'REJECTED';
  expect(selectRelationRevisions([a, b], 'current', true).items).toEqual([
    a,
    b,
  ]);
});
