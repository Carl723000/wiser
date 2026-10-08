import { describe, expect, it } from 'vitest';
import {
  DATA_CAPABILITY_REGISTRY,
  CreateCandidateRelationsInputSchema,
  RebindCandidateRelationInputSchema,
  ListCandidateRelationsInputSchema,
} from '../src/index.ts';
import { candidateRelationPublicInputs } from './support/candidate-relations-public-fixture.ts';
const operations = [
  'create',
  'get',
  'list',
  'review',
  'withdraw',
  'rebind',
] as const;
describe('candidate relationship public command boundary', () => {
  it.each(operations)(
    'registers the separately guarded %s path',
    (operation) => {
      const registry = DATA_CAPABILITY_REGISTRY as Record<string, unknown>;
      expect(
        registry[`data.ingestion.candidate.relations.${operation}`],
      ).toMatchObject({
        version: '1.0.0',
        kind: operation === 'get' || operation === 'list' ? 'query' : 'command',
        maxSecurityLevel: 'L3_CONFIDENTIAL',
        idempotent: true,
      });
    },
  );
});

const id = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixtures = candidateRelationPublicInputs(
  {
    kind: 'ingestion-candidate',
    ingestionId: id(1),
    processingBatchId: id(2),
    reviewHash: 'a'.repeat(64),
  },
  id(3),
  id(4),
);
describe('strict candidate relation inputs', () => {
  it('does not accept caller-provided identities or submission authority', () => {
    const input = fixtures['data.ingestion.candidate.relations.create'];
    for (const field of [
      'revisionId',
      'relationId',
      'lineageId',
      'submittedByActorId',
      'decisionVersion',
    ])
      expect(
        CreateCandidateRelationsInputSchema.safeParse({
          proposals: [{ ...input.proposals[0], [field]: id(10) }],
        }).success,
      ).toBe(false);
  });
  it('keeps the 100 proposal, 64 evidence, 256 KiB and 100000 UTF-8 byte limits', () => {
    const proposal =
      fixtures['data.ingestion.candidate.relations.create'].proposals[0]!;
    expect(
      CreateCandidateRelationsInputSchema.safeParse({
        proposals: Array(101).fill(proposal),
      }).success,
    ).toBe(false);
    expect(
      CreateCandidateRelationsInputSchema.safeParse({
        proposals: [
          {
            ...proposal,
            content: {
              ...proposal.content,
              evidence: Array(65).fill(proposal.content.evidence[0]),
            },
          },
        ],
      }).success,
    ).toBe(false);
    const large = {
      ...proposal,
      content: {
        ...proposal.content,
        evidence: Array.from({ length: 16 }, () => ({
          ...proposal.content.evidence[0],
          excerpt: '汉'.repeat(4000),
        })),
      },
    };
    expect(
      CreateCandidateRelationsInputSchema.safeParse({ proposals: [large] })
        .success,
    ).toBe(false);
    const bounded = {
      ...proposal,
      content: {
        ...proposal.content,
        evidence: Array.from({ length: 4 }, () => ({
          ...proposal.content.evidence[0],
          excerpt: 'x'.repeat(4000),
        })),
      },
    };
    expect(
      CreateCandidateRelationsInputSchema.safeParse({ proposals: [bounded] })
        .success,
    ).toBe(true);
    expect(
      CreateCandidateRelationsInputSchema.safeParse({
        proposals: Array(17).fill(bounded),
      }).success,
    ).toBe(false);
  });
  it('requires nonempty exact references and an explicit mapping on every rebind', () => {
    const input = fixtures['data.ingestion.candidate.relations.rebind'];
    expect(
      RebindCandidateRelationInputSchema.safeParse({ ...input, mapping: [] })
        .success,
    ).toBe(false);
    expect(
      RebindCandidateRelationInputSchema.safeParse({ ...input, references: [] })
        .success,
    ).toBe(false);
    expect(
      RebindCandidateRelationInputSchema.safeParse({
        ...input,
        mapping: [{ ...input.mapping[0], confidence: 1 }],
      }).success,
    ).toBe(false);
    expect(
      ListCandidateRelationsInputSchema.safeParse({
        ...fixtures['data.ingestion.candidate.relations.list'],
        first: 101,
      }).success,
    ).toBe(false);
  });
});
