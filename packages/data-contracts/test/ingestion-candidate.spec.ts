import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

const ingestionId = '10000000-0000-4000-8000-000000000001';
const processingBatchId = '10000000-0000-4000-8000-000000000002';
const assetId = '10000000-0000-4000-8000-000000000003';
const recordId = '10000000-0000-4000-8000-000000000004';
const reference = {
  kind: 'ingestion-candidate',
  ingestionId,
  reviewHash: 'a'.repeat(64),
  processingBatchId,
};
const asset = {
  assetId,
  sourceHash: 'b'.repeat(64),
  status: 'PARTIAL',
  recordCount: 1,
  featureCount: 0,
  reason: 'SOURCE_LOCATION_UNRESOLVED',
};
const batch = {
  reference,
  parserVersion: '1.0.0',
  status: 'PARTIAL',
  assets: [asset],
  createdAt: '2026-10-03T10:00:00Z',
};
const record = {
  recordId,
  assetId,
  index: 1,
  sourceId: 'word/document.xml#table:1/row:5',
  values: {
    c1: '潮白河',
    c2: 'Ⅲ',
    c3: null,
    c4: 0,
    c5: '',
    c6: { raw: '无水' },
  },
  hasGeometry: false,
};

describe('frozen ingestion candidate contracts', () => {
  it('has a separate identity that cannot be a published version reference', () => {
    expect(
      contracts.IngestionCandidateReferenceSchema.parse(reference),
    ).toEqual(reference);
    expect(
      contracts.ExplorationVersionRefSchema.safeParse(reference).success,
    ).toBe(false);
    for (const extra of [
      { versionId: ingestionId },
      { reviewHash: 'A'.repeat(64) },
      { processingBatchId: undefined },
    ]) {
      expect(
        contracts.IngestionCandidateReferenceSchema.safeParse({
          ...reference,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
  it('preserves partial and unknown parse outcomes without inventing zero counts', () => {
    expect(contracts.IngestionCandidateBatchSchema.parse(batch)).toEqual(batch);
    expect(
      contracts.IngestionCandidateBatchSchema.safeParse({
        ...batch,
        status: 'UNAVAILABLE',
        assets: [
          {
            ...asset,
            status: 'UNSUPPORTED',
            recordCount: null,
            featureCount: null,
            reason: 'UNSUPPORTED_FORMAT',
          },
        ],
      }).success,
    ).toBe(true);
    for (const changed of [
      { status: 'UNSUPPORTED', recordCount: 0, featureCount: 0 },
      { featureCount: 2 },
      { reason: null },
      { status: 'EMPTY' },
    ]) {
      expect(
        contracts.IngestionCandidateBatchSchema.safeParse({
          ...batch,
          assets: [{ ...asset, ...changed }],
        }).success,
      ).toBe(false);
    }
  });
  it('rejects repeated or unbound original assets and contradictory batch totals', () => {
    for (const changed of [
      { assets: [] },
      { assets: [asset, asset] },
      { assets: [{ ...asset, sourceHash: 'not-a-hash' }] },
      { status: 'READY' },
      { assets: [{ ...asset, storageKey: 'quarantine/internal' }] },
      { reviewState: 'APPROVED' },
    ]) {
      expect(
        contracts.IngestionCandidateBatchSchema.safeParse({
          ...batch,
          ...changed,
        }).success,
      ).toBe(false);
    }
  });
  it('keeps raw category, null, zero and empty values plus original table locator', () => {
    expect(contracts.IngestionCandidateRecordSchema.parse(record)).toEqual(
      record,
    );
    for (const changed of [
      { index: 0 },
      { index: 2_000_001 },
      { sourceId: 'x'.repeat(1025) },
      { values: { c1: Infinity } },
      { versionId: ingestionId },
    ]) {
      expect(
        contracts.IngestionCandidateRecordSchema.safeParse({
          ...record,
          ...changed,
        }).success,
      ).toBe(false);
    }
  });
  it('bounds one record before JSON recursion and retains nested original values', () => {
    let deep: unknown = null;
    for (let i = 0; i < 18; i++) deep = { raw: deep };
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const values of [
      { c1: 'x'.repeat(262145) },
      { c1: '河'.repeat(100_000) },
      { c1: deep },
      { c1: cyclic },
    ]) {
      expect(
        contracts.IngestionCandidateRecordSchema.safeParse({
          ...record,
          values,
        }).success,
      ).toBe(false);
    }
  });
  it('does not execute user-defined accessors or custom JSON serialization', () => {
    let invoked = false;
    const values = Object.defineProperty({}, 'c1', {
      enumerable: true,
      get() {
        invoked = true;
        return 'private';
      },
    });
    expect(
      contracts.IngestionCandidateRecordSchema.safeParse({ ...record, values })
        .success,
    ).toBe(false);
    const custom = {
      toJSON() {
        invoked = true;
        return 'private';
      },
    };
    expect(
      contracts.IngestionCandidateRecordSchema.safeParse({
        ...record,
        values: { c1: custom },
      }).success,
    ).toBe(false);
    expect(invoked).toBe(false);
  });
  it('rejects arrays with inherited serialization before executing it', () => {
    let invoked = false;
    const customArray = [1];
    Object.setPrototypeOf(customArray, {
      toJSON() {
        invoked = true;
        return 'replacement';
      },
    });
    const result = contracts.IngestionCandidateRecordSchema.safeParse({
      ...record,
      values: { c1: customArray },
    });
    expect(invoked).toBe(false);
    expect(result.success).toBe(false);
  });
  it('returns a bounded page from only one fixed asset and rejects record repetition', () => {
    const page = {
      reference,
      assetId,
      columns: [
        { key: 'c1', label: '河段' },
        { key: 'c2', label: '类别' },
        { key: 'c3', label: '缺失' },
        { key: 'c4', label: '原值0' },
        { key: 'c5', label: '空串' },
        { key: 'c6', label: '原文' },
      ],
      records: [record],
      nextCursor: null,
    };
    expect(contracts.IngestionCandidateRecordPageSchema.parse(page)).toEqual(
      page,
    );
    for (const changed of [
      { records: [record, record] },
      { records: [{ ...record, assetId: ingestionId }] },
      { records: [{ ...record, values: { c7: 'undeclared' } }] },
      {
        columns: [
          { key: 'c1', label: '河段' },
          { key: 'c1', label: '重复' },
        ],
      },
      {
        records: Array.from({ length: 201 }, (_, i) => ({
          ...record,
          index: i + 1,
        })),
      },
      { nextCursor: '' },
    ]) {
      expect(
        contracts.IngestionCandidateRecordPageSchema.safeParse({
          ...page,
          ...changed,
        }).success,
      ).toBe(false);
    }
    const oversized = {
      ...page,
      columns: [{ key: 'c1', label: '原文' }],
      records: Array.from({ length: 16 }, (_, i) => ({
        ...record,
        index: i + 1,
        recordId: `10000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
        values: { c1: 'x'.repeat(240_000) },
      })),
    };
    expect(
      contracts.IngestionCandidateRecordPageSchema.safeParse(oversized).success,
    ).toBe(false);
  });
});
