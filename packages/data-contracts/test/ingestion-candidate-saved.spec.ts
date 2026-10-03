import { describe, expect, it } from 'vitest';
import {
  DATA_CAPABILITY_REGISTRY,
  CreateIngestionCandidateViewInputSchema,
  OpenIngestionCandidateViewOutputSchema,
  ListIngestionCandidateViewsInputSchema,
  CANDIDATE_SAVED_VIEW_BYTES,
  jsonUtf8Bytes,
} from '../src/index.js';
const id = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = (n = 1) => ({
  kind: 'ingestion-candidate' as const,
  ingestionId: id(n),
  processingBatchId: id(n + 100),
  reviewHash: 'a'.repeat(64),
});
const create = () => ({
  title: '候选专题',
  references: [reference()],
  viewSpec: {
    page: {
      kind: 'records' as const,
      reference: reference(),
      assetId: id(10),
      first: 2,
      afterRecordId: id(11),
    },
    period: {
      from: '2023-04',
      to: '2023-11',
      unit: 'month' as const,
      includeUndated: false,
    },
  },
});
const opened = () => ({
  kind: 'ingestion-candidate-view',
  savedView: {
    kind: 'ingestion-candidate-view',
    viewId: id(50),
    title: '候选专题',
    visibility: 'private',
    createdAt: '2026-10-03T10:00:00Z',
    revokedAt: null,
  },
  references: [reference()],
  viewSpec: create().viewSpec,
  request: {
    capabilityId: 'data.ingestion.candidate.records',
    input: {
      ...reference(),
      assetId: id(10),
      first: 2,
      after: 'current-bound-cursor',
    },
  },
});
describe('fixed candidate saved-view contracts', () => {
  it('provides strict bounded state without accepting published identities or opaque saved cursors', () => {
    expect(
      CreateIngestionCandidateViewInputSchema.parse(create()).visibility,
    ).toBe('private');
    expect(ListIngestionCandidateViewsInputSchema.parse({})).toEqual({
      first: 20,
    });
    expect(CANDIDATE_SAVED_VIEW_BYTES).toBe(131072);
    for (const change of [
      { queryId: id(1) },
      { references: [] },
      {
        references: [
          reference(),
          {
            ...reference(),
            ingestionId: reference().ingestionId.toUpperCase(),
          },
        ],
      },
      {
        viewSpec: {
          ...create().viewSpec,
          page: { ...create().viewSpec.page, after: 'old-cursor' },
        },
      },
      {
        viewSpec: {
          ...create().viewSpec,
          period: { ...create().viewSpec.period, to: '2023-03' },
        },
      },
      {
        viewSpec: {
          ...create().viewSpec,
          page: { ...create().viewSpec.page, reference: reference(2) },
        },
      },
    ])
      expect(
        CreateIngestionCandidateViewInputSchema.safeParse({
          ...create(),
          ...change,
        }).success,
      ).toBe(false);
    const full = {
      ...create(),
      references: Array.from({ length: 100 }, (_, n) => reference(n + 1)),
    };
    expect(
      CreateIngestionCandidateViewInputSchema.safeParse(full).success,
    ).toBe(true);
    expect(jsonUtf8Bytes(full)).toBeLessThan(CANDIDATE_SAVED_VIEW_BYTES);
  });
  it.each(['reference', 'asset', 'kind', 'first', 'cursor', 'revoked'])(
    'rejects a resume response whose %s contradicts the saved fixed page',
    (variant) => {
      const value = opened();
      if (variant === 'reference')
        value.request.input = { ...value.request.input, ...reference(2) };
      if (variant === 'asset') value.request.input.assetId = id(12);
      if (variant === 'kind')
        value.request.capabilityId = 'data.ingestion.candidate.geometry';
      if (variant === 'first') value.request.input.first = 3;
      if (variant === 'cursor') value.request.input.after = '';
      if (variant === 'revoked')
        Object.assign(value.savedView, { revokedAt: '2026-10-04T00:00:00Z' });
      expect(
        OpenIngestionCandidateViewOutputSchema.safeParse(value).success,
      ).toBe(false);
    },
  );
  it('preserves the exact stored page when its fresh existing request matches', () => {
    expect(OpenIngestionCandidateViewOutputSchema.parse(opened())).toEqual(
      opened(),
    );
    expect(
      DATA_CAPABILITY_REGISTRY[
        'data.explore.view.create'
      ].inputSchema.safeParse(create()).success,
    ).toBe(false);
  });
});
