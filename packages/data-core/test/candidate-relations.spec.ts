import { describe, expect, it } from 'vitest';
import { validateCandidateRelationRevision } from '../src/candidate-relations.ts';

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
export const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: id('1'),
  processingBatchId: id('2'),
  reviewHash: 'a'.repeat(64),
};
export const relationFixture = () => ({
  revisionId: id('3'),
  relationId: id('4'),
  lineageId: id('5'),
  revision: 1,
  supersedesId: null,
  reference,
  mappingVersion: 'source-watercourse/1',
  ruleVersion: 'candidate-relations/1',
  content: {
    subject: {
      key: 'upstream',
      label: 'Synthetic upstream',
      kind: 'EXTERNAL_ENTITY',
      externalId: null,
    },
    predicate: 'FLOWS_TO',
    object: {
      key: 'downstream',
      label: 'Synthetic downstream',
      kind: 'EXTERNAL_ENTITY',
      externalId: null,
    },
    qualifiers: {
      measure: null,
      unit: null,
      observedAt: null,
      missing: false,
      spatialScope: null,
      limitations: [],
      reportedConclusion: null,
      context: {
        recordNature: 'SOURCE_RELATION',
        timeRole: 'PUBLICATION_TIME',
        validFrom: null,
        validTo: null,
        locationRole: 'REFERENCE_LOCATION',
        applicability: 'Watercourse background only',
      },
    },
    generation: { method: 'SOURCE_FIELDS', model: null },
    evidence: [
      {
        reference,
        assetId: id('6'),
        sourceHash: 'b'.repeat(64),
        locator: 'table:1/row:1',
        excerpt: 'Synthetic watercourse',
        polarity: 'SUPPORTS',
      },
    ],
  },
});
describe('strict isolated candidate relation semantics', () => {
  it('preserves a source-local legacy predicate with explicit context', () => {
    expect(
      validateCandidateRelationRevision(relationFixture()).content.predicate,
    ).toBe('FLOWS_TO');
  });
  it('requires context for legacy predicates instead of taking the old early return', () => {
    const value = relationFixture();
    delete (value.content.qualifiers as Record<string, unknown>)['context'];
    expect(() => validateCandidateRelationRevision(value)).toThrow();
  });
  it('rejects observation time on a source relation for legacy predicates', () => {
    const value = relationFixture();
    value.content.qualifiers.context.timeRole = 'OBSERVATION_TIME';
    expect(() => validateCandidateRelationRevision(value)).toThrow();
  });
});

import {
  assertCandidateRelationDecisionTransition,
  assertIndependentCandidateRelationReviewer,
  candidateRelationCommandIdentity,
  candidateRelationWithdrawalAllowed,
} from '../src/candidate-relations.ts';
const human = (actorId = id('7')) => ({
  actorId,
  actorType: 'human' as const,
  delegatedBy: null,
  purpose: 'candidate-review',
});
const responsibilities = () => [
  { actorId: id('8'), actorType: 'human', delegatedBy: null },
  { actorId: id('9'), actorType: 'agent', delegatedBy: id('1') },
];
describe('fixed submission identity and independent decision versions', () => {
  it('excludes all relationship and source submitters and delegators including equivalent UUID case', () => {
    for (const actorId of [id('8'), id('9'), id('1')])
      expect(() =>
        assertIndependentCandidateRelationReviewer(
          human(actorId.toUpperCase()),
          responsibilities(),
        ),
      ).toThrow();
    expect(() =>
      assertIndependentCandidateRelationReviewer(human(), responsibilities()),
    ).not.toThrow();
  });
  it('rejects service, agent and delegated human decisions', () => {
    for (const actorType of ['agent', 'service', 'human'])
      expect(() =>
        assertIndependentCandidateRelationReviewer(
          { ...human(), actorType, delegatedBy: id('2') },
          responsibilities(),
        ),
      ).toThrow();
  });
  it('requires complete frozen responsibility rather than trusting an empty exclusion set', () => {
    expect(() =>
      assertIndependentCandidateRelationReviewer(human(), []),
    ).toThrow();
    expect(() =>
      assertIndependentCandidateRelationReviewer(human(), [
        responsibilities()[0],
      ]),
    ).toThrow();
    expect(() =>
      assertIndependentCandidateRelationReviewer(human(), [
        ...responsibilities(),
        { actorId: id('2'), actorType: 'service', delegatedBy: null },
      ]),
    ).toThrow();
  });
  it('keeps content revisions and decision versions separate and distinguishes revocation from withdrawal', () => {
    for (const next of [
      'CONFIRMED',
      'REJECTED',
      'CORRECTION_REQUIRED',
      'WITHDRAWN',
    ] as const)
      expect(() =>
        assertCandidateRelationDecisionTransition('PENDING_REVIEW', next, 0),
      ).not.toThrow();
    expect(() =>
      assertCandidateRelationDecisionTransition('CONFIRMED', 'REVOKED', 1),
    ).not.toThrow();
    for (const [from, to] of [
      ['CONFIRMED', 'REJECTED'],
      ['CONFIRMED', 'WITHDRAWN'],
      ['REJECTED', 'CONFIRMED'],
      ['REVOKED', 'CONFIRMED'],
      ['PENDING_REVIEW', 'REVOKED'],
    ] as const)
      expect(() =>
        assertCandidateRelationDecisionTransition(from, to, 1),
      ).toThrow();
    expect(() =>
      assertCandidateRelationDecisionTransition(
        'PENDING_REVIEW',
        'CONFIRMED',
        100,
      ),
    ).toThrow();
  });
  it('allows withdrawal only by the immutable responsible proposer or its human delegator', () => {
    const submitter = {
      ...human(id('8')),
      actorType: 'agent',
      delegatedBy: id('1'),
    };
    expect(candidateRelationWithdrawalAllowed(human(id('1')), submitter)).toBe(
      true,
    );
    expect(
      candidateRelationWithdrawalAllowed({ ...submitter }, submitter),
    ).toBe(true);
    expect(candidateRelationWithdrawalAllowed(human(), submitter)).toBe(false);
    expect(
      candidateRelationWithdrawalAllowed(
        { ...submitter, actorId: id('9') },
        submitter,
      ),
    ).toBe(false);
  });
  it('binds command identity to actor, delegation and purpose and canonicalizes UUID aliases', () => {
    const command = { revisions: [relationFixture()] };
    const key = candidateRelationCommandIdentity(command, human());
    expect(
      candidateRelationCommandIdentity(command, {
        ...human(),
        actorId: human().actorId.toUpperCase(),
      }),
    ).toBe(key);
    expect(candidateRelationCommandIdentity(command, human(id('8')))).not.toBe(
      key,
    );
    expect(
      candidateRelationCommandIdentity(command, {
        ...human(),
        purpose: 'another-purpose',
      }),
    ).not.toBe(key);
    expect(
      candidateRelationCommandIdentity(command, {
        ...human(),
        actorType: 'agent',
        delegatedBy: id('8'),
      }),
    ).not.toBe(key);
    expect(() =>
      candidateRelationCommandIdentity(
        { revisions: [relationFixture(), relationFixture()] },
        human(),
      ),
    ).toThrow();
  });
  it('accepts explicit next content revision and rejects missing predecessor', () => {
    const value = relationFixture();
    value.revision = 2;
    expect(() => validateCandidateRelationRevision(value)).toThrow();
    expect(
      validateCandidateRelationRevision({ ...value, supersedesId: id('3') })
        .revision,
    ).toBe(2);
  });
  it('preserves reported blanks and empty strings without manufacturing numerical observations', () => {
    const value = relationFixture();
    Object.assign(value.content.qualifiers, {
      reportedValue: '  ',
      reportedLimit: '',
    });
    const parsed = validateCandidateRelationRevision(value);
    expect(parsed.content.qualifiers.reportedValue).toBe('  ');
    expect(parsed.content.qualifiers.reportedLimit).toBe('');
  });
  it('does not attach ordinary source-local relationships to an unrelated candidate', () => {
    const value = relationFixture();
    value.content.evidence[0]!.reference = {
      ...reference,
      processingBatchId: id('9'),
    };
    expect(() => validateCandidateRelationRevision(value)).toThrow();
  });
  it('requires distinct candidate endpoints and evidence for both identity sources', () => {
    const value = relationFixture();
    value.content.predicate = 'IDENTITY_MATCH';
    const other = { ...reference, processingBatchId: id('9') };
    const content = {
      ...value.content,
      subject: {
        ...value.content.subject,
        reference: {
          reference,
          mappingVersion: value.mappingVersion,
          entityKey: 'upstream',
        },
      },
      object: {
        ...value.content.object,
        reference: {
          reference: other,
          mappingVersion: value.mappingVersion,
          entityKey: 'downstream',
        },
      },
    };
    expect(() =>
      validateCandidateRelationRevision({ ...value, content }),
    ).toThrow();
    const withBoth = {
      ...content,
      evidence: [
        ...content.evidence,
        { ...content.evidence[0]!, reference: other },
      ],
    };
    expect(
      validateCandidateRelationRevision({ ...value, content: withBoth }).content
        .predicate,
    ).toBe('IDENTITY_MATCH');
    expect(() =>
      validateCandidateRelationRevision({
        ...value,
        content: {
          ...withBoth,
          object: { ...withBoth.object, reference: withBoth.subject.reference },
        },
      }),
    ).toThrow();
    expect(() =>
      validateCandidateRelationRevision({
        ...value,
        content: {
          ...withBoth,
          subject: { ...withBoth.subject, kind: 'DOCUMENT' },
          object: { ...withBoth.object, kind: 'DOCUMENT' },
        },
      }),
    ).toThrow();
  });
});
