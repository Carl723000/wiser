import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_SAVED_VIEW_BYTES,
  CreateIngestionCandidateViewInputSchema,
  IngestionCandidateSavedViewSpecSchema,
  CreateIngestionCandidateTopicInputSchema,
  IngestionCandidateTopicSpecSchema,
  candidateSavedSpecVersion,
  jsonUtf8Bytes,
} from '../src/index.ts';

const id = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = (n = 1) => ({
  kind: 'ingestion-candidate' as const,
  ingestionId: id(n),
  processingBatchId: id(n + 100),
  reviewHash: 'a'.repeat(64),
});
const recordPin = (n = 10) => ({
  reference: reference(),
  assetId: id(5),
  recordId: id(n),
});
const assetDependency = () => ({
  kind: 'asset' as const,
  reference: reference(),
  assetId: id(5),
  sourceHash: 'b'.repeat(64),
  parserVersion: 'source-parser/1.0.0',
});
const recordDependency = (n = 10) => ({
  ...assetDependency(),
  kind: 'record' as const,
  recordId: id(n),
  recordHash: 'c'.repeat(64),
});
const rulePins = () =>
  (['projection', 'readiness', 'requirement', 'impact'] as const).map(
    (kind) => ({
      kind,
      ruleId: `${kind}-rule`,
      version: '1.0.0',
    }),
  );
const legacy = () => ({
  page: {
    kind: 'records' as const,
    reference: reference(),
    assetId: id(5),
    first: 2,
  },
  period: {
    from: '2023-01',
    to: '2023-11',
    unit: 'month' as const,
    includeUndated: false,
  },
});
const topic = () => ({
  schemaVersion: 2 as const,
  page: legacy().page,
  focus: recordPin(),
  map: {
    camera: { longitude: 116, latitude: 40, zoom: 8, bearing: 0, pitch: 0 },
  },
  period: {
    windowMode: 'month' as const,
    from: '2023-01',
    to: '2023-11',
    timeRole: 'REPORT_PERIOD' as const,
    displayUnit: 'month' as const,
    includeUndated: false,
  },
  topic: {
    question: '潮白河月报覆盖哪些月份，原表河段及资料有哪些限制？',
    regionIds: ['CHAObAI'],
    needIds: ['water-quality'],
    recordPins: [recordPin()],
  },
  rulePins: rulePins(),
  dependencyPins: [assetDependency(), recordDependency()],
  relationPins: [{ relationId: id(20), revision: 1, decisionVersion: 0 }],
});
const create = (viewSpec: unknown = topic()) => ({
  title: '潮白河报告期专题',
  references: [reference()],
  viewSpec,
});

describe('complete candidate topic v2 contracts', () => {
  it('preserves the complete bounded fixed selection without changing legacy v1', () => {
    expect(IngestionCandidateTopicSpecSchema.parse(topic())).toEqual(topic());
    expect(CreateIngestionCandidateTopicInputSchema.parse(create())).toEqual({
      ...create(),
      visibility: 'private',
    });
    expect(candidateSavedSpecVersion(topic())).toBe(2);
    expect(candidateSavedSpecVersion(legacy())).toBe(1);
    expect(IngestionCandidateSavedViewSpecSchema.parse(legacy())).toEqual(
      legacy(),
    );
    expect(
      CreateIngestionCandidateViewInputSchema.safeParse(create()).success,
    ).toBe(false);
    expect(CANDIDATE_SAVED_VIEW_BYTES).toBe(131072);
  });

  it.each(['PUBLICATION', 'OBSERVATION', 'EVENT', 'REPORT_PERIOD', 'UNKNOWN'])(
    'fixes the explicit %s role without inferring it from the title',
    (timeRole) => {
      const value = { ...topic(), period: { ...topic().period, timeRole } };
      expect(IngestionCandidateTopicSpecSchema.parse(value)).toEqual(value);
    },
  );

  it.each([
    ['2024-02-29', '2024-03-01'],
    [null, '2024-02-29'],
    ['2024-02-29', null],
    [null, null],
  ])('preserves a calendar-valid day window %s → %s', (from, to) => {
    const value = {
      ...topic(),
      period: {
        ...topic().period,
        windowMode: 'day',
        from,
        to,
        displayUnit: 'day',
      },
    };
    expect(IngestionCandidateTopicSpecSchema.parse(value)).toEqual(value);
  });

  it('preserves whole-record geometry and a source-local object key as pins, not coordinates', () => {
    const value = {
      ...topic(),
      topic: {
        ...topic().topic,
        recordPins: [
          { ...recordPin(), sourceObjectKey: 'table:1/row:5/river-segment' },
        ],
      },
      dependencyPins: [
        assetDependency(),
        {
          ...recordDependency(),
          kind: 'geometry',
          geometryHash: 'd'.repeat(64),
        },
      ],
    };
    expect(IngestionCandidateTopicSpecSchema.parse(value)).toEqual(value);
  });

  it('rejects contradictory record fingerprints across content and whole-record geometry dependencies', () => {
    const value = {
      ...topic(),
      dependencyPins: [
        assetDependency(),
        recordDependency(),
        {
          ...recordDependency(),
          kind: 'geometry',
          recordHash: 'e'.repeat(64),
          geometryHash: 'd'.repeat(64),
        },
      ],
    };
    expect(IngestionCandidateTopicSpecSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it('allows consistent content and geometry pins for one record and an explicit empty selection for a real gap', () => {
    const withGeometry = {
      ...topic(),
      dependencyPins: [
        ...topic().dependencyPins,
        {
          ...recordDependency(),
          kind: 'geometry',
          geometryHash: 'd'.repeat(64),
        },
      ],
    };
    expect(IngestionCandidateTopicSpecSchema.parse(withGeometry)).toEqual(
      withGeometry,
    );
    const gap = {
      ...topic(),
      page: { kind: 'assets', reference: reference(), first: 2 },
      focus: undefined,
      topic: { ...topic().topic, recordPins: [] },
      dependencyPins: [assetDependency()],
      relationPins: [],
    };
    expect(
      CreateIngestionCandidateTopicInputSchema.safeParse(create(gap)).success,
    ).toBe(true);
  });

  it.each(['1900-02-29', '2024-04-31', '2024-00-01', '2024-13-01'])(
    'rejects the nonexistent day %s without date rollover',
    (from) => {
      expect(
        IngestionCandidateTopicSpecSchema.safeParse({
          ...topic(),
          period: { ...topic().period, windowMode: 'day', from, to: null },
        }).success,
      ).toBe(false);
    },
  );

  it('accepts leap-century dates and retains source identity and map/page ceilings', () => {
    const value = {
      ...topic(),
      period: {
        ...topic().period,
        windowMode: 'day',
        from: '2000-02-29',
        to: null,
      },
    };
    expect(IngestionCandidateTopicSpecSchema.parse(value)).toEqual(value);
    for (const invalid of [
      { ...topic(), page: { ...topic().page, first: 201 } },
      {
        ...topic(),
        map: { camera: { ...topic().map.camera, longitude: 181 } },
      },
      {
        ...topic(),
        dependencyPins: [
          assetDependency(),
          { ...recordDependency(), sourceHash: 'f'.repeat(64) },
        ],
      },
      {
        ...topic(),
        dependencyPins: [
          assetDependency(),
          { ...recordDependency(), parserVersion: 'changed/2.0.0' },
        ],
      },
      { ...topic(), focus: { ...recordPin(12) } },
      {
        ...topic(),
        topic: {
          ...topic().topic,
          recordPins: [{ ...recordPin(), sourceObjectKey: ' ' }],
        },
      },
      {
        ...topic(),
        topic: {
          ...topic().topic,
          regionIds: Array.from({ length: 33 }, (_, n) => `region-${n}`),
        },
      },
      {
        ...topic(),
        topic: {
          ...topic().topic,
          needIds: Array.from({ length: 65 }, (_, n) => `need-${n}`),
        },
      },
      {
        ...topic(),
        relationPins: Array.from({ length: 101 }, (_, n) => ({
          relationId: id(n + 1000),
          revision: 1,
          decisionVersion: 0,
        })),
      },
    ])
      expect(IngestionCandidateTopicSpecSchema.safeParse(invalid).success).toBe(
        false,
      );
  });

  it.each([
    { schemaVersion: 1 },
    { schemaVersion: 3 },
    { schemaVersion: '2' },
    {
      period: {
        ...topic().period,
        windowMode: 'day',
        from: '2024-02-30',
        to: '2024-03-01',
      },
    },
    {
      period: {
        ...topic().period,
        windowMode: 'day',
        from: '2023-02-29',
        to: null,
      },
    },
    { period: { ...topic().period, windowMode: 'month', from: '2023-01-01' } },
    {
      period: {
        ...topic().period,
        windowMode: 'day',
        from: '2023-01',
        to: null,
      },
    },
    { period: { ...topic().period, to: '2022-12' } },
    { period: { ...topic().period, timeRole: 'SAMPLING_TIME' } },
    { period: { ...topic().period, unit: 'month' } },
    { topic: { ...topic().topic, question: ' ' } },
    { topic: { ...topic().topic, question: '问'.repeat(2001) } },
    { topic: { ...topic().topic, regionIds: ['CHAObAI', 'CHAObAI'] } },
    { topic: { ...topic().topic, needIds: [] } },
    { topic: { ...topic().topic, recordPins: [recordPin(), recordPin()] } },
    { topic: { ...topic().topic, recordPins: [recordPin(11)] } },
    { rulePins: rulePins().slice(0, 3) },
    { rulePins: [...rulePins(), { ...rulePins()[0], version: '2.0.0' }] },
    { dependencyPins: [recordDependency()] },
    { dependencyPins: [assetDependency()] },
    {
      dependencyPins: [
        ...topic().dependencyPins,
        { ...recordDependency(), recordHash: 'd'.repeat(64) },
      ],
    },
    {
      dependencyPins: [
        assetDependency(),
        {
          ...recordDependency(),
          kind: 'geometry',
          coordinates: [116, 40],
          geometryHash: 'd'.repeat(64),
        },
      ],
    },
    {
      dependencyPins: [
        assetDependency(),
        { ...recordDependency(), trustedConversion: true },
      ],
    },
    { relationPins: [{ relationId: id(20), revision: 0, decisionVersion: 0 }] },
    {
      relationPins: [{ relationId: id(20), revision: 1, decisionVersion: -1 }],
    },
    {
      relationPins: [
        { relationId: id(20), revision: 1, decisionVersion: 0 },
        { relationId: id(20).toUpperCase(), revision: 2, decisionVersion: 1 },
      ],
    },
    { authority: 'verified' },
    { approved: true },
  ])(
    'rejects missing, contradictory, unbounded or authority-injected state %#',
    (change) => {
      expect(
        IngestionCandidateTopicSpecSchema.safeParse({ ...topic(), ...change })
          .success,
      ).toBe(false);
    },
  );

  it.each(['period', 'topic', 'rulePins', 'dependencyPins', 'relationPins'])(
    'requires the explicit complete %s field',
    (field) => {
      const value: Record<string, unknown> = { ...topic() };
      delete value[field];
      expect(IngestionCandidateTopicSpecSchema.safeParse(value).success).toBe(
        false,
      );
    },
  );

  it('checks every selection and dependency against at most 100 unique manifest members', () => {
    const full = {
      ...create(),
      references: Array.from({ length: 100 }, (_, n) => reference(n + 1)),
    };
    expect(
      CreateIngestionCandidateTopicInputSchema.safeParse(full).success,
    ).toBe(true);
    for (const value of [
      { ...full, references: [...full.references, reference(101)] },
      {
        ...create(),
        references: [
          reference(),
          {
            ...reference(),
            ingestionId: reference().ingestionId.toUpperCase(),
          },
        ],
      },
      {
        ...create(),
        viewSpec: {
          ...topic(),
          page: { ...topic().page, reference: reference(2) },
        },
      },
      {
        ...create(),
        viewSpec: {
          ...topic(),
          focus: { ...recordPin(), reference: reference(2) },
        },
      },
      {
        ...create(),
        viewSpec: {
          ...topic(),
          topic: {
            ...topic().topic,
            recordPins: [{ ...recordPin(), reference: reference(2) }],
          },
        },
      },
      {
        ...create(),
        viewSpec: {
          ...topic(),
          dependencyPins: [
            ...topic().dependencyPins,
            { ...assetDependency(), reference: reference(2) },
          ],
        },
      },
    ])
      expect(
        CreateIngestionCandidateTopicInputSchema.safeParse(value).success,
      ).toBe(false);
  });

  it('applies the existing 128 KiB UTF-8 budget to the entire create envelope', () => {
    const records = Array.from({ length: 199 }, (_, n) => recordPin(n + 1000));
    const value = create({
      ...topic(),
      focus: undefined,
      topic: { ...topic().topic, recordPins: records },
      dependencyPins: [
        assetDependency(),
        ...records.map((pin) => ({
          ...recordDependency(),
          recordId: pin.recordId,
          parserVersion: '型'.repeat(128),
        })),
      ],
    });
    // All individual limits are bounded; the combined envelope must still fail.
    expect(jsonUtf8Bytes(value)).toBeGreaterThan(CANDIDATE_SAVED_VIEW_BYTES);
    expect(
      CreateIngestionCandidateTopicInputSchema.safeParse(value).success,
    ).toBe(false);
  });

  it('recognizes only strict legacy or complete v2 and never strips unknown versions into v1', () => {
    expect(
      candidateSavedSpecVersion({ ...legacy(), schemaVersion: 2 }),
    ).toBeNull();
    expect(
      candidateSavedSpecVersion({ ...topic(), schemaVersion: 3 }),
    ).toBeNull();
    expect(
      candidateSavedSpecVersion({ ...legacy(), topic: topic().topic }),
    ).toBeNull();
    expect(candidateSavedSpecVersion(null)).toBeNull();
  });
});
