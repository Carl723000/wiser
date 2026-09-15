import { expect, it } from 'vitest';
import type { RelationAssertion } from '@wiser/data-contracts';
import { businessScene, sceneNeighborhood } from './business-scene';
import { relationNodeIdentity } from './relation-graph';
const row = (
  id: string,
  from: string,
  to: string,
  kind: RelationAssertion['candidate']['subject']['kind'] = 'DOCUMENT',
  label = from,
) =>
  ({
    assertionId: id,
    dataItemId: 'source',
    versionId: 'version',
    mappingVersion: 'mapping',
    version: 1,
    status: 'PENDING_REVIEW',
    confidence: null,
    createdAt: '2026-09-15T00:00:00Z',
    reviews: [],
    candidate: {
      subject: { key: from, label, kind, externalId: null },
      object: { key: to, label: to, kind: 'PLACE', externalId: null },
      predicate: 'ABOUT_ENTITY',
      generation: { method: 'MANUAL', model: null },
      supersedesId: null,
      evidence: [],
      qualifiers: {
        measure: null,
        reportedValue: null,
        reportedLimit: null,
        unit: null,
        observedAt: null,
        missing: true,
        spatialScope: null,
        limitations: [],
        reportedConclusion: null,
      },
    },
  }) as RelationAssertion;
it('preserves all exact directed assertions and identities, including duplicate names in different versions', () => {
  const a = row('a', 'paper', 'place', 'DOCUMENT', '永定河水质与微生物研究');
  const b = { ...a, assertionId: 'b', versionId: 'another' };
  const scene = businessScene([a, b]);
  expect(scene.nodes).toHaveLength(4);
  expect(scene.edges.map((e) => [e.id, e.from, e.to])).toEqual(
    [a, b].map((r) => [
      r.assertionId,
      relationNodeIdentity(r, r.candidate.subject),
      relationNodeIdentity(r, r.candidate.object),
    ]),
  );
  expect(
    scene.nodes.find((n) => n.label === a.candidate.subject.label)?.group,
  ).toBe('literature');
});
it('classifies documents by their own declaration, never by the row mentioning a foreign source', () => {
  const own = row('a', 'doc', 'place', 'DOCUMENT', '河北水资源公报');
  const ref = {
    dataItemId: 'source',
    versionId: 'version',
    mappingVersion: 'mapping',
    version: 1,
    status: 'PENDING_REVIEW',
    confidence: null,
    createdAt: '2026-09-15T00:00:00Z',
    reviews: [],
    entityKey: 'doc',
  };
  const mention = row('b', 'foreign', 'unrelated');
  mention.candidate.object = {
    ...own.candidate.subject,
    reference: ref,
    label: '论文',
  };
  mention.dataItemId = 'foreign';
  const scene = businessScene([mention, own]);
  expect(
    scene.nodes.find(
      (n) => n.id === relationNodeIdentity(own, own.candidate.subject),
    )?.group,
  ).toBe('reports');
  expect(
    businessScene([row('x', 'opaque', 'p')]).nodes.find(
      (n) => n.label === 'opaque',
    )?.group,
  ).toBe('unclassified');
});
it('highlights direct evidence and only traverses another hop after explicit expansion', () => {
  const rows = [
    row('ab', 'a', 'b', 'PLACE'),
    row('bc', 'b', 'c', 'PLACE'),
    row('cd', 'c', 'd', 'PLACE'),
    row('xy', 'x', 'y', 'PLACE'),
  ];
  const scene = businessScene(rows);
  const a = relationNodeIdentity(rows[0], rows[0].candidate.subject);
  expect([...sceneNeighborhood(scene, a, null).edges]).toEqual(['ab']);
  expect([...sceneNeighborhood(scene, a, null, 2).edges]).toEqual(['ab', 'bc']);
  expect([...sceneNeighborhood(scene, null, 'bc').edges]).toEqual(['bc']);
  expect(sceneNeighborhood(scene, null, 'missing').nodes.size).toBe(0);
  expect(scene.edges).toHaveLength(4);
});
it('keeps publication dates and foreign assertion periods out of object-time grouping', () => {
  const observed = row('a', 'sample', 'reach', 'OBSERVATION');
  observed.candidate.qualifiers.context = {
    recordNature: 'REPORTED_OBSERVATION',
    timeRole: 'PUBLICATION_TIME',
    validFrom: '2022-10-11',
    validTo: '2022-10-11',
    locationRole: 'STUDY_AREA',
    applicability: 'Publication date only',
  };
  expect(
    businessScene([observed]).nodes.find((n) => n.kind === 'OBSERVATION')
      ?.periods,
  ).toEqual([]);
  observed.candidate.qualifiers.context.timeRole = 'OBSERVATION_TIME';
  observed.candidate.qualifiers.context.validFrom = '2019-06';
  observed.candidate.qualifiers.context.validTo = '2019-06';
  expect(
    businessScene([observed]).nodes.find((n) => n.kind === 'OBSERVATION')
      ?.periods,
  ).toEqual(['2019-06']);
});
