import { describe, expect, it } from 'vitest';
import {
  MeasurementBindingSchema,
  MeasurementDefinitionReferenceSchema,
  MeasurementReviewSchema,
} from '../src/index.ts';

const reference = {
  definitionId: 'source-local-metric',
  definitionVersion: 'definition-v1',
  sourceId: 'source-local-original',
  sourceVersionId: 'original-v1',
  sourceSha256: 'a'.repeat(64),
};
describe('measurement context contracts', () => {
  it('retains source-local identifiers and fixed hashes without inventing authority UUIDs', () => {
    expect(MeasurementDefinitionReferenceSchema.parse(reference)).toEqual(
      reference,
    );
    for (const extra of [
      { sourceSha256: 'A'.repeat(64) },
      { sourceSha256: 'absent' },
      { sourceVersionId: '' },
      { authorityId: 'injected' },
    ])
      expect(
        MeasurementDefinitionReferenceSchema.safeParse({
          ...reference,
          ...extra,
        }).success,
      ).toBe(false);
  });
  it('keeps original evidence and unit strings rather than silently normalizing values', () => {
    const binding = {
      definition: reference,
      track: 'SYNTHETIC',
      positionId: 'position-1',
      denominator: {
        kind: 'AREA',
        value: 2,
        unit: ' m2 ',
        basis: ' original basis ',
        evidence: { locator: ' row 1 ', text: ' original text ' },
      },
    };
    expect(MeasurementBindingSchema.parse(binding)).toEqual(binding);
    for (const value of [0, -1, Infinity, NaN])
      expect(
        MeasurementBindingSchema.safeParse({
          ...binding,
          denominator: { ...binding.denominator, value },
        }).success,
      ).toBe(false);
  });
  it('does not turn source declaration into an independent review decision', () => {
    const pending = {
      state: 'PENDING_REVIEW',
      submittedBy: 'submitter',
      reviewedBy: null,
      decisionId: null,
      evidence: null,
    };
    expect(MeasurementReviewSchema.parse(pending)).toEqual(pending);
    expect(
      MeasurementReviewSchema.safeParse({ ...pending, approved: true }).success,
    ).toBe(false);
  });
});
