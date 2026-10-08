import { describe, expect, it } from 'vitest';
import {
  CreateCandidateFollowupInputSchema,
  ActCandidateFollowupInputSchema,
  ReviewCandidateFollowupInputSchema,
} from '../src/ingestion/candidate-followups.ts';

const id = '10000000-0000-4000-8000-000000000001';
const evidence = {
  reference: {
    kind: 'ingestion-candidate',
    ingestionId: id,
    processingBatchId: id,
    reviewHash: 'a'.repeat(64),
  },
  assetId: id,
  sourceHash: 'b'.repeat(64),
  locator: `asset:${id}`,
};
const gap = {
  type: 'GAP',
  source: evidence,
  ruleId: 'missing-month',
  ruleVersion: '1.0.0',
  reason: 'Evidence is missing.',
};
const record = {
  ...evidence,
  recordId: id,
  locator: 'table:1/row:2',
  sourceCrs: 'EPSG:4326',
  geometry: {
    type: 'LineString',
    coordinates: [
      [116, 39],
      [116.1, 39.1],
    ],
  },
};

describe('bounded candidate followup contracts', () => {
  it('accepts an asset-level gap without inventing a record or coordinate', () => {
    expect(CreateCandidateFollowupInputSchema.parse(gap)).toEqual(gap);
  });
  it('requires whole-record geometry and source CRS for spatial correction', () => {
    expect(
      CreateCandidateFollowupInputSchema.safeParse({
        ...gap,
        type: 'CORRECTION',
      }).success,
    ).toBe(false);
    expect(
      CreateCandidateFollowupInputSchema.safeParse({
        ...gap,
        type: 'CORRECTION',
        source: record,
      }).success,
    ).toBe(true);
    expect(
      CreateCandidateFollowupInputSchema.safeParse({
        ...gap,
        type: 'CORRECTION',
        source: { ...record, sourceCrs: null },
      }).success,
    ).toBe(false);
  });
  it('does not accept caller-supplied actor, permissions, version or authority', () => {
    for (const key of [
      'actorId',
      'delegatedBy',
      'tenantId',
      'projectId',
      'state',
      'grant',
      'responsibilities',
    ])
      expect(
        CreateCandidateFollowupInputSchema.safeParse({ ...gap, [key]: id })
          .success,
      ).toBe(false);
  });
  it('requires explicit old/new fixed correspondence and rejects part selection', () => {
    const input = {
      followupId: id,
      expectedVersion: 2,
      action: 'SUPPLEMENT',
      note: 'Fixed source mapping.',
      evidence: [record],
      correction: {
        scope: 'WHOLE_RECORD',
        old: record,
        new: record,
        mappingReason: 'Source locator correspondence.',
      },
    };
    expect(ActCandidateFollowupInputSchema.safeParse(input).success).toBe(true);
    expect(
      ActCandidateFollowupInputSchema.safeParse({
        ...input,
        correction: {
          ...input.correction,
          scope: 'COMPONENT',
          componentIndex: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      ActCandidateFollowupInputSchema.safeParse({ ...input, evidence: [] })
        .success,
    ).toBe(false);
  });
  it('bounds evidence, reason, versions and strict action variants', () => {
    expect(
      CreateCandidateFollowupInputSchema.safeParse({
        ...gap,
        reason: 'x'.repeat(4097),
      }).success,
    ).toBe(false);
    expect(
      ActCandidateFollowupInputSchema.safeParse({
        followupId: id,
        expectedVersion: 0,
        action: 'CLAIM',
        note: 'Work.',
      }).success,
    ).toBe(false);
    expect(
      ActCandidateFollowupInputSchema.safeParse({
        followupId: id,
        expectedVersion: 2,
        action: 'REOPEN',
        note: '',
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      ReviewCandidateFollowupInputSchema.safeParse({
        followupId: id,
        expectedVersion: 3,
        decision: 'APPROVED',
        note: 'No professional decision.',
      }).success,
    ).toBe(false);
  });
});
