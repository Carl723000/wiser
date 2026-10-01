import { describe, expect, it } from 'vitest';
import type { WorkspaceRecord } from './spatial-workspace-contract';
import {
  decideCandidate,
  regenerateCandidates,
  syntheticReviewRecord,
} from './spatial-candidate-review';

describe('local candidate decisions', () => {
  it('allows only explicitly synthetic exercise decisions and retains a local decision version', () => {
    const record = syntheticReviewRecord();
    const decision = decideCandidate(record, [], {
      positionId: record.positions[0].id,
      action: 'accept',
      reason: 'The source states the district',
      decisionVersion: 'd1',
    });
    expect(decision.synthetic).toBe(true);
    expect(decision.reason).toBe('The source states the district');
    expect(decision.decisionVersion).toBe('d1');
    expect(decision.recordId).toBe(record.id);
  });
  it('does not promote real pending candidates to professional approval', () => {
    const record: WorkspaceRecord = {
      ...syntheticReviewRecord(),
      reviewStatus: 'pending',
      id: 'real',
    };
    expect(() =>
      decideCandidate(record, [], {
        positionId: record.positions[0].id,
        action: 'accept',
        reason: 'Approved',
        decisionVersion: 'd1',
      }),
    ).toThrow('REAL_CANDIDATE_READ_ONLY');
    expect(record.reviewStatus).toBe('pending');
  });
  it('requires a reason and a fixed version, and rejects unknown positions', () => {
    const record = syntheticReviewRecord();
    expect(() =>
      decideCandidate(record, [], {
        positionId: record.positions[0].id,
        action: 'exclude',
        reason: ' ',
        decisionVersion: 'd1',
      }),
    ).toThrow('REASON_REQUIRED');
    expect(() =>
      decideCandidate(record, [], {
        positionId: 'other',
        action: 'pending',
        reason: 'Unclear',
        decisionVersion: 'd1',
      }),
    ).toThrow('POSITION_NOT_FOUND');
    expect(() =>
      decideCandidate(record, [], {
        positionId: record.positions[0].id,
        action: 'accept',
        reason: 'Found',
        decisionVersion: '',
      }),
    ).toThrow('DECISION_VERSION_REQUIRED');
  });
  it('regenerates selected positions without changing the source or authoritative object identity', () => {
    const record = syntheticReviewRecord();
    const frozen = JSON.stringify(record);
    const decision = decideCandidate(record, [], {
      positionId: record.positions[0].id,
      action: 'exclude',
      reason: 'Institutional address',
      decisionVersion: 'd1',
    });
    const output = regenerateCandidates(record, [decision]);
    expect(output.positions).toHaveLength(record.positions.length - 1);
    expect(output.objectId).toBe(record.objectId);
    expect(JSON.stringify(record)).toBe(frozen);
    expect(output.reviewStatus).toBe('synthetic-reviewed');
  });
  it('ignores stale or differently bound decisions and preserves pending positions', () => {
    const record = syntheticReviewRecord();
    const decision = decideCandidate(record, [], {
      positionId: record.positions[0].id,
      action: 'exclude',
      reason: 'Other scope',
      decisionVersion: 'd1',
    });
    expect(
      regenerateCandidates(record, [{ ...decision, versionId: 'old' }])
        .positions,
    ).toEqual(record.positions);
    const pending = { ...decision, action: 'pending' as const };
    expect(regenerateCandidates(record, [pending]).positions[0].match).toBe(
      'candidate',
    );
  });
});
