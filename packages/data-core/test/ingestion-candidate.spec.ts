import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

const reference = {
  kind: 'ingestion-candidate',
  ingestionId: '10000000-0000-4000-8000-000000000001',
  reviewHash: 'a'.repeat(64),
  processingBatchId: '10000000-0000-4000-8000-000000000002',
};
const original = {
  assetId: '10000000-0000-4000-8000-000000000003',
  sourceHash: 'b'.repeat(64),
};
const policy = { mode: 'REQUIRE_INDEPENDENT_REVIEW', revision: 3 };
const current = {
  ingestionId: reference.ingestionId,
  state: 'REVIEW_REQUIRED',
  reviewHash: reference.reviewHash,
  processingBatchId: reference.processingBatchId,
  reviewGovernance: { frozen: policy, current: policy },
  assets: [original],
};
const batch = {
  reference,
  parserVersion: '1.0.0',
  status: 'READY',
  assets: [
    {
      ...original,
      status: 'READY',
      recordCount: 1,
      featureCount: 0,
      reason: null,
    },
  ],
  createdAt: '2026-10-03T10:00:00Z',
};

describe('ingestion candidate fixed-input boundary', () => {
  it('accepts a completed parse from the same current review checkpoint', () => {
    expect(core.matchesFrozenIngestionCandidate(current, batch)).toBe(true);
  });
  it.each([
    'RECEIVED',
    'FAILED',
    'CANCELLED',
    'REJECTED',
    'APPROVED',
    'COMMITTED',
    'PUBLISHED',
  ])('denies stale candidate processing after state changes to %s', (state) => {
    expect(
      core.matchesFrozenIngestionCandidate({ ...current, state }, batch),
    ).toBe(false);
  });
  it('denies policy withdrawal, revision change and unknown governance context', () => {
    for (const reviewGovernance of [
      undefined,
      {},
      { frozen: policy, current: { ...policy, revision: 4 } },
      { frozen: policy, current: undefined },
    ]) {
      expect(
        core.matchesFrozenIngestionCandidate(
          { ...current, reviewGovernance },
          batch,
        ),
      ).toBe(false);
    }
  });
  it('pins both processing identity and the original bytes, not a same-name substitute', () => {
    for (const changed of [
      { reviewHash: 'c'.repeat(64) },
      { ingestionId: original.assetId },
      { processingBatchId: original.assetId },
      { assets: [{ ...original, sourceHash: 'c'.repeat(64) }] },
      { assets: [{ ...original, assetId: reference.ingestionId }] },
      { assets: [] },
      { assets: [original, original] },
    ]) {
      expect(
        core.matchesFrozenIngestionCandidate({ ...current, ...changed }, batch),
      ).toBe(false);
    }
  });
  it('keeps partial and unavailable parse results usable as evidence of missing content', () => {
    for (const candidate of [
      {
        ...batch,
        status: 'PARTIAL',
        assets: [
          { ...batch.assets[0], status: 'PARTIAL', reason: 'PARTIAL_PARSE' },
        ],
      },
      {
        ...batch,
        status: 'UNAVAILABLE',
        assets: [
          {
            ...batch.assets[0],
            status: 'UNSUPPORTED',
            recordCount: null,
            featureCount: null,
            reason: 'UNSUPPORTED_FORMAT',
          },
        ],
      },
    ])
      expect(core.matchesFrozenIngestionCandidate(current, candidate)).toBe(
        true,
      );
    expect(
      core.matchesFrozenIngestionCandidate(current, {
        ...batch,
        reference: { ...reference, versionId: original.assetId },
      }),
    ).toBe(false);
  });
});
