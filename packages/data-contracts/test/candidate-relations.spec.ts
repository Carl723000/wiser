import { describe, expect, it } from 'vitest';
import {
  CandidateRelationCommandSchema,
  CandidateRelationContentSchema,
  CandidateRelationEntityReferenceSchema,
  CandidateRelationEvidenceSchema,
  CandidateRelationPinSchema,
  CandidateRelationResponsibilitySchema,
  CandidateRelationStateSchema,
} from '../src/ingestion/candidate-relations.ts';
const id = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
const content = () => ({
  subject: {
    key: 'a',
    label: 'Source object A',
    kind: 'EXTERNAL_ENTITY',
    externalId: null,
  },
  predicate: 'FLOWS_TO',
  object: {
    key: 'b',
    label: 'Source object B',
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
      applicability: 'Background',
    },
  },
  generation: { method: 'SOURCE_FIELDS', model: null },
  evidence: [
    {
      reference,
      assetId: id(3),
      sourceHash: 'b'.repeat(64),
      locator: 'row:1',
      excerpt: null,
      polarity: 'SUPPORTS',
    },
  ],
});
const revision = () => ({
  revisionId: id(4),
  relationId: id(5),
  lineageId: id(6),
  revision: 1,
  supersedesId: null,
  reference,
  mappingVersion: 'source/1',
  ruleVersion: 'candidate-relations/1',
  content: content(),
});
describe('bounded isolated candidate relation contracts', () => {
  it('rejects published source references and unknown authority fields', () => {
    expect(
      CandidateRelationEntityReferenceSchema.safeParse({
        dataItemId: id(1),
        versionId: id(2),
        mappingVersion: '1',
        entityKey: 'x',
      }).success,
    ).toBe(false);
    expect(
      CandidateRelationEvidenceSchema.safeParse({
        ...content().evidence[0],
        source: { versionId: id(1) },
      }).success,
    ).toBe(false);
    expect(
      CandidateRelationCommandSchema.safeParse({
        revisions: [revision()],
        actorId: id(7),
      }).success,
    ).toBe(false);
  });
  it('enforces all 100 command, 64 evidence, 256KiB command and 100000 byte relation limits', () => {
    expect(
      CandidateRelationCommandSchema.safeParse({
        revisions: Array.from({ length: 101 }, revision),
      }).success,
    ).toBe(false);
    expect(
      CandidateRelationContentSchema.safeParse({
        ...content(),
        evidence: Array.from({ length: 65 }, () => content().evidence[0]),
      }).success,
    ).toBe(false);
    expect(
      CandidateRelationContentSchema.safeParse({
        ...content(),
        evidence: Array.from({ length: 64 }, () => ({
          ...content().evidence[0],
          excerpt: '中'.repeat(4000),
        })),
      }).success,
    ).toBe(false);
    expect(
      CandidateRelationCommandSchema.safeParse({
        revisions: Array.from({ length: 100 }, () => ({
          ...revision(),
          content: {
            ...content(),
            evidence: [
              { ...content().evidence[0], excerpt: '中'.repeat(4000) },
            ],
          },
        })),
      }).success,
    ).toBe(false);
  });
  it('requires complete context, explicit candidate identity and bounded pin dimensions', () => {
    const value = content();
    delete (value.qualifiers as Record<string, unknown>)['context'];
    expect(CandidateRelationContentSchema.safeParse(value).success).toBe(false);
    expect(
      CandidateRelationEvidenceSchema.safeParse({
        ...content().evidence[0],
        reference: { ...reference, versionId: id(2) },
      }).success,
    ).toBe(false);
    for (const pin of [
      { relationId: id(5), revision: 0, decisionVersion: 0 },
      { relationId: id(5), revision: 1, decisionVersion: -1 },
      { relationId: id(5), revision: 1, decisionVersion: 101 },
    ])
      expect(CandidateRelationPinSchema.safeParse(pin).success).toBe(false);
    expect(
      CandidateRelationPinSchema.safeParse({
        relationId: id(5),
        revision: 1,
        decisionVersion: 0,
      }).success,
    ).toBe(true);
  });
  it('keeps confirmation separate from approval and validates trusted delegation', () => {
    expect(CandidateRelationStateSchema.safeParse('APPROVED').success).toBe(
      false,
    );
    expect(
      CandidateRelationResponsibilitySchema.safeParse({
        actorId: id(1),
        actorType: 'service',
        delegatedBy: null,
        purpose: 'candidate-review',
      }).success,
    ).toBe(false);
    expect(
      CandidateRelationResponsibilitySchema.safeParse({
        actorId: id(1),
        actorType: 'human',
        delegatedBy: id(2),
        purpose: 'candidate-review',
      }).success,
    ).toBe(false);
  });
});
