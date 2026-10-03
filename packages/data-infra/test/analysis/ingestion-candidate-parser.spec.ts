import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as parser from '../../src/analysis/content-parser.js';

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  reviewHash: 'a'.repeat(64),
  processingBatchId: '10000000-0000-4000-8000-000000000002',
};
const assetId = '10000000-0000-4000-8000-000000000003';
const nextId = '10000000-0000-4000-8000-000000000004';
function input(text: string, format: 'csv' | 'json' = 'csv') {
  const bytes = Buffer.from(text);
  return {
    reference,
    assetId,
    bytes,
    format,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function collect(value: ReturnType<typeof input>) {
  const result: parser.AnalysisContentEvent[] = [];
  for await (const event of parser.parseIngestionCandidateContent(value))
    result.push(event);
  return result;
}
function firstRecord(events: parser.AnalysisContentEvent[]) {
  const row = events.find((event) => event.type === 'record');
  expect(row).toBeDefined();
  return row!;
}

describe('frozen candidate content parsing before publication', () => {
  it('parses original CSV without a catalog version and retains empty, zero and lexical identifiers', async () => {
    const source = input('河段,水质,备注\n潮白河,Ⅲ,\n0001,0,"原表,原值"\n');
    const result = await collect(source);
    expect(result[0]).toMatchObject({
      type: 'schema',
      columns: [
        { key: 'c1', label: '河段' },
        { key: 'c2', label: '水质' },
        { key: 'c3', label: '备注' },
      ],
    });
    expect(result[1]).toMatchObject({
      index: 1,
      values: { c1: '潮白河', c2: 'Ⅲ', c3: null },
      geometry: null,
    });
    expect(result[2]).toMatchObject({
      index: 2,
      values: { c1: '0001', c2: '0', c3: '原表,原值' },
    });
    expect(result.at(-1)).toMatchObject({
      status: 'READY',
      recordCount: 2,
      featureCount: 0,
    });
    expect(await collect(source)).toEqual(result);
  });
  it.each(['ingestionId', 'reviewHash', 'processingBatchId'] as const)(
    'changes record identity when frozen %s changes',
    async (key) => {
      const source = input('a\n1');
      const changed = {
        ...source,
        reference: {
          ...reference,
          [key]: key === 'reviewHash' ? 'b'.repeat(64) : nextId,
        },
      };
      expect(firstRecord(await collect(changed)).recordId).not.toBe(
        firstRecord(await collect(source)).recordId,
      );
    },
  );
  it('separates candidate, asset, original-content and published-version identities', async () => {
    const source = input('a\n1');
    const pending = firstRecord(await collect(source));
    expect(
      firstRecord(await collect({ ...source, assetId: nextId })).recordId,
    ).not.toBe(pending.recordId);
    expect(firstRecord(await collect(input('a\n2'))).recordId).not.toBe(
      pending.recordId,
    );
    const published: parser.AnalysisContentEvent[] = [];
    for await (const event of parser.parseAnalysisContent({
      bytes: source.bytes,
      format: source.format,
      assetId,
      sourceHash: source.sourceHash,
      dataItemId: reference.ingestionId,
      versionId: reference.processingBatchId,
    }))
      published.push(event);
    const expected = createHash('sha256')
      .update(
        [
          '1.0.0',
          reference.ingestionId,
          reference.processingBatchId,
          assetId,
          source.sourceHash,
          '1',
        ].join('\0'),
      )
      .digest('hex');
    expect(firstRecord(published).recordId).toBe(
      `${expected.slice(0, 8)}-${expected.slice(8, 12)}-8${expected.slice(13, 16)}-a${expected.slice(17, 20)}-${expected.slice(20, 32)}`,
    );
    expect(pending.recordId).not.toBe(firstRecord(published).recordId);
  });
  it('keeps declared line geometry and source identifiers without geocoding textual places', async () => {
    const source = input(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'reach-01',
            properties: { name: '潮白河', value: 0 },
            geometry: {
              type: 'LineString',
              coordinates: [
                [116, 40],
                [116.1, 40.1],
              ],
            },
          },
          {
            type: 'Feature',
            id: 'named-area',
            properties: { name: '北京市', value: null },
            geometry: null,
          },
        ],
      }),
      'json',
    );
    const result = await collect(source);
    expect(result[1]).toMatchObject({
      sourceId: 'reach-01',
      sourceCrs: 'EPSG:4326',
      values: { c1: '潮白河', c2: 0 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [116, 40],
          [116.1, 40.1],
        ],
      },
    });
    expect(result[2]).toMatchObject({
      sourceId: 'named-area',
      geometry: null,
      values: { c1: '北京市', c2: null },
    });
    expect(result.at(-1)).toMatchObject({ featureCount: 1 });
  });
  it.each([
    { reference: { ...reference, versionId: nextId } },
    { reference: { ...reference, kind: 'published-version' } },
    { reference: { ...reference, reviewHash: 'not-a-hash' } },
    { assetId: 'not-an-asset' },
    { versionId: nextId },
    { dataItemId: nextId },
  ])('rejects malformed or mixed candidate identity %#', async (change) => {
    await expect(
      collect({ ...input('a\n1'), ...change } as ReturnType<typeof input>),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
  });
  it('applies existing hash, record-cap and declared-CRS failures to pending parsing', async () => {
    await expect(
      collect({ ...input('a\n1'), sourceHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    await expect(
      collect({ ...input('a\n1\n2'), maximumRecords: 1 } as ReturnType<
        typeof input
      >),
    ).rejects.toMatchObject({ code: 'RECORD_LIMIT' });
    const invalid = input(
      JSON.stringify({
        type: 'FeatureCollection',
        crs: { properties: { name: 'EPSG:3857' } },
        features: [],
      }),
      'json',
    );
    await expect(collect(invalid)).rejects.toMatchObject({
      code: 'UNKNOWN_CRS',
    });
  });
  it('binds document locators from a copied frozen identity despite later caller mutation', () => {
    const identity = { ...input('a\n1'), reference: { ...reference } };
    const bind = parser.createIngestionCandidateRecordBinder(identity);
    const raw = {
      index: 1,
      values: { c1: 'Ⅱ', c2: null, c3: 0 },
      geometry: null,
      sourceCrs: null,
      sourceId: 'word/document.xml#table:1/row:14',
    };
    const result = bind(raw);
    identity.reference.reviewHash = 'b'.repeat(64);
    expect(bind(raw)).toEqual(result);
    expect(result).toMatchObject({
      sourceId: raw.sourceId,
      values: raw.values,
      geometry: null,
      featureId: null,
    });
    expect(() =>
      bind({
        ...raw,
        geometry: { type: 'Point', coordinates: [116, 40] },
        sourceCrs: 'EPSG:3857',
      }),
    ).toThrowError('UNKNOWN_CRS');
  });
});
