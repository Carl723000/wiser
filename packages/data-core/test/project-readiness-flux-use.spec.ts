import { describe, expect, it } from 'vitest';
import {
  calculateProjectReadiness,
  readinessRecordKey,
  type ProjectReadinessInput,
  type ProjectReadinessRecord,
  type ProjectReadinessSource,
  type ReadinessEvidence,
} from '../src/project-readiness.js';

// These two versioned fixture method definitions apply only to SYNTHETIC.
// They never approve REAL methods, grant Auth, publish or calculate a flux.
// General method definitions and period integration have no readiness carrier.
const definitions = {
  concentration: {
    code: 'NH3-N',
    kind: 'CONCENTRATION',
    unit: 'mg/L',
    method: 'synthetic-colorimetry-v1',
  },
  flow: {
    code: 'DISCHARGE',
    kind: 'FLOW',
    unit: 'm3/s',
    method: 'synthetic-current-meter-v1',
  },
} as const;

function fixture(): ProjectReadinessInput {
  const source: ProjectReadinessSource = {
    workId: 'SYNTHETIC-bohai-paired-observation',
    versionId: 'synthetic-fixed-v1',
    assetId: 'sha256:' + 'a'.repeat(64),
    track: 'SYNTHETIC',
    kind: 'TABLE',
    needIds: ['K5-001'],
    regionIds: ['bohai'],
  };
  const evidence: ReadinessEvidence = {
    source,
    locator: 'synthetic:definition:v1',
    excerpt:
      'SYNTHETIC only: one native object at 2023-04-01; NH3-N mg/L by synthetic-colorimetry-v1; discharge m3/s by synthetic-current-meter-v1.',
  };
  const record = (
    id: string,
    metric: ProjectReadinessRecord['metric'],
    rawValue: number,
  ): ProjectReadinessRecord => ({
    id,
    source,
    needIds: source.needIds,
    regionIds: source.regionIds,
    object: {
      key: 'synthetic-native-object',
      originalName: 'SYNTHETIC fixed native object',
      markers: [],
      footnotes: [],
    },
    series: null,
    time: { value: '2023-04-01', role: 'OBSERVATION', precision: 'DAY' },
    rawValue,
    metric,
    parsing: 'READY',
    professionalState: 'APPROVED',
    evidence: [{ ...evidence, locator: `synthetic:row:${id}` }],
    spatial: null,
  });
  const records = [
    record('concentration', definitions.concentration, 0),
    record('flow', definitions.flow, 2),
  ];
  return {
    track: 'SYNTHETIC',
    requirement: {
      needId: 'K5-001',
      version: 'synthetic-flux-conditions-v1',
      regionId: 'bohai',
      purpose: 'synthetic-load-eligibility',
      dateRole: 'OBSERVATION',
      window: { start: '2023-04', end: '2023-04' },
    },
    sources: [source],
    records,
    series: [],
    correspondences: [],
    useChecks: [
      {
        id: 'synthetic-flux-condition-check',
        purpose: 'synthetic-load-eligibility',
        computation: 'FLUX',
        state: 'CHECKS_PASSED',
        recordIds: records.map(readinessRecordKey),
        reasons: [],
        evidence: [evidence],
      },
    ],
  };
}

function changedRecords(
  change: (
    record: ProjectReadinessRecord,
    index: number,
  ) => ProjectReadinessRecord,
): ProjectReadinessInput {
  const input = fixture();
  return { ...input, records: input.records.map(change) };
}

const incompatiblePairs: readonly {
  name: string;
  input: () => ProjectReadinessInput;
  state: 'BLOCKED' | 'UNKNOWN';
  reasons: readonly string[];
}[] = [
  {
    name: 'different native objects despite the same name',
    state: 'BLOCKED',
    reasons: ['OBJECT_MISMATCH'],
    input: () =>
      changedRecords((r, i) =>
        i === 1
          ? { ...r, object: { ...r.object!, key: 'another-native-object' } }
          : r,
      ),
  },
  {
    name: 'unknown native object identity',
    state: 'UNKNOWN',
    reasons: ['OBJECT_IDENTITY_UNKNOWN'],
    input: () =>
      changedRecords((r, i) => (i === 1 ? { ...r, object: null } : r)),
  },
  {
    name: 'different valid observation days inside the same month',
    state: 'BLOCKED',
    reasons: ['TIME_PAIRING_MISMATCH'],
    input: () =>
      changedRecords((r, i) =>
        i === 1 ? { ...r, time: { ...r.time, value: '2023-04-02' } } : r,
      ),
  },
  {
    name: 'flow outside the current declared month window',
    state: 'BLOCKED',
    reasons: ['OUTSIDE_REQUIREMENT_WINDOW', 'TIME_PAIRING_MISMATCH'],
    input: () =>
      changedRecords((r, i) =>
        i === 1 ? { ...r, time: { ...r.time, value: '2023-05-01' } } : r,
      ),
  },
  {
    name: 'a same-day pair wholly outside the current declared month window',
    state: 'BLOCKED',
    reasons: ['OUTSIDE_REQUIREMENT_WINDOW'],
    input: () =>
      changedRecords((r) => ({
        ...r,
        time: { ...r.time, value: '2023-05-01' },
      })),
  },
  {
    name: 'unknown nonempty concentration and flow units',
    state: 'UNKNOWN',
    reasons: ['UNIT_UNKNOWN'],
    input: () =>
      changedRecords((r, i) => ({
        ...r,
        metric: {
          ...r.metric!,
          unit: i === 0 ? 'unrecognized-C-unit' : 'unrecognized-Q-unit',
        },
      })),
  },
  {
    name: 'a concentration unit used as the declared flow unit',
    state: 'BLOCKED',
    reasons: ['UNIT_DIMENSION_INCOMPATIBLE'],
    input: () =>
      changedRecords((r, i) =>
        i === 1 ? { ...r, metric: { ...r.metric!, unit: 'mg/L' } } : r,
      ),
  },
  {
    name: 'a nonempty unknown method declaration',
    state: 'UNKNOWN',
    reasons: ['METHOD_UNKNOWN'],
    input: () =>
      changedRecords((r) => ({
        ...r,
        metric: { ...r.metric!, method: 'unknown' },
      })),
  },
  {
    name: 'whitespace-only method declarations',
    state: 'UNKNOWN',
    reasons: ['METHOD_UNKNOWN', 'NUMERIC_CONTEXT_UNKNOWN'],
    input: () =>
      changedRecords((r) => ({
        ...r,
        metric: { ...r.metric!, method: '   ' },
      })),
  },
  {
    name: 'an impossible calendar day inside the current month',
    state: 'BLOCKED',
    reasons: ['INVALID_DATE'],
    input: () =>
      changedRecords((r) => ({
        ...r,
        time: { ...r.time, value: '2023-04-31' },
      })),
  },
  {
    name: 'failed parsing cannot be declared a complete numeric pair',
    state: 'BLOCKED',
    reasons: ['PARSING_INCOMPLETE'],
    input: () => changedRecords((r) => ({ ...r, parsing: 'FAILED' })),
  },
  {
    name: 'partial parsing cannot be declared a complete numeric pair',
    state: 'BLOCKED',
    reasons: ['PARSING_INCOMPLETE'],
    input: () => changedRecords((r) => ({ ...r, parsing: 'PARTIAL' })),
  },
];

describe('SYNTHETIC flux eligibility retains complete pairing conditions', () => {
  it('retains same-object same-day declared concentration zero and flow two without calculating a flux', () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = calculateProjectReadiness(input);
    expect(result.useChecks).toHaveLength(1);
    expect(result.useChecks[0]).toMatchObject({
      state: 'CHECKS_PASSED',
      reasons: [],
    });
    expect(result.records.map((r) => r.rawValue)).toEqual([0, 2]);
    expect(input).toEqual(before);
  });

  it.each(incompatiblePairs)(
    'reports exact state and reasons for $name',
    ({ input: build, state, reasons }) => {
      const input = build();
      const before = structuredClone(input);
      const result = calculateProjectReadiness(input);
      expect(result.useChecks).toHaveLength(1);
      expect(result.useChecks[0]).toMatchObject({ state, reasons });
      expect(input).toEqual(before);
    },
  );

  it('still blocks a missing flow instead of replacing it with an inferred value', () => {
    const input = fixture();
    const records = input.records.slice(0, 1);
    const result = calculateProjectReadiness({
      ...input,
      records,
      useChecks: (input.useChecks ?? []).map((check) => ({
        ...check,
        recordIds: records.map(readinessRecordKey),
      })),
    });
    expect(result.useChecks[0]).toMatchObject({
      state: 'BLOCKED',
      reasons: ['CONCENTRATION_AND_FLOW_REQUIRED'],
    });
  });

  it('still blocks a reported category as a numeric concentration', () => {
    const input = changedRecords((r, i) =>
      i === 0
        ? { ...r, rawValue: 'Ⅲ', metric: { ...r.metric!, kind: 'CATEGORY' } }
        : r,
    );
    const result = calculateProjectReadiness(input);
    expect(result.useChecks[0]).toMatchObject({
      state: 'BLOCKED',
      reasons: ['CONCENTRATION_AND_FLOW_REQUIRED', 'NON_NUMERIC_INPUT'],
    });
    expect(result.records[0]?.rawValue).toBe('Ⅲ');
  });

  it.each(['unit', 'method'] as const)(
    'keeps an absent %s unknown',
    (field) => {
      const result = calculateProjectReadiness(
        changedRecords((r) => ({
          ...r,
          metric: { ...r.metric!, [field]: null },
        })),
      );
      expect(result.useChecks[0]).toMatchObject({
        state: 'UNKNOWN',
        reasons:
          field === 'unit'
            ? ['NUMERIC_CONTEXT_UNKNOWN', 'UNIT_UNKNOWN']
            : ['METHOD_UNKNOWN', 'NUMERIC_CONTEXT_UNKNOWN'],
      });
    },
  );

  it('keeps unknown observation precision unknown', () => {
    const result = calculateProjectReadiness(
      changedRecords((r) => ({
        ...r,
        time: { ...r.time, precision: 'UNKNOWN' },
      })),
    );
    expect(result.useChecks[0]).toMatchObject({
      state: 'UNKNOWN',
      reasons: ['NUMERIC_CONTEXT_UNKNOWN', 'TIME_PAIRING_UNKNOWN'],
    });
  });
});

describe('flux conditions are a deterministic upper bound on supplied states', () => {
  it.each(['CHECKS_PASSED', 'LIMITED', 'UNKNOWN', 'BLOCKED'] as const)(
    'does not upgrade an otherwise complete %s declaration',
    (state) => {
      const input = fixture();
      const result = calculateProjectReadiness({
        ...input,
        useChecks: input.useChecks!.map((check) => ({
          ...check,
          state,
          reasons: ['supplied-restriction'],
        })),
      });
      expect(result.useChecks[0]).toMatchObject({
        state,
        reasons: ['supplied-restriction'],
      });
    },
  );

  it('keeps an input BLOCKED when current check evidence is missing', () => {
    const input = fixture();
    const result = calculateProjectReadiness({
      ...input,
      useChecks: input.useChecks!.map((check) => ({
        ...check,
        state: 'BLOCKED',
        reasons: ['supplied-block'],
        evidence: [],
      })),
    });
    expect(result.useChecks[0]).toMatchObject({
      state: 'BLOCKED',
      reasons: ['EVIDENCE_UNKNOWN', 'supplied-block'],
    });
  });

  it('requires current evidence for each numeric original', () => {
    const result = calculateProjectReadiness(
      changedRecords((r, i) => (i === 1 ? { ...r, evidence: [] } : r)),
    );
    expect(result.useChecks[0]).toMatchObject({
      state: 'UNKNOWN',
      reasons: ['EVIDENCE_UNKNOWN'],
    });
  });

  it('keeps fixture method strings UNKNOWN on REAL even with professional approval', () => {
    const input = fixture();
    const result = calculateProjectReadiness({
      ...input,
      track: 'REAL',
      sources: input.sources.map((source) => ({ ...source, track: 'REAL' })),
    });
    expect(result.useChecks[0]).toMatchObject({
      state: 'UNKNOWN',
      reasons: ['METHOD_UNKNOWN'],
    });
    expect(
      result.records.every((record) => record.professionalState === 'APPROVED'),
    ).toBe(true);
    expect(result).not.toHaveProperty('flux');
  });

  it.each([
    { unit: 'm³/s', concentration: 'mg/L' },
    { unit: 'L/s', concentration: 'μg/L' },
    { unit: 'm3/s', concentration: 'ug/L' },
  ])(
    'accepts declared dimensions with versioned compatible unit scales: $concentration and $unit',
    ({ unit, concentration }) => {
      const result = calculateProjectReadiness(
        changedRecords((r, i) => ({
          ...r,
          metric: { ...r.metric!, unit: i === 0 ? concentration : unit },
        })),
      );
      expect(result.useChecks[0]).toMatchObject({
        state: 'CHECKS_PASSED',
        reasons: [],
      });
      expect(result.records.map((record) => record.rawValue)).toEqual([0, 2]);
      expect(result).not.toHaveProperty('flux');
    },
  );

  it('preserves numeric original text and both genuine zero values', () => {
    const result = calculateProjectReadiness(
      changedRecords((r, i) => ({
        ...r,
        rawValue: i === 0 ? '0.00' : 0,
      })),
    );
    expect(result.useChecks[0]).toMatchObject({
      state: 'CHECKS_PASSED',
      reasons: [],
    });
    expect(result.records.map((record) => record.rawValue)).toEqual([
      '0.00',
      0,
    ]);
  });

  it('rejects a negative concentration', () => {
    const result = calculateProjectReadiness(
      changedRecords((r, i) => (i === 0 ? { ...r, rawValue: -1 } : r)),
    );
    expect(result.useChecks[0]).toMatchObject({
      state: 'BLOCKED',
      reasons: ['NEGATIVE_CONCENTRATION'],
    });
  });

  it('keeps negative flow unknown without a declared direction carrier', () => {
    const result = calculateProjectReadiness(
      changedRecords((r, i) => (i === 1 ? { ...r, rawValue: -1 } : r)),
    );
    expect(result.useChecks[0]).toMatchObject({
      state: 'UNKNOWN',
      reasons: ['FLOW_DIRECTION_UNKNOWN'],
    });
  });

  it('rejects a nonfinite numeric input', () => {
    const result = calculateProjectReadiness(
      changedRecords((r, i) =>
        i === 0 ? { ...r, rawValue: Number.POSITIVE_INFINITY } : r,
      ),
    );
    expect(result.useChecks[0]).toMatchObject({
      state: 'BLOCKED',
      reasons: ['NON_NUMERIC_INPUT'],
    });
  });

  it.each(['MONTH', 'YEAR'] as const)(
    'keeps %s precision unknown without period-support and aggregation declarations',
    (precision) => {
      const result = calculateProjectReadiness(
        changedRecords((r) => ({
          ...r,
          time: {
            ...r.time,
            precision,
            value: precision === 'MONTH' ? '2023-04' : '2023',
          },
        })),
      );
      expect(result.useChecks[0]).toMatchObject({
        state: 'UNKNOWN',
        reasons: ['TIME_PAIRING_UNKNOWN'],
      });
    },
  );

  it('does not mistake publication dates for observation pairing', () => {
    const result = calculateProjectReadiness(
      changedRecords((r) => ({
        ...r,
        time: { ...r.time, role: 'PUBLICATION' },
      })),
    );
    expect(result.useChecks[0]).toMatchObject({
      state: 'UNKNOWN',
      reasons: ['NUMERIC_CONTEXT_UNKNOWN', 'TIME_PAIRING_UNKNOWN'],
    });
  });

  it('keeps an undeclared requirement window unknown', () => {
    const input = fixture();
    const result = calculateProjectReadiness({
      ...input,
      requirement: { ...input.requirement, window: null },
    });
    expect(result.useChecks[0]).toMatchObject({
      state: 'UNKNOWN',
      reasons: ['REQUIREMENT_WINDOW_UNKNOWN'],
    });
  });

  it('does not pick an implicit pair from several flow values', () => {
    const input = fixture();
    const records = [
      ...input.records,
      { ...input.records[1]!, id: 'another-flow' },
    ];
    const result = calculateProjectReadiness({
      ...input,
      records,
      useChecks: input.useChecks!.map((check) => ({
        ...check,
        recordIds: records.map(readinessRecordKey),
      })),
    });
    expect(result.useChecks[0]).toMatchObject({
      state: 'UNKNOWN',
      reasons: ['PAIRING_SCOPE_UNKNOWN'],
    });
  });

  it('uses the Gregorian calendar for leap days', () => {
    const input = changedRecords((r) => ({
      ...r,
      time: { ...r.time, value: '2024-02-29' },
    }));
    const requirement = {
      ...input.requirement,
      window: { start: '2024-02', end: '2024-02' },
    };
    expect(
      calculateProjectReadiness({ ...input, requirement }).useChecks[0],
    ).toMatchObject({ state: 'CHECKS_PASSED', reasons: [] });
    expect(
      calculateProjectReadiness({
        ...input,
        requirement: {
          ...requirement,
          window: { start: '2023-02', end: '2023-02' },
        },
        records: input.records.map((r) => ({
          ...r,
          time: { ...r.time, value: '2023-02-29' },
        })),
      }).useChecks[0],
    ).toMatchObject({ state: 'BLOCKED', reasons: ['INVALID_DATE'] });
  });
});

function crossSourceFixture(): ProjectReadinessInput {
  const input = fixture();
  const secondSource: ProjectReadinessSource = {
    ...input.sources[0]!,
    workId: 'SYNTHETIC-second-source',
    assetId: 'sha256:' + 'b'.repeat(64),
  };
  const proofSource: ProjectReadinessSource = {
    ...input.sources[0]!,
    workId: 'SYNTHETIC-correspondence-proof',
    assetId: 'sha256:' + 'c'.repeat(64),
  };
  const records = input.records.map((r, i) =>
    i === 1
      ? {
          ...r,
          source: secondSource,
          evidence: r.evidence.map((e) => ({ ...e, source: secondSource })),
        }
      : r,
  );
  return {
    ...input,
    sources: [...input.sources, secondSource, proofSource],
    records,
    useChecks: input.useChecks!.map((check) => ({
      ...check,
      recordIds: records.map(readinessRecordKey),
    })),
    correspondences: [
      {
        id: 'synthetic-current-approved-correspondence',
        status: 'APPROVED',
        memberRecordIds: records.map(readinessRecordKey),
        evidence: [
          {
            source: proofSource,
            locator: 'synthetic:review:v1',
            excerpt: 'SYNTHETIC current identity correspondence only.',
          },
        ],
      },
    ],
  };
}

describe('flux identity depends on current scoped correspondence evidence', () => {
  it('accepts a current explicitly APPROVED cross-source correspondence', () => {
    expect(
      calculateProjectReadiness(crossSourceFixture()).useChecks[0],
    ).toMatchObject({ state: 'CHECKS_PASSED', reasons: [] });
  });

  it.each(['PENDING_REVIEW', 'REJECTED', 'REQUIRES_CORRECTION'] as const)(
    'keeps $status cross-source correspondence unknown',
    (status) => {
      const input = crossSourceFixture();
      expect(
        calculateProjectReadiness({
          ...input,
          correspondences: input.correspondences.map((c) => ({ ...c, status })),
        }).useChecks[0],
      ).toMatchObject({
        state: 'UNKNOWN',
        reasons: ['OBJECT_IDENTITY_UNKNOWN'],
      });
    },
  );

  it('does not infer cross-source identity from matching object keys and names', () => {
    expect(
      calculateProjectReadiness({
        ...crossSourceFixture(),
        correspondences: [],
      }).useChecks[0],
    ).toMatchObject({ state: 'UNKNOWN', reasons: ['OBJECT_IDENTITY_UNKNOWN'] });
  });

  it('rebinds to current evidence after proof withdrawal while retaining both raw originals', () => {
    const input = crossSourceFixture();
    expect(calculateProjectReadiness(input).useChecks[0]?.state).toBe(
      'CHECKS_PASSED',
    );
    const result = calculateProjectReadiness({
      ...input,
      sources: input.sources.slice(0, 2),
    });
    expect(result.useChecks[0]).toMatchObject({
      state: 'UNKNOWN',
      reasons: ['OBJECT_IDENTITY_UNKNOWN'],
    });
    expect(result.records.map((r) => r.rawValue)).toEqual([0, 2]);
    expect(result.records[0]?.evidence).toEqual(input.records[0]?.evidence);
    expect(
      result.questions
        .find((q) => q.id === 'STRUCTURE')
        ?.drilldowns.find((d) => d.grain === 'CORRESPONDENCE')?.ids,
    ).toEqual([]);
  });
});
