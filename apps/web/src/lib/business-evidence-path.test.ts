import { expect, it } from 'vitest';
import type { RelationAssertion } from '@wiser/data-contracts';
import { businessEvidencePath } from './business-evidence-path';
import { relationNodeIdentity } from './relation-graph';

function edge(id: string, from: string, to: string, source = 'A') {
  return {
    assertionId: id,
    dataItemId: source,
    versionId: source,
    mappingVersion: 'v1',
    candidate: {
      subject: { key: from, label: '同名', kind: 'CLAIM', externalId: null },
      object: { key: to, label: '同名', kind: 'CLAIM', externalId: null },
      predicate: 'ABOUT_ENTITY',
    },
  } as RelationAssertion;
}
it('connects across explicit references, preserves original edge directions and never joins names', () => {
  const a = edge('a', 'policy', 'river');
  const b = edge('b', 'study', 'river', 'B');
  const link = edge('link', 'river', 'river');
  link.candidate.object.reference = {
    dataItemId: 'B',
    versionId: 'B',
    mappingVersion: 'v1',
    entityKey: 'river',
  };
  const from = relationNodeIdentity(a, a.candidate.subject),
    to = relationNodeIdentity(b, b.candidate.subject);
  expect(businessEvidencePath([a, b], from, to)).toBeNull();
  const result = businessEvidencePath([b, link, a], from, to);
  expect(result?.steps.map((s) => [s.row.assertionId, s.forward])).toEqual([
    ['a', true],
    ['link', true],
    ['b', false],
  ]);
  expect(result?.nodeIds).toEqual([
    from,
    relationNodeIdentity(a, a.candidate.object),
    relationNodeIdentity(b, b.candidate.object),
    to,
  ]);
  expect(b.candidate.subject.key).toBe('study');
});
it('bounds traversal at eight edges, rejects absent endpoints and returns a deterministic path through cycles', () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    edge(String(i), String(i), String(i + 1)),
  );
  const from = relationNodeIdentity(rows[0], rows[0].candidate.subject);
  expect(businessEvidencePath(rows, from, 'missing')).toBeNull();
  expect(
    businessEvidencePath(
      rows,
      from,
      relationNodeIdentity(rows[8], rows[8].candidate.object),
    ),
  ).toBeNull();
  expect(
    businessEvidencePath(
      rows,
      from,
      relationNodeIdentity(rows[7], rows[7].candidate.object),
    )?.steps,
  ).toHaveLength(8);
  expect(
    businessEvidencePath([...rows, edge('cycle', '2', '0')], from, from)?.steps,
  ).toHaveLength(0);
  const parallel = edge('z', '0', '1');
  expect(
    businessEvidencePath(
      [parallel, rows[0]],
      from,
      relationNodeIdentity(parallel, parallel.candidate.object),
    )?.steps[0]?.row.assertionId,
  ).toBe('0');
});
