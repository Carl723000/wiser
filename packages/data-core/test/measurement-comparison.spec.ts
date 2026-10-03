import { describe, expect, it } from 'vitest';
import type { MeasurementDefinition } from '@wiser/data-contracts';
import {
  assessMeasurementComparison,
  type MeasurementComparisonFacts,
} from '../src/measurement-comparison.ts';

// All approvals, principal identities and support in this file are synthetic.
const evidence = {
  locator: 'synthetic definition §1',
  text: 'Synthetic measurement definition, not a real scientific approval',
};
const definition: MeasurementDefinition = {
  schemaVersion: 1,
  reference: {
    definitionId: 'synthetic-tn',
    definitionVersion: 'v1',
    sourceId: 'synthetic-source',
    sourceVersionId: 'v1',
    sourceSha256: 'a'.repeat(64),
  },
  track: 'SYNTHETIC',
  measurementType: 'CONTINUOUS',
  differenceUse: 'ALLOWED',
  sourceDeclaration: { state: 'DECLARED', evidence },
  professionalReview: {
    state: 'APPROVED',
    submittedBy: 'synthetic-proposer',
    reviewedBy: 'synthetic-independent-reviewer',
    decisionId: 'synthetic-review-1',
    evidence,
  },
  metric: {
    code: 'total-nitrogen',
    definition: 'Synthetic total nitrogen concentration',
    evidence,
  },
  unit: { code: 'mg/L', evidence },
  method: { code: 'synthetic-method', evidence },
  temporal: {
    kind: 'INSTANT',
    precision: 'MONTH',
    role: 'OBSERVATION',
    length: 1,
    basis: 'Synthetic single observation with month precision',
    evidence,
  },
  spatial: {
    kind: 'POINT',
    support: 'Synthetic single fixed sampling point',
    evidence,
  },
  aggregation: {
    rule: 'SINGLE',
    definition: 'Synthetic single observation without aggregation',
    evidence,
    denominator: {
      kind: 'NONE',
      unit: null,
      basis: 'No aggregate denominator',
      evidence,
    },
  },
};
const facts: MeasurementComparisonFacts = {
  track: 'SYNTHETIC',
  sourceTrack: 'SYNTHETIC',
  recordApproved: true,
  binding: {
    definition: definition.reference,
    track: 'SYNTHETIC',
    positionId: 'synthetic-point',
    denominator: null,
  },
  metric: 'total-nitrogen',
  unit: 'mg/L',
  method: 'synthetic-method',
  time: {
    start: '2023-04',
    end: '2023-04',
    precision: 'MONTH',
    role: 'OBSERVATION',
  },
  positionId: 'synthetic-point',
  geometryKind: 'POINT',
};
const compare = (
  a: MeasurementComparisonFacts = facts,
  b: MeasurementComparisonFacts = facts,
  definitions = [definition],
) => assessMeasurementComparison(a, b, definitions);

describe('evidenced measurement comparison eligibility', () => {
  it('allows explicit synthetic continuous point support without changing input facts', () => {
    const original = JSON.stringify([facts, definition]);
    expect(compare()).toEqual({ eligible: true, reasons: [] });
    expect(JSON.stringify([facts, definition])).toBe(original);
  });

  it.each([
    { binding: undefined },
    {
      binding: {
        ...facts.binding!,
        definition: { ...definition.reference, definitionVersion: 'absent' },
      },
    },
    {
      binding: {
        ...facts.binding!,
        definition: { ...definition.reference, sourceSha256: 'b'.repeat(64) },
      },
    },
    { binding: { ...facts.binding!, track: 'REAL' as const } },
    { track: undefined },
    { sourceTrack: undefined },
    { track: 'REAL' as const },
    { recordApproved: false },
  ])('withholds missing, mixed-track and unapproved facts: %j', (change) => {
    expect(compare({ ...facts, ...change })).toMatchObject({ eligible: false });
    expect(compare({ ...facts, ...change }).reasons).toContain('measurement');
  });

  it.each(['ORDINAL', 'CODE', 'UNKNOWN'] as const)(
    'does not infer continuous quantity from numeric %s values',
    (measurementType) => {
      const result = compare(facts, facts, [
        { ...definition, measurementType },
      ]);
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain(
        measurementType === 'UNKNOWN' ? 'measurement' : 'categorical',
      );
    },
  );

  it.each([
    { differenceUse: 'UNKNOWN' as const },
    { differenceUse: 'EVIDENCE_ONLY' as const },
    {
      sourceDeclaration: {
        ...definition.sourceDeclaration,
        state: 'UNKNOWN' as const,
      },
    },
    {
      professionalReview: {
        ...definition.professionalReview,
        state: 'PENDING_REVIEW' as const,
      },
    },
    {
      professionalReview: {
        ...definition.professionalReview,
        state: 'REJECTED' as const,
      },
    },
    {
      professionalReview: {
        ...definition.professionalReview,
        reviewedBy: null,
      },
    },
    {
      professionalReview: {
        ...definition.professionalReview,
        reviewedBy: definition.professionalReview.submittedBy,
      },
    },
    {
      professionalReview: {
        ...definition.professionalReview,
        decisionId: null,
      },
    },
    {
      professionalReview: { ...definition.professionalReview, evidence: null },
    },
  ])('separates declaration from independently approved use: %j', (change) => {
    expect(compare(facts, facts, [{ ...definition, ...change }])).toMatchObject(
      { eligible: false },
    );
  });

  it('rejects duplicate fixed definitions rather than accepting the first', () => {
    expect(compare(facts, facts, [definition, definition]).reasons).toContain(
      'measurement',
    );
    expect(
      compare(facts, facts, [
        definition,
        { ...definition, measurementType: 'CODE' },
      ]).reasons,
    ).toContain('measurement');
  });
  it('rejects a self-review identity even with accidental surrounding whitespace', () => {
    const changed = {
      ...definition,
      professionalReview: {
        ...definition.professionalReview,
        reviewedBy: ` ${definition.professionalReview.submittedBy} `,
      },
    };
    expect(compare(facts, facts, [changed]).eligible).toBe(false);
  });
  it('does not turn real source facts into a synthetic approved observation by changing the record track', () => {
    const changed = { ...facts, sourceTrack: 'REAL' as const };
    expect(compare(changed).eligible).toBe(false);
  });
  it('withholds a malformed runtime definition rather than throwing or accepting a partial reference', () => {
    expect(
      compare(facts, facts, [
        {
          ...definition,
          reference: undefined,
        } as unknown as MeasurementDefinition,
      ]).eligible,
    ).toBe(false);
  });

  it.each([
    [{ metric: 'ammonia' }, 'metric'],
    [{ unit: ' mg/L ' }, 'unit'],
    [{ unit: null }, 'unit'],
    [{ method: 'another-method' }, 'method'],
    [{ method: null }, 'method'],
    [{ positionId: 'another-point' }, 'position'],
    [{ geometryKind: 'AREA' }, 'position'],
    [{ time: { ...facts.time, role: 'PUBLICATION' } }, 'time'],
    [{ time: { ...facts.time, precision: 'DAY' } }, 'time'],
    [{ time: { ...facts.time, start: '2023-04', end: '2023-05' } }, 'time'],
    [{ time: { ...facts.time, start: null } }, 'time'],
  ] as const)(
    'checks actual record context against the fixed definition: %j',
    (change, reason) => {
      expect(compare({ ...facts, ...change }).reasons).toContain(reason);
    },
  );

  it('does not fill unknown type, support, method or rule with labels', () => {
    for (const changed of [
      {
        ...definition,
        spatial: { ...definition.spatial, support: ' unknown ' },
      },
      {
        ...definition,
        aggregation: { ...definition.aggregation, definition: ' 未知 ' },
      },
      { ...definition, unit: { ...definition.unit!, code: 'unknown' } },
      { ...definition, method: null },
    ])
      expect(compare(facts, facts, [changed]).eligible).toBe(false);
  });

  it('supports explicitly defined bounded area averages and checks their actual denominator', () => {
    const area: MeasurementDefinition = {
      ...definition,
      temporal: {
        ...definition.temporal,
        kind: 'PERIOD',
        basis: 'Inclusive calendar month',
      },
      spatial: {
        ...definition.spatial,
        kind: 'AREA',
        support: 'Synthetic fixed area average',
      },
      aggregation: {
        ...definition.aggregation,
        rule: 'WEIGHTED_MEAN',
        definition: 'Synthetic area-weighted monthly mean',
        denominator: {
          kind: 'AREA',
          unit: 'm2',
          basis: 'Synthetic valid observed area',
          evidence,
        },
      },
    };
    const average: MeasurementComparisonFacts = {
      ...facts,
      geometryKind: 'AREA',
      binding: {
        ...facts.binding!,
        denominator: {
          kind: 'AREA',
          value: 10,
          unit: 'm2',
          basis: 'Synthetic valid observed area',
          evidence,
        },
      },
    };
    expect(compare(average, average, [area]).eligible).toBe(true);
    for (const denominator of [
      null,
      { ...average.binding!.denominator!, value: 0 },
      { ...average.binding!.denominator!, value: 11 },
      { ...average.binding!.denominator!, unit: 'ha' },
      { ...average.binding!.denominator!, basis: 'unknown' },
    ]) {
      const changed = {
        ...average,
        binding: { ...average.binding!, denominator },
      };
      expect(compare(average, changed, [area]).eligible).toBe(false);
    }
    expect(
      compare(
        average,
        { ...average, time: { ...average.time, end: '2023-05' } },
        [area],
      ).reasons,
    ).toContain('time');
  });

  it('checks explicit reach means without treating geometry as the denominator', () => {
    const reach: MeasurementDefinition = {
      ...definition,
      spatial: { ...definition.spatial, kind: 'REACH' },
      aggregation: {
        ...definition.aggregation,
        rule: 'MEAN',
        denominator: {
          kind: 'OBSERVATIONS',
          unit: 'count',
          basis: 'Independent synthetic observations',
          evidence,
        },
      },
    };
    const mean: MeasurementComparisonFacts = {
      ...facts,
      geometryKind: 'REACH',
      binding: {
        ...facts.binding!,
        denominator: {
          kind: 'OBSERVATIONS',
          value: 5,
          unit: 'count',
          basis: 'Independent synthetic observations',
          evidence,
        },
      },
    };
    expect(compare(mean, mean, [reach]).eligible).toBe(true);
    expect(
      compare(
        mean,
        { ...mean, binding: { ...mean.binding!, denominator: null } },
        [reach],
      ).eligible,
    ).toBe(false);
    expect(
      compare(
        mean,
        {
          ...mean,
          binding: {
            ...mean.binding!,
            denominator: { ...mean.binding!.denominator!, value: 5.5 },
          },
        },
        [reach],
      ).eligible,
    ).toBe(false);
  });

  it('rejects invalid calendars and incompatible declared periods', () => {
    const day = {
      ...definition,
      temporal: { ...definition.temporal, precision: 'DAY' as const },
    };
    const daily = {
      ...facts,
      time: {
        ...facts.time,
        start: '2024-02-29',
        end: '2024-02-29',
        precision: 'DAY',
      },
    };
    expect(compare(daily, daily, [day]).eligible).toBe(true);
    expect(
      compare(
        {
          ...daily,
          time: { ...daily.time, start: '2023-02-29', end: '2023-02-29' },
        },
        daily,
        [day],
      ).eligible,
    ).toBe(false);
    const year = {
      ...definition,
      temporal: { ...definition.temporal, precision: 'YEAR' as const },
    };
    const annual = {
      ...facts,
      time: { ...facts.time, start: '2023', end: '2023', precision: 'YEAR' },
    };
    expect(compare(annual, annual, [year]).eligible).toBe(true);
  });
});
