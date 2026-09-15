import { expect, it } from 'vitest';
import type { RelationAssertion } from '@wiser/data-contracts';
import { businessGraphRows } from './business-graph';
import { relationNodeIdentity } from './relation-graph';
const row = (
  id: string,
  kind: RelationAssertion['candidate']['subject']['kind'],
) =>
  ({
    assertionId: id,
    dataItemId: 'source',
    versionId: 'version',
    mappingVersion: 'mapping',
    candidate: {
      subject: { key: id, label: id, kind, externalId: null },
      object: {
        key: 'river',
        label: 'River',
        kind: 'RIVER_REACH',
        externalId: null,
      },
    },
  }) as RelationAssertion;
it('keeps different source kinds visible and explicitly counts collapsed observation detail', () => {
  const rows = [
    row('policy', 'POLICY'),
    row('study', 'DOCUMENT'),
    row('event', 'EVENT'),
    row('observation', 'OBSERVATION'),
  ];
  expect(
    businessGraphRows(rows, 'overview', null).map((r) => r.assertionId),
  ).toEqual(['policy', 'study', 'event']);
  expect(businessGraphRows(rows, 'all', null)).toHaveLength(4);
});
it('expands a selected object across all source rows, including observation evidence', () => {
  const rows = [row('policy', 'POLICY'), row('observation', 'OBSERVATION')];
  expect(
    businessGraphRows(
      rows,
      'overview',
      relationNodeIdentity(rows[0], rows[0].candidate.object),
    ),
  ).toHaveLength(2);
});
it('keeps business evidence and its connecting identities, without expanding a source catalogue star', () => {
  const policy = row('policy', 'POLICY');
  const study = row('study', 'DOCUMENT');
  const catalogue = row('catalogue', 'DOCUMENT');
  catalogue.candidate.qualifiers = {
    context: { recordNature: 'SOURCE_RELATION' },
  } as RelationAssertion['candidate']['qualifiers'];
  const connector = row('connector', 'RIVER_REACH');
  connector.candidate.subject = policy.candidate.subject;
  connector.candidate.object = study.candidate.subject;
  connector.candidate.qualifiers = catalogue.candidate.qualifiers;
  const rows = [policy, study, catalogue, connector];
  expect(
    businessGraphRows(rows, 'overview', null).map((r) => r.assertionId),
  ).toEqual(['policy', 'study', 'connector']);
  expect(businessGraphRows(rows, 'all', null)).toHaveLength(4);
});
it('focuses a category through actual neighboring edges without mixing unconnected evidence', () => {
  const policy = row('policy', 'POLICY');
  const study = row('study', 'DOCUMENT');
  const other = row('other', 'EVENT');
  other.candidate.object = { ...other.candidate.object, key: 'elsewhere' };
  expect(
    businessGraphRows([policy, study, other], 'overview', null, 'POLICY').map(
      (r) => r.assertionId,
    ),
  ).toEqual(['policy', 'study']);
  expect(
    businessGraphRows([policy, study, other], 'overview', null, 'ENTERPRISE'),
  ).toEqual([]);
});

it('keeps an observation-only time result visible without introducing rows outside it', () => {
  const observations = [
    row('june-a', 'OBSERVATION'),
    row('june-b', 'OBSERVATION'),
  ];
  expect(businessGraphRows(observations, 'overview', null)).toEqual(
    observations,
  );
  expect(businessGraphRows(observations, 'overview', null, 'POLICY')).toEqual(
    [],
  );
  expect(businessGraphRows([], 'overview', null)).toEqual([]);
});

it('shows actual source relationships when they are the entire remaining scope', () => {
  const source = row('only-source', 'DOCUMENT');
  source.candidate.qualifiers = {
    context: { recordNature: 'SOURCE_RELATION' },
  } as RelationAssertion['candidate']['qualifiers'];
  expect(businessGraphRows([source], 'overview', null)).toEqual([source]);
});
