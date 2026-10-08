import { describe, expect, it } from 'vitest';
import {
  planCandidateFollowupTransition,
  assertIndependentCandidateFollowupReviewer,
  candidateFollowupCommandIdentity,
} from '../src/candidate-followups.ts';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const human = (n: number) => ({
  actorId: id(n),
  actorType: 'human' as const,
  delegatedBy: null,
  purpose: 'data-review',
});
const source = {
  reference: {
    kind: 'ingestion-candidate' as const,
    ingestionId: id(10),
    processingBatchId: id(11),
    reviewHash: 'a'.repeat(64),
  },
  assetId: id(12),
  sourceHash: 'b'.repeat(64),
  locator: `asset:${id(12)}`,
};
const base = {
  followupId: id(30),
  type: 'GAP' as const,
  state: 'OPEN' as const,
  rowVersion: 1,
  source,
  createdBy: human(1),
  evidence: [],
  assignee: null,
  responsibilities: [human(1)],
};
const act = (action: string, expectedVersion = 1) => ({
  followupId: id(30),
  expectedVersion,
  action,
  note: 'The evidence changed.',
});

describe('candidate followup deterministic transitions', () => {
  it('claims an open gap and preserves prior responsibility', () => {
    const next = planCandidateFollowupTransition(base, act('CLAIM'), human(2));
    expect(next.state).toBe('WORKING');
    expect(next.rowVersion).toBe(2);
    expect(next.assignee).toEqual(human(2));
    expect(next.responsibilities).toEqual([human(1), human(2)]);
  });
  it('rejects stale versions, skipped stages and work by another actor', () => {
    expect(() =>
      planCandidateFollowupTransition(base, act('CLAIM', 2), human(2)),
    ).toThrow();
    expect(() =>
      planCandidateFollowupTransition(base, act('SUBMIT_REVIEW'), human(2)),
    ).toThrow();
    const working = {
      ...base,
      state: 'WORKING' as const,
      rowVersion: 2,
      assignee: human(2),
    };
    expect(() =>
      planCandidateFollowupTransition(working, act('SUPPLEMENT', 2), human(3)),
    ).toThrow();
  });
  it('keeps the handoff target and the former assignee in the complete responsibility set', () => {
    const working = {
      ...base,
      state: 'WORKING' as const,
      rowVersion: 2,
      assignee: human(2),
      responsibilities: [human(1), human(2)],
    };
    const next = planCandidateFollowupTransition(
      working,
      { ...act('HANDOFF', 2), targetActorId: id(3) },
      human(2),
      human(3),
    );
    expect(next.assignee).toEqual(human(3));
    for (const n of [1, 2, 3])
      expect(() =>
        assertIndependentCandidateFollowupReviewer(
          human(n),
          next.responsibilities,
        ),
      ).toThrow();
    expect(() =>
      assertIndependentCandidateFollowupReviewer(
        human(4),
        next.responsibilities,
      ),
    ).not.toThrow();
  });
  it('rejects delegated, agent, service and any historical delegator review', () => {
    const responsibility = {
      actorId: id(5),
      actorType: 'agent' as const,
      delegatedBy: id(6),
      purpose: 'data-review',
    };
    expect(() =>
      assertIndependentCandidateFollowupReviewer(human(6), [
        human(1),
        responsibility,
      ]),
    ).toThrow();
    for (const actorType of ['agent', 'service'] as const)
      expect(() =>
        assertIndependentCandidateFollowupReviewer(
          { ...responsibility, actorType },
          [human(1)],
        ),
      ).toThrow();
    expect(() =>
      assertIndependentCandidateFollowupReviewer(human(4), []),
    ).toThrow();
  });
  it('closes only from review pending and can return or explicitly reopen without erasing history', () => {
    const pending = {
      ...base,
      state: 'REVIEW_PENDING' as const,
      rowVersion: 3,
      assignee: human(2),
      responsibilities: [human(1), human(2)],
    };
    const closed = planCandidateFollowupTransition(
      pending,
      {
        followupId: id(30),
        expectedVersion: 3,
        decision: 'CLOSE',
        note: 'Material checked.',
      },
      human(4),
    );
    expect(closed.state).toBe('CLOSED');
    expect(
      planCandidateFollowupTransition(
        pending,
        {
          followupId: id(30),
          expectedVersion: 3,
          decision: 'RETURN',
          note: 'Need source.',
        },
        human(4),
      ).state,
    ).toBe('WORKING');
    expect(() =>
      planCandidateFollowupTransition(closed, act('REOPEN', 4), human(4)),
    ).toThrow('RESPONSIBILITY_REQUIRED');
    expect(
      planCandidateFollowupTransition(closed, act('REOPEN', 4), human(1)).state,
    ).toBe('OPEN');
    expect(() =>
      planCandidateFollowupTransition(
        pending,
        {
          followupId: id(30),
          expectedVersion: 3,
          decision: 'CLOSE',
          note: 'Self.',
        },
        human(2),
      ),
    ).toThrow();
  });
  it('binds whole-record corrections to exact old source and newly received evidence', () => {
    const record = {
      ...source,
      recordId: id(13),
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
    const replacement = {
      ...record,
      reference: { ...source.reference, processingBatchId: id(20) },
      sourceHash: 'c'.repeat(64),
    };
    const current = {
      ...base,
      type: 'CORRECTION' as const,
      source: record,
      state: 'WORKING' as const,
      rowVersion: 2,
      assignee: human(2),
    };
    const input = {
      ...act('SUPPLEMENT', 2),
      evidence: [replacement],
      correction: {
        scope: 'WHOLE_RECORD',
        old: record,
        new: replacement,
        mappingReason: 'Whole source record correspondence.',
      },
    };
    expect(
      planCandidateFollowupTransition(current, input, human(2)).evidence,
    ).toEqual([replacement]);
    expect(() =>
      planCandidateFollowupTransition(
        current,
        {
          ...input,
          correction: {
            ...input.correction,
            old: { ...record, locator: 'other' },
          },
        },
        human(2),
      ),
    ).toThrow();
    expect(() =>
      planCandidateFollowupTransition(
        current,
        { ...input, evidence: [record] },
        human(2),
      ),
    ).toThrow();
  });
  it('same idempotency input binds actor type, delegator and purpose', () => {
    const input = act('CLAIM');
    const first = candidateFollowupCommandIdentity(input, human(2));
    expect(
      candidateFollowupCommandIdentity(input, {
        ...human(2),
        purpose: 'data-maintenance',
      }),
    ).not.toBe(first);
    expect(
      candidateFollowupCommandIdentity(input, {
        ...human(2),
        actorType: 'agent',
        delegatedBy: id(1),
      }),
    ).not.toBe(first);
  });
});

describe('candidate followup UUID spelling invariance', () => {
  const proof = {
    ...source,
    reference: {
      ...source.reference,
      ingestionId: 'abcdefab-cdef-4abc-8abc-abcdefabcdef',
      processingBatchId: 'bcdefabc-defa-4bcd-8bcd-bcdefabcdefa',
    },
    assetId: 'cdefabcd-efab-4cde-8cde-cdefabcdefab',
    recordId: 'defabcde-fabc-4def-8def-defabcdefabc',
    locator: 'Table:A/Row:B',
  };
  const upper = {
    ...proof,
    reference: {
      ...proof.reference,
      ingestionId: proof.reference.ingestionId.toUpperCase(),
      processingBatchId: proof.reference.processingBatchId.toUpperCase(),
    },
    assetId: proof.assetId.toUpperCase(),
    recordId: proof.recordId.toUpperCase(),
  };
  it('rejects case-only duplicate source proof without changing its literal locator', () => {
    const current = {
      ...base,
      source: proof,
      state: 'WORKING',
      rowVersion: 2,
      assignee: human(2),
    };
    expect(() =>
      planCandidateFollowupTransition(
        current,
        { ...act('SUPPLEMENT', 2), evidence: [upper] },
        human(2),
      ),
    ).toThrow('DUPLICATE_EVIDENCE');
  });
  it('canonicalizes create and supplement command identity while retaining literal evidence', () => {
    for (const command of [
      {
        type: 'GAP',
        source: proof,
        ruleId: 'source-rule',
        ruleVersion: '1',
        reason: 'Missing proof',
      },
      { ...act('SUPPLEMENT'), evidence: [proof] },
    ]) {
      const spelling =
        'source' in command
          ? { ...command, source: upper }
          : { ...command, evidence: [upper] };
      expect(candidateFollowupCommandIdentity(command, human(2))).toBe(
        candidateFollowupCommandIdentity(spelling, human(2)),
      );
      const changed =
        'source' in command
          ? { ...command, source: { ...upper, locator: 'table:a/row:b' } }
          : { ...command, evidence: [{ ...upper, locator: 'table:a/row:b' }] };
      expect(candidateFollowupCommandIdentity(command, human(2))).not.toBe(
        candidateFollowupCommandIdentity(changed, human(2)),
      );
    }
  });
});
