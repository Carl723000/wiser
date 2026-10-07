import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as contracts from '../src/index.ts';

const id = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = (n = 1) => ({
  kind: 'ingestion-candidate' as const,
  ingestionId: id(n),
  processingBatchId: id(n + 100),
  reviewHash: 'a'.repeat(64),
});
const legacy = () => ({
  page: { kind: 'assets' as const, reference: reference(), first: 2 },
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
  period: {
    windowMode: 'month' as const,
    from: '2023-01',
    to: '2023-11',
    timeRole: 'REPORT_PERIOD' as const,
    displayUnit: 'month' as const,
    includeUndated: false,
  },
  topic: {
    question: '报告期资料覆盖哪些月份？',
    regionIds: ['CHAObAI'],
    needIds: ['water-quality'],
    recordPins: [],
  },
  rulePins: (['projection', 'readiness', 'requirement', 'impact'] as const).map(
    (kind) => ({ kind, ruleId: `${kind}-rule`, version: '1.0.0' }),
  ),
  dependencyPins: [
    {
      kind: 'asset' as const,
      reference: reference(),
      assetId: id(5),
      sourceHash: 'b'.repeat(64),
      parserVersion: 'parser/1.0.0',
    },
  ],
  relationPins: [],
});
const saved = (specVersion: 1 | 2 = 2) => ({
  kind: 'ingestion-candidate-view' as const,
  viewId: id(20),
  title: '固定报告期专题',
  visibility: 'private' as const,
  createdAt: '2026-10-08T00:00:00Z',
  revokedAt: null,
  specVersion,
});
const readable = (specVersion: 1 | 2 = 2) => ({
  status: 'READABLE' as const,
  specVersion,
  savedView: saved(specVersion),
  references: [reference()],
  viewSpec: specVersion === 1 ? legacy() : topic(),
  request: {
    capabilityId: 'data.ingestion.candidate.get',
    input: { ...reference(), first: 2 },
  },
});
function schema(name: string): z.ZodType {
  const found = (contracts as unknown as Record<string, unknown>)[name];
  expect(found, `Missing public ${name}`).toBeDefined();
  return found as z.ZodType;
}

describe('candidate topic public version boundary', () => {
  it('registers three independent 1.0.0 capabilities without changing the legacy endpoints', () => {
    const definitions = contracts.DATA_CAPABILITY_REGISTRY as Record<
      string,
      { version: string; restMapping: unknown }
    >;
    for (const [operation, method, suffix] of [
      ['create', 'POST', ''],
      ['list', 'GET', ''],
      ['open', 'POST', '/:viewId/open'],
    ] as const) {
      expect(
        definitions[`data.ingestion.candidate.topic.${operation}`],
      ).toMatchObject({
        version: '1.0.0',
        restMapping: {
          method,
          path: `/api/data/v1/ingestion-candidate-topics${suffix}`,
          successStatus: 200,
        },
      });
      expect(
        definitions[`data.ingestion.candidate.view.${operation}`],
      ).toMatchObject({ version: '1.0.0' });
    }
    expect(
      contracts.CreateIngestionCandidateViewInputSchema.safeParse({
        title: '旧保存',
        references: [reference()],
        viewSpec: topic(),
      }).success,
    ).toBe(false);
  });
  it('keeps mixed lists explicitly tagged and rejects missing or unknown versions', () => {
    const output = schema('ListIngestionCandidateTopicsOutputSchema');
    expect(
      output.parse({ items: [saved(1), saved(2)], nextCursor: null }),
    ).toEqual({ items: [saved(1), saved(2)], nextCursor: null });
    for (const item of [
      { ...saved(), specVersion: 3 },
      { ...saved(), specVersion: undefined },
      { ...saved(), schemaVersion: 2 },
    ])
      expect(
        output.safeParse({ items: [item], nextCursor: null }).success,
      ).toBe(false);
  });
  it('returns legacy display state honestly without inventing topic rules or time roles', () => {
    const output = schema('OpenIngestionCandidateTopicOutputSchema');
    expect(output.parse(readable(1))).toEqual(readable(1));
    expect(
      output.safeParse({
        ...readable(1),
        viewSpec: { ...legacy(), topic: topic().topic },
      }).success,
    ).toBe(false);
  });
  it('returns a complete fixed v2 and refuses version confusion and changed page selections', () => {
    const output = schema('OpenIngestionCandidateTopicOutputSchema');
    expect(output.parse(readable(2))).toEqual(readable(2));
    for (const invalid of [
      { ...readable(2), specVersion: 1 },
      { ...readable(1), specVersion: 2 },
      { ...readable(2), savedView: saved(1) },
      { ...readable(2), viewSpec: { ...topic(), schemaVersion: 3 } },
      {
        ...readable(2),
        request: {
          ...readable().request,
          input: { ...reference(2), first: 2 },
        },
      },
      {
        ...readable(2),
        request: { ...readable().request, input: { ...reference(), first: 3 } },
      },
      {
        ...readable(2),
        viewSpec: {
          ...topic(),
          page: { ...topic().page, afterAssetId: id(30) },
        },
      },
      { ...readable(2), references: [reference(2)] },
      {
        ...readable(2),
        savedView: { ...saved(), revokedAt: '2026-10-08T01:00:00Z' },
      },
    ])
      expect(output.safeParse(invalid).success).toBe(false);
  });
  it('restricts unavailable receipts to exactly status and viewId', () => {
    const output = schema('OpenIngestionCandidateTopicOutputSchema');
    const receipt = { status: 'UNAVAILABLE', viewId: id(20) };
    expect(output.parse(receipt)).toEqual(receipt);
    for (const extra of [
      { title: 'hidden' },
      { references: [reference()] },
      { count: 1 },
      { viewSpec: topic() },
      { specVersion: 2 },
      { reason: 'WITHDRAWN' },
    ])
      expect(output.safeParse({ ...receipt, ...extra }).success).toBe(false);
    expect(output.safeParse({ status: 'UNAVAILABLE' }).success).toBe(false);
  });
  it('tags only newly created v2 and does not certify client authority', () => {
    const output = schema('CreateIngestionCandidateTopicOutputSchema');
    expect(output.parse({ savedView: saved() })).toEqual({
      savedView: saved(),
    });
    expect(output.safeParse({ savedView: saved(1) }).success).toBe(false);
    expect(
      output.safeParse({ savedView: { ...saved(), verified: true } }).success,
    ).toBe(false);
  });
  it('retains the 100-reference manifest boundary in readable responses', () => {
    const output = schema('OpenIngestionCandidateTopicOutputSchema');
    const full = {
      ...readable(),
      references: Array.from({ length: 100 }, (_, n) => reference(n + 1)),
    };
    expect(output.safeParse(full).success).toBe(true);
    expect(
      output.safeParse({
        ...full,
        references: [...full.references, reference(101)],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...full,
        references: [...full.references, reference().ingestionId],
      }).success,
    ).toBe(false);
  });
  it('retains the complete UTF-8 response budget including source pins', () => {
    const output = schema('OpenIngestionCandidateTopicOutputSchema');
    const records = Array.from({ length: 199 }, (_, n) => ({
      reference: reference(),
      assetId: id(5),
      recordId: id(n + 1000),
    }));
    const value = {
      ...readable(),
      viewSpec: {
        ...topic(),
        topic: { ...topic().topic, recordPins: records },
        dependencyPins: [
          { ...topic().dependencyPins[0], parserVersion: '型'.repeat(128) },
          ...records.map((pin) => ({
            ...topic().dependencyPins[0],
            kind: 'record',
            recordId: pin.recordId,
            recordHash: 'c'.repeat(64),
            parserVersion: '型'.repeat(128),
          })),
        ],
      },
    };
    expect(contracts.jsonUtf8Bytes(value)).toBeGreaterThan(
      contracts.CANDIDATE_SAVED_VIEW_BYTES,
    );
    expect(output.safeParse(value).success).toBe(false);
  });
});
