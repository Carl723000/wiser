import { describe, expect, it } from 'vitest';
import { isIndependentIngestionReviewer } from '../src/ingestion/index.js';

const actor = 'a0000000-0000-4000-8000-000000000001';
const other = 'a0000000-0000-4000-8000-000000000002';

describe('independent ingestion reviewer identity', () => {
  it('does not turn the same valid UUID into another reviewer by changing letter case', () => {
    expect(
      isIndependentIngestionReviewer(
        { actorId: actor.toUpperCase(), actorType: 'human' },
        { actorId: actor, actorType: 'human' },
      ),
    ).toBe(false);
    expect(
      isIndependentIngestionReviewer(
        { actorId: actor.toUpperCase(), actorType: 'human' },
        { actorId: other, actorType: 'agent', delegatedBy: actor },
      ),
    ).toBe(false);
  });

  it('retains independent review for another human and fails closed for invalid identity', () => {
    const submission = { actorId: actor, actorType: 'human' };
    expect(
      isIndependentIngestionReviewer(
        { actorId: other.toUpperCase(), actorType: 'human' },
        submission,
      ),
    ).toBe(true);
    expect(
      isIndependentIngestionReviewer(
        { actorId: 'not-a-uuid', actorType: 'human' },
        submission,
      ),
    ).toBe(false);
    expect(
      isIndependentIngestionReviewer(
        { actorId: other, actorType: 'agent' },
        submission,
      ),
    ).toBe(false);
  });
});
