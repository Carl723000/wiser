import { describe, expect, it } from 'vitest';
import { groupRelationCandidates } from '../src/knowledge-relations.js';

const entity = (key: string, label = key) => ({
  key,
  label,
  kind: 'MONITORING_POINT',
  externalId: null,
});
const evidence = (locator: string, polarity = 'SUPPORTS') => ({
  assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceHash: 'a'.repeat(64),
  locator,
  excerpt: null,
  polarity,
});
const candidate = () => ({
  subject: entity('enterprise:1'),
  predicate: 'HAS_DECLARED_MONITORING_POINT',
  object: entity('point:1'),
  qualifiers: {
    measure: null,
    unit: null,
    observedAt: null,
    missing: true,
    spatialScope: null,
    limitations: ['Source-local identity only'],
    reportedConclusion: null,
  },
  generation: { method: 'SOURCE_TABLE', model: null },
  evidence: [evidence('page 1, row 1')],
  supersedesId: null,
});

describe('source-scoped business relation candidates', () => {
  it('rejects inconsistent attributes of the same source identity across different triples', () => {
    const first = candidate(),
      second = {
        ...candidate(),
        subject: entity(first.subject.key, 'Different name'),
        object: entity('point:2'),
      };
    expect(() => groupRelationCandidates([first, second])).toThrow(
      'Conflicting source entity',
    );
  });
  it('retains all 24 source locations of a real-world-sized shared monitoring point', () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({
      ...candidate(),
      evidence: [evidence(`page 1 row ${i + 1}`)],
    }));
    expect(groupRelationCandidates(rows)[0]?.candidate.evidence).toHaveLength(
      24,
    );
  });
  it('counts one triple with two supporting locations rather than two relations', () => {
    const first = candidate(),
      second = { ...candidate(), evidence: [evidence('page 2, row 4')] };
    const grouped = groupRelationCandidates([first, second, first]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.candidate.evidence).toHaveLength(2);
    expect(groupRelationCandidates([second, first])).toEqual(grouped);
  });
  it('preserves contradictory evidence, unknown units and external targets without inventing location', () => {
    const row = {
      ...candidate(),
      object: { ...entity('outside:154'), externalId: 'HydroRIVERS:154' },
      evidence: [evidence('page 1'), evidence('page 2', 'CONTRADICTS')],
    };
    const [result] = groupRelationCandidates([row]);
    expect(result?.candidate.object.externalId).toBe('HydroRIVERS:154');
    expect(result?.candidate.qualifiers.unit).toBeNull();
    expect(result?.candidate.evidence.map((e) => e.polarity)).toContain(
      'CONTRADICTS',
    );
    expect(result?.candidate.object).not.toHaveProperty('geometry');
  });
  it('keeps same-name distinct identities separate and refuses conflicting attributes for one key', () => {
    const first = candidate(),
      second = { ...candidate(), object: entity('point:2', 'point:1') };
    expect(groupRelationCandidates([first, second])).toHaveLength(2);
    expect(() =>
      groupRelationCandidates([
        first,
        { ...first, object: entity('point:1', 'Different') },
      ]),
    ).toThrow(/Conflicting/);
  });
  it('requires a saved-source hash and an explicit evidence locator', () => {
    expect(() =>
      groupRelationCandidates([
        {
          ...candidate(),
          evidence: [{ ...evidence(''), sourceHash: 'unverified' }],
        },
      ]),
    ).toThrow();
  });
});

describe('typed cross-domain relation candidates', () => {
  const expert = () => ({
    ...candidate(),
    subject: { ...entity('person:qu'), kind: 'PERSON', label: '曲久辉' },
    predicate: 'EXPRESSES_CLAIM',
    object: { ...entity('claim:four-waters'), kind: 'CLAIM' },
    qualifiers: {
      ...candidate().qualifiers,
      context: {
        recordNature: 'EXPERT_VIEW',
        timeRole: 'STATEMENT_TIME',
        validFrom: null,
        validTo: null,
        locationRole: 'SUBJECT_AREA',
        applicability: '永定河治理讨论；不得当作监测结果',
      },
    },
  });
  it('accepts a source-bound expert view without converting it into an observation', () => {
    const [row] = groupRelationCandidates([expert()]);
    expect(row?.candidate.predicate).toBe('EXPRESSES_CLAIM');
    expect(row?.candidate.qualifiers.context?.recordNature).toBe('EXPERT_VIEW');
    expect(row?.candidate.qualifiers.observedAt).toBeNull();
  });
  it('requires an explicit nature and applicability for new knowledge relations', () => {
    const row = expert();
    const qualifiers = candidate().qualifiers;
    expect(() => groupRelationCandidates([{ ...row, qualifiers }])).toThrow();
  });
  it('rejects using a monitoring point as a speaker', () => {
    expect(() =>
      groupRelationCandidates([{ ...expert(), subject: entity('point:1') }]),
    ).toThrow();
  });
  it('keeps an event and a research claim as different nodes about the same water body', () => {
    const about = (key: string, kind: string) => ({
      ...expert(),
      subject: { ...entity(key), kind },
      predicate: 'ABOUT_ENTITY',
      object: { ...entity('river:yongding'), kind: 'RIVER_REACH' },
    });
    expect(
      groupRelationCandidates([
        about('event:2020', 'EVENT'),
        about('claim:2021', 'CLAIM'),
      ]),
    ).toHaveLength(2);
  });
  it('does not allow new person nodes to misuse legacy river relations', () => {
    expect(() =>
      groupRelationCandidates([{ ...expert(), predicate: 'FLOWS_TO' }]),
    ).toThrow();
  });
  it('rejects treating a planning target as an observed sampling time', () => {
    const row = expert();
    row.qualifiers.context.recordNature = 'PLANNING_TARGET';
    row.qualifiers.context.timeRole = 'OBSERVATION_TIME';
    expect(() => groupRelationCandidates([row])).toThrow();
  });
  it('refuses arbitrary model-invented predicates', () => {
    expect(() =>
      groupRelationCandidates([
        { ...expert(), predicate: 'PROVES_CAUSAL_EFFECT' },
      ]),
    ).toThrow();
  });
});

describe('explicit source entity references', () => {
  const ref = (suffix: string) => ({
    dataItemId: `10000000-0000-4000-8000-00000000000${suffix}`,
    versionId: `20000000-0000-4000-8000-00000000000${suffix}`,
    mappingVersion: 'expert-v1',
    entityKey: 'person:wang',
  });
  const match = () => ({
    ...candidate(),
    subject: { ...entity('left'), kind: 'PERSON', reference: ref('1') },
    object: { ...entity('right'), kind: 'PERSON', reference: ref('2') },
    predicate: 'IDENTITY_MATCH',
    qualifiers: {
      ...candidate().qualifiers,
      context: {
        recordNature: 'SOURCE_RELATION',
        timeRole: 'UNKNOWN',
        validFrom: null,
        validTo: null,
        locationRole: 'UNKNOWN',
        applicability: 'Identity hypothesis, requires source comparison',
      },
    },
  });
  it('preserves two source identities instead of coalescing equal labels', () => {
    const [value] = groupRelationCandidates([match()]);
    expect(value?.candidate.subject.reference?.versionId).not.toBe(
      value?.candidate.object.reference?.versionId,
    );
    expect(value?.candidate.predicate).toBe('IDENTITY_MATCH');
  });
  it('refuses a cross-reference hidden in an ordinary predicate', () => {
    expect(() =>
      groupRelationCandidates([{ ...match(), predicate: 'ABOUT_ENTITY' }]),
    ).toThrow();
  });
  it('requires two distinct source references and matching kinds', () => {
    const value = match();
    expect(() =>
      groupRelationCandidates([
        {
          ...value,
          object: { ...value.object, reference: value.subject.reference },
        },
      ]),
    ).toThrow();
    expect(() =>
      groupRelationCandidates([
        { ...value, object: { ...value.object, kind: 'ORGANIZATION' } },
      ]),
    ).toThrow();
    expect(() =>
      groupRelationCandidates([
        { ...value, object: { ...value.object, reference: undefined } },
      ]),
    ).toThrow();
  });
});
