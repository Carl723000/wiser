import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as adapters from '../src/adapters/analysis-parser.js';
import type { AnalysisContentEvent } from '@wiser/data-infra';

const bytes = Buffer.from('synthetic document original');
const sourceHash = createHash('sha256').update(bytes).digest('hex');
const input = {
  bytes,
  sourceHash,
  assetId: '10000000-0000-4000-8000-000000000003',
  reference: {
    kind: 'ingestion-candidate' as const,
    ingestionId: '10000000-0000-4000-8000-000000000001',
    reviewHash: 'a'.repeat(64),
    processingBatchId: '10000000-0000-4000-8000-000000000002',
  },
  format: 'docx',
  path: 'monthly.docx',
};
const frames = [
  { type: 'source', sha256: sourceHash, parserVersion: '1.0.0' },
  {
    type: 'schema',
    columns: [
      { key: 'c1', label: '水质' },
      { key: 'c2', label: '缺值' },
    ],
  },
  {
    type: 'record',
    index: 1,
    recordId: 'supplier-must-not-control-id',
    values: { c1: 'Ⅲ', c2: null },
    geometry: null,
    sourceId: 'word/document.xml#table:1/row:14',
    sourceCrs: null,
  },
  {
    type: 'summary',
    status: 'PARTIAL',
    reason: 'SOURCE_LOCATION_UNRESOLVED',
    recordCount: 1,
    featureCount: 0,
  },
];
function response(values: readonly unknown[]) {
  return new Response(
    values.map((value) => JSON.stringify(value)).join('\n') + '\n',
    { headers: { 'content-type': 'application/x-ndjson' } },
  );
}
async function collect(value = input, values: readonly unknown[] = frames) {
  const result: AnalysisContentEvent[] = [];
  const parse = adapters.createExternalIngestionCandidateParser({
    endpoint: 'http://source-parser:3005',
    fetch: () => Promise.resolve(response(values)),
  });
  for await (const event of parse(value)) result.push(event);
  return result;
}
describe('pending candidate isolated parser transport', () => {
  it('retains raw document locators and partial outcome while binding worker-controlled candidate IDs', async () => {
    const result = await collect();
    expect(result[1]).toMatchObject({
      values: { c1: 'Ⅲ', c2: null },
      sourceId: 'word/document.xml#table:1/row:14',
      geometry: null,
      featureId: null,
    });
    if (result[1]?.type !== 'record')
      throw new Error('Expected original record');
    expect(result[1].recordId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result[1].recordId).not.toBe('supplier-must-not-control-id');
    expect(result.at(-1)).toMatchObject({
      status: 'PARTIAL',
      reason: 'SOURCE_LOCATION_UNRESOLVED',
    });
    expect(await collect()).toEqual(result);
    expect(
      (
        await collect({
          ...input,
          reference: {
            ...input.reference,
            processingBatchId: '10000000-0000-4000-8000-000000000004',
          },
        })
      )[1],
    ).not.toEqual(result[1]);
  });
  it('sends only original bytes, hash and file shape to the isolated parser', async () => {
    let payload: unknown;
    const parse = adapters.createExternalIngestionCandidateParser({
      endpoint: 'http://source-parser:3005',
      fetch: (_url, options) => {
        if (typeof options?.body !== 'string')
          throw new Error('Expected JSON parser request body');
        payload = JSON.parse(options.body);
        return Promise.resolve(response(frames));
      },
    });
    for await (const _event of parse(input)) {
      /* consume */
    }
    expect(payload).toEqual({
      format: 'docx',
      primary: 'monthly.docx',
      files: [
        {
          name: 'monthly.docx',
          sha256: sourceHash,
          base64: bytes.toString('base64'),
        },
      ],
    });
  });
  it('rejects mixed identity and changed bytes before contacting a parser', async () => {
    let called = false;
    const parse = adapters.createExternalIngestionCandidateParser({
      endpoint: 'http://source-parser:3005',
      fetch: () => {
        called = true;
        return Promise.resolve(response(frames));
      },
    });
    for (const changed of [
      { ...input, versionId: input.reference.ingestionId },
      { ...input, sourceHash: '0'.repeat(64) },
    ]) {
      await expect(async () => {
        for await (const _event of parse(changed)) {
          /* consume */
        }
      }).rejects.toBeDefined();
    }
    expect(called).toBe(false);
  });
  it.each([
    frames.slice(0, -1),
    [{ ...frames[0], sha256: '0'.repeat(64) }, ...frames.slice(1)],
    [...frames.slice(0, 2), { ...frames[2], index: 2 }, frames[3]],
    [
      ...frames.slice(0, 2),
      { ...frames[2], values: { undeclared: 'hidden' } },
      frames[3],
    ],
    [...frames.slice(0, 3), { ...frames[3], recordCount: 2 }],
  ])(
    'rejects incomplete or inconsistent candidate frames %#',
    async (...values) => {
      await expect(collect(input, values)).rejects.toMatchObject({
        code: 'INVALID_CONTENT',
      });
    },
  );
});
