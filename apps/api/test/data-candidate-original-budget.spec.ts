import { describe, expect, it } from 'vitest';
import {
  CandidateOriginalBudget,
  DEFAULT_CANDIDATE_ORIGINAL_BUDGET_LIMITS,
} from '../src/data-foundation/candidate-original-budget.js';

const owner = {
  tenantId: 'tenant-a',
  projectId: 'project-a',
  responsibleActorId: 'human-a',
};

describe('candidate original instance admission', () => {
  it('bounds both active requests and aggregate buffered bytes', () => {
    expect(DEFAULT_CANDIDATE_ORIGINAL_BUDGET_LIMITS).toEqual({
      maxBytes: 128 * 1024 * 1024,
      maxActive: 4,
      maxPerResponsible: 2,
    });
    const byteLimited = new CandidateOriginalBudget({
      maxBytes: 3,
      maxActive: 4,
      maxPerResponsible: 2,
    });
    const first = byteLimited.tryReserve({ ...owner, sizeBytes: 2 });
    expect(first).not.toBeNull();
    expect(
      byteLimited.tryReserve({
        ...owner,
        responsibleActorId: 'human-b',
        sizeBytes: 2,
      }),
    ).toBeNull();
    first?.();
    expect(
      byteLimited.tryReserve({
        ...owner,
        responsibleActorId: 'human-b',
        sizeBytes: 2,
      }),
    ).not.toBeNull();

    const activeLimited = new CandidateOriginalBudget({
      maxBytes: 128,
      maxActive: 2,
      maxPerResponsible: 1,
    });
    const a = activeLimited.tryReserve({ ...owner, sizeBytes: 1 });
    const b = activeLimited.tryReserve({
      ...owner,
      responsibleActorId: 'human-b',
      sizeBytes: 1,
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(
      activeLimited.tryReserve({
        ...owner,
        responsibleActorId: 'human-c',
        sizeBytes: 1,
      }),
    ).toBeNull();
    a?.();
    expect(
      activeLimited.tryReserve({
        ...owner,
        responsibleActorId: 'human-c',
        sizeBytes: 1,
      }),
    ).not.toBeNull();
  });

  it('shares a responsible subject limit and releases out of order only once', () => {
    const budget = new CandidateOriginalBudget({
      maxBytes: 8,
      maxActive: 4,
      maxPerResponsible: 2,
    });
    const a = budget.tryReserve({ ...owner, sizeBytes: 2 });
    const b = budget.tryReserve({ ...owner, sizeBytes: 2 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(budget.tryReserve({ ...owner, sizeBytes: 1 })).toBeNull();
    a?.();
    a?.();
    const c = budget.tryReserve({ ...owner, sizeBytes: 1 });
    expect(c).not.toBeNull();
    expect(budget.tryReserve({ ...owner, sizeBytes: 1 })).toBeNull();
    b?.();
    c?.();
    expect(budget.tryReserve({ ...owner, sizeBytes: 8 })).not.toBeNull();
  });

  it('fails closed for non-finite and oversized authorized lengths', () => {
    const budget = new CandidateOriginalBudget();
    for (const sizeBytes of [0, NaN, Infinity, 32 * 1024 * 1024 + 1])
      expect(() => budget.tryReserve({ ...owner, sizeBytes })).toThrow();
  });
});
