import type { CandidateConversionCheck } from '@wiser/data-contracts/candidate-conversion';
import { describe, expect, it, vi } from 'vitest';
import type {
  IngestionCandidateAssetPage,
  IngestionCandidateRecord,
  IngestionCandidateRecordPage,
} from '@wiser/data-contracts';
import {
  CANDIDATE_MONTHLY_RULE_VERSION,
  CANDIDATE_MONTHLY_RULE_VERSION_V2,
  CANDIDATE_MONTHLY_RULE_VERSION_V3,
} from '@wiser/data-core/candidate-monthly-projection';
import {
  readCandidateMonthlySemantics,
  type CandidateMonthlyReadInput,
} from './candidate-monthly-semantic-reader';

const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: '10000000-0000-4000-8000-000000000001',
  reviewHash: 'a'.repeat(64),
  processingBatchId: '10000000-0000-4000-8000-000000000002',
};
const assetId = '10000000-0000-4000-8000-000000000003';
const otherAssetId = '10000000-0000-4000-8000-000000000004';
const savedViewId = '10000000-0000-4000-8000-000000000005';
const originalSha256 = 'b'.repeat(64);
const columns = [
  { key: 'c1', label: 'Text' },
  { key: 'c2', label: 'Source location' },
  { key: 'c3', label: 'Source table structure' },
];
const input: CandidateMonthlyReadInput = {
  reference,
  assetId,
  fixed: {
    sourceLocalWorkId: 'monthly-source-work-2023-04',
    originalSha256,
    preparedSha256: originalSha256,
    processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
  },
};

function cell(
  column: number,
  text: string,
  verticalMerge: string | null = null,
) {
  return { column, columnSpan: 1, verticalMerge, text };
}
function paragraph(index: number, text: string): IngestionCandidateRecord {
  return {
    recordId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    assetId,
    index,
    sourceId: `paragraph:${index}`,
    values: { c1: text, c2: `word/document.xml#paragraph:${index}` },
    hasGeometry: false,
  };
}
function row(
  index: number,
  tableIndex: number,
  rowIndex: number,
  cells: ReturnType<typeof cell>[],
): IngestionCandidateRecord {
  return {
    recordId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    assetId,
    index,
    sourceId: `table:${tableIndex}/row:${rowIndex}`,
    values: {
      c1: cells.map((entry) => entry.text).join(' | '),
      c2: `word/document.xml#table:${tableIndex}/row:${rowIndex}`,
      c3: {
        kind: 'word_table_row',
        sourcePart: 'word/document.xml',
        tableIndex,
        rowIndex,
        cells,
      },
    },
    hasGeometry: false,
  };
}
const records: IngestionCandidateRecord[] = [
  paragraph(1, '表1 2023年4月河流水质状况'),
  paragraph(2, '表2 2023年4月重点湖泊水质状况'),
  paragraph(3, '表3 2023年4月大中型水库水质状况'),
  row(4, 1, 1, [
    cell(1, '水系'),
    cell(2, '河流（河段）'),
    cell(3, '所在区'),
    cell(4, '现状水质类别'),
  ]),
  row(5, 1, 2, [
    cell(1, '永定河水系', 'restart'),
    cell(2, '清水涧'),
    cell(3, '门头沟'),
    cell(4, '无水'),
  ]),
  row(6, 2, 1, [cell(1, '湖泊'), cell(2, '所在区'), cell(3, '现状水质类别')]),
  row(7, 2, 2, [cell(1, '团城湖'), cell(2, '海淀'), cell(3, 'Ⅱ')]),
  row(8, 3, 1, [cell(1, '水库'), cell(2, '所在区'), cell(3, '现状水质类别')]),
  row(9, 3, 2, [cell(1, '密云水库'), cell(2, '密云'), cell(3, '封闭无法监测')]),
  row(10, 4, 1, [cell(1, '水质类别'), cell(2, '适用范围')]),
  row(11, 4, 2, [cell(1, 'I类'), cell(2, '主要适用于源头水')]),
];

function fixture() {
  const assetPages: IngestionCandidateAssetPage[] = [
    {
      reference,
      parserVersion: 'docx-c3-fixture',
      status: 'READY',
      createdAt: '2026-10-03T10:00:00Z',
      totalAssetCount: 2,
      knownRecordCount: records.length,
      knownFeatureCount: 0,
      unknownAssetCount: 0,
      assets: [
        {
          assetId,
          sourceHash: originalSha256,
          status: 'READY',
          recordCount: records.length,
          featureCount: 0,
          reason: null,
        },
      ],
      nextCursor: 'asset-after-1',
    },
    {
      reference,
      parserVersion: 'docx-c3-fixture',
      status: 'READY',
      createdAt: '2026-10-03T10:00:00Z',
      totalAssetCount: 2,
      knownRecordCount: records.length,
      knownFeatureCount: 0,
      unknownAssetCount: 0,
      assets: [
        {
          assetId: otherAssetId,
          sourceHash: 'c'.repeat(64),
          status: 'EMPTY',
          recordCount: 0,
          featureCount: 0,
          reason: null,
        },
      ],
      nextCursor: null,
    },
  ];
  const recordPages: IngestionCandidateRecordPage[] = [
    {
      reference,
      assetId,
      columns,
      records: records.slice(0, 5),
      nextCursor: 'record-after-5',
    },
    {
      reference,
      assetId,
      columns,
      records: records.slice(5),
      nextCursor: null,
    },
  ];
  return { assetPages, recordPages };
}

it('dispatches the fixed v2 producer to report period while retaining v1 publication semantics', async () => {
  const result = await readCandidateMonthlySemantics(
    {
      ...input,
      fixed: {
        ...input.fixed,
        processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V2,
      },
    },
    new AbortController().signal,
    transport(),
  );
  expect(result).toMatchObject({
    kind: 'READY',
    reportPeriod: '2023-04',
    batchStatus: 'READY',
    conversionEvidence: null,
    publicationMonth: null,
    processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V2,
  });
  expect(result.records).toHaveLength(3);
  expect(result.records[0]).toMatchObject({
    time: { value: '2023-04', role: 'REPORT_PERIOD', precision: 'MONTH' },
    processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V2,
  });
  const legacy = await readCandidateMonthlySemantics(
    input,
    new AbortController().signal,
    transport(),
  );
  expect(legacy).toMatchObject({
    kind: 'READY',
    publicationMonth: '2023-04',
    processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
  });
  expect(legacy.records[0].time.role).toBe('PUBLICATION');
});

function savedOpen() {
  return {
    kind: 'ingestion-candidate-view',
    savedView: {
      kind: 'ingestion-candidate-view',
      viewId: savedViewId,
      title: 'Fixed monthly candidate',
      visibility: 'private',
      createdAt: '2026-10-03T10:00:00Z',
      revokedAt: null,
    },
    references: [reference],
    viewSpec: { page: { kind: 'records', reference, assetId, first: 50 } },
    request: {
      capabilityId: 'data.ingestion.candidate.records',
      input: { ...reference, assetId, first: 50 },
    },
  };
}

function requestPath(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function transport(
  data = fixture(),
  overrides: {
    onCall?: (
      url: string,
      body: Record<string, unknown>,
    ) => Response | undefined;
    saved?: unknown;
  } = {},
) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((url, init) => {
      const body = requestBody(init);
      const path = requestPath(url);
      const override = overrides.onCall?.(path, body);
      if (override) return Promise.resolve(override);
      if (path.endsWith('/candidate-saved-views/open'))
        return Promise.resolve(Response.json(overrides.saved ?? savedOpen()));
      if (path.endsWith('/candidate-provenance'))
        return Promise.resolve(
          Response.json({ reference, preparedAssetId: assetId, check: null }),
        );
      if (path.endsWith('/candidates/get'))
        return Promise.resolve(
          Response.json(data.assetPages[body.after ? 1 : 0]),
        );
      if (path.endsWith('/candidates/records'))
        return Promise.resolve(
          Response.json(data.recordPages[body.after ? 1 : 0]),
        );
      throw new Error(`Unexpected route ${path}`);
    });
  return fetch;
}

describe('current-authority candidate monthly semantic read', () => {
  it('collects complete fixed pages before projecting original values and provenance, then rechecks current access', async () => {
    const fetch = transport();
    const result = await readCandidateMonthlySemantics(
      input,
      new AbortController().signal,
      fetch,
    );
    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') return;
    expect(result.records).toHaveLength(3);
    if (result.kind !== 'READY') throw new Error('Expected READY');
    expect(
      result.recordPageIndex?.find(
        (position) => position.recordId === records[8].recordId,
      ),
    ).toEqual({
      recordId: records[8].recordId,
      first: 200,
      after: 'record-after-5',
      anchor: records[4].recordId,
      previous: [{ first: 200 }],
    });
    expect(result.records[0]).toMatchObject({
      candidateReference: reference,
      source: {
        sourceLocalWorkId: input.fixed.sourceLocalWorkId,
        assetId,
        originalSha256,
        preparedSha256: originalSha256,
      },
      sourceLocalIdentity: { sourceId: 'table:1/row:2', index: 5 },
      originalName: '清水涧',
      rawCategory: '无水',
      time: { value: '2023-04', role: 'PUBLICATION', precision: 'MONTH' },
      locators: {
        row: 'word/document.xml#table:1/row:2',
        categoryCell: 'word/document.xml#table:1/row:2/column:4',
      },
      processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /versionId|objectId|dataItemId|geometry/,
    );
    const calls = fetch.mock.calls.map(([url, init]) => ({
      path: requestPath(url),
      body: requestBody(init),
    }));
    expect(calls.map(({ path }) => path.split('/').at(-1))).toEqual([
      'get',
      'get',
      'records',
      'records',
      'get',
    ]);
    expect(
      calls.every(
        ({ body }) => !('tenantId' in body) && !('projectId' in body),
      ),
    ).toBe(true);
  });

  it('reopens the standard saved view before and after reading, and rejects a changed or revoked selection', async () => {
    const fixed = { ...input, savedViewId };
    const fetch = transport();
    const result = await readCandidateMonthlySemantics(
      fixed,
      new AbortController().signal,
      fetch,
    );
    expect(result.kind).toBe('READY');
    expect(
      fetch.mock.calls.filter(([url]) =>
        requestPath(url).endsWith('/candidate-saved-views/open'),
      ),
    ).toHaveLength(2);
    const wrong = transport(fixture(), {
      saved: {
        ...savedOpen(),
        viewSpec: {
          page: {
            kind: 'records',
            reference,
            assetId: otherAssetId,
            first: 50,
          },
        },
      },
    });
    await expect(
      readCandidateMonthlySemantics(fixed, new AbortController().signal, wrong),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(
      wrong.mock.calls.some(([url]) =>
        requestPath(url).endsWith('/candidates/get'),
      ),
    ).toBe(false);
  });

  it('does not mark a partial batch, missing source-local work identity, or unproven DOC conversion READY', async () => {
    const partial = fixture();
    partial.assetPages = partial.assetPages.map((page) => ({
      ...page,
      status: 'PARTIAL',
      assets: page.assets.map((asset) =>
        asset.assetId === otherAssetId
          ? { ...asset, status: 'PARTIAL', reason: 'PARTIAL_PARSE' }
          : asset,
      ),
    }));
    const result = await readCandidateMonthlySemantics(
      input,
      new AbortController().signal,
      transport(partial),
    );
    expect(result).toMatchObject({
      kind: 'NOT_PARSED',
      reason: 'SOURCE_NOT_READY',
      records: [],
    });
    expect(
      await readCandidateMonthlySemantics(
        { ...input, fixed: { ...input.fixed, sourceLocalWorkId: null } },
        new AbortController().signal,
        transport(),
      ),
    ).toMatchObject({
      kind: 'NOT_PARSED',
      reason: 'MISSING_SOURCE_LOCAL_IDENTITY',
      records: [],
    });
    expect(
      await readCandidateMonthlySemantics(
        { ...input, fixed: { ...input.fixed, originalSha256: 'd'.repeat(64) } },
        new AbortController().signal,
        transport(),
      ),
    ).toMatchObject({
      kind: 'NOT_PARSED',
      reason: 'CONVERSION_PROVENANCE_UNAVAILABLE',
      records: [],
    });
    expect(
      await readCandidateMonthlySemantics(
        { ...input, fixed: { ...input.fixed, originalSha256: null } },
        new AbortController().signal,
        transport(),
      ),
    ).toMatchObject({
      kind: 'NOT_PARSED',
      reason: 'MISSING_ORIGINAL_HASH',
      records: [],
    });
    expect(
      await readCandidateMonthlySemantics(
        {
          ...input,
          fixed: { ...input.fixed, preparedSha256: 'e'.repeat(64) },
        },
        new AbortController().signal,
        transport(),
      ),
    ).toMatchObject({
      kind: 'NOT_PARSED',
      reason: 'SOURCE_CHANGED',
      records: [],
    });
  });

  it('rejects missing, reordered, or duplicated records and changed asset metadata without partial output', async () => {
    const incomplete = fixture();
    incomplete.assetPages = incomplete.assetPages.map((page) => ({
      ...page,
      assets: page.assets.map((asset) =>
        asset.assetId === assetId
          ? { ...asset, recordCount: records.length + 1 }
          : asset,
      ),
    }));
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        transport(incomplete),
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    const reordered = fixture();
    reordered.recordPages.reverse();
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        transport(reordered),
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    const duplicate = fixture();
    duplicate.recordPages[1] = {
      ...duplicate.recordPages[1],
      records: [
        duplicate.recordPages[0].records[0],
        ...duplicate.recordPages[1].records,
      ],
    };
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        transport(duplicate),
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    const changed = fixture();
    changed.assetPages[1] = {
      ...changed.assetPages[1],
      parserVersion: 'changed-parser',
    };
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        transport(changed),
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    const unknown = fixture();
    unknown.recordPages[1] = {
      ...unknown.recordPages[1],
      records: unknown.recordPages[1].records.map((record) =>
        record.index === 9
          ? { ...record, values: { ...record.values, c1: 'changed layout' } }
          : record,
      ),
    };
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        transport(unknown),
      ),
    ).resolves.toMatchObject({
      kind: 'NOT_PARSED',
      reason: 'UNKNOWN_LAYOUT',
      records: [],
    });
  });

  it('rejects a cursor cycle and bounded page exhaustion', async () => {
    const cycle = fixture();
    const thirdAssetId = '10000000-0000-4000-8000-000000000006';
    const cycleFetch = transport(cycle, {
      onCall: (url, body) => {
        if (!url.endsWith('/candidates/get')) return undefined;
        const next =
          body.after === 'asset-after-2'
            ? {
                ...cycle.assetPages[1],
                totalAssetCount: 3,
                assets: [
                  { ...cycle.assetPages[1].assets[0], assetId: thirdAssetId },
                ],
                nextCursor: 'asset-after-1',
              }
            : body.after === 'asset-after-1'
              ? {
                  ...cycle.assetPages[1],
                  totalAssetCount: 3,
                  nextCursor: 'asset-after-2',
                }
              : {
                  ...cycle.assetPages[0],
                  totalAssetCount: 3,
                };
        return Response.json(next);
      },
    });
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        cycleFetch,
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(
      cycleFetch.mock.calls.filter(([url]) =>
        requestPath(url).endsWith('/candidates/get'),
      ),
    ).toHaveLength(3);
    let sequence = 0;
    const unbounded = transport(fixture(), {
      onCall: (url) => {
        if (!url.endsWith('/candidates/get')) return undefined;
        sequence++;
        return Response.json({
          ...fixture().assetPages[0],
          totalAssetCount: 10_000,
          assets: [
            {
              ...fixture().assetPages[0].assets[0],
              assetId: `30000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
            },
          ],
          nextCursor: `page-${sequence}`,
        });
      },
    });
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        unbounded,
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(sequence).toBeLessThanOrEqual(101);
  });

  it('propagates current denial, expiry, and cancellation without a READY result', async () => {
    const denied = transport(fixture(), {
      onCall: (url, body) =>
        url.endsWith('/candidates/records') && body.after
          ? new Response('', { status: 403 })
          : undefined,
    });
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        denied,
      ),
    ).rejects.toMatchObject({ kind: 'denied' });
    let gets = 0;
    const expired = transport(fixture(), {
      onCall: (url) => {
        if (!url.endsWith('/candidates/get')) return undefined;
        gets++;
        return gets === 3 ? new Response('', { status: 410 }) : undefined;
      },
    });
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        expired,
      ),
    ).rejects.toMatchObject({ kind: 'stale' });
    let currentGets = 0;
    const changedAtRecheck = transport(fixture(), {
      onCall: (url) => {
        if (!url.endsWith('/candidates/get')) return undefined;
        currentGets++;
        return currentGets === 3
          ? Response.json({
              ...fixture().assetPages[0],
              parserVersion: 'new-fixed-parser-run',
            })
          : undefined;
      },
    });
    await expect(
      readCandidateMonthlySemantics(
        input,
        new AbortController().signal,
        changedAtRecheck,
      ),
    ).rejects.toMatchObject({ kind: 'stale' });
    let opens = 0;
    const revokedSaved = transport(fixture(), {
      onCall: (url) => {
        if (!url.endsWith('/candidate-saved-views/open')) return undefined;
        opens++;
        return opens === 2 ? new Response('', { status: 410 }) : undefined;
      },
    });
    await expect(
      readCandidateMonthlySemantics(
        { ...input, savedViewId },
        new AbortController().signal,
        revokedSaved,
      ),
    ).rejects.toMatchObject({ kind: 'stale' });
    const abort = new AbortController();
    const cancelled = transport(fixture(), {
      onCall: (url, body) => {
        if (url.endsWith('/candidates/records') && body.after) abort.abort();
        return undefined;
      },
    });
    await expect(
      readCandidateMonthlySemantics(input, abort.signal, cancelled),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

function convertedFixture() {
  const data = fixture();
  const manifestId = '30000000-0000-4000-8000-000000000002';
  const check: CandidateConversionCheck = {
    schemaVersion: 1,
    resultId: '30000000-0000-4000-8000-000000000003',
    reference,
    kind: 'HISTORICAL_EQUIVALENCE',
    state: 'VERIFIED_EQUIVALENT',
    original: { assetId: otherAssetId, sha256: 'c'.repeat(64), byteSize: 12 },
    prepared: { assetId, sha256: originalSha256, byteSize: 18 },
    manifest: { assetId: manifestId, sha256: 'd'.repeat(64) },
    sourceLocalWorkId: 'server-monthly-work',
    historicalToolVersion: null,
    rule: { id: 'candidate-word-equivalence', version: '1.0.0' },
    tool: {
      name: 'test-converter',
      version: 'test-only',
      digest: 'e'.repeat(64),
    },
    reconvertedSha256: 'f'.repeat(64),
    comparisonDigest: '1'.repeat(64),
    comparison: {
      tableCount: 4,
      physicalCellCount: 31,
      emptyCellCount: 1,
      paragraphCount: 3,
      monthTitleCount: 3,
      differenceCount: 0,
      differences: [],
    },
    failureReason: null,
  };
  data.assetPages = data.assetPages.map((page) => ({
    ...page,
    status: 'PARTIAL',
    totalAssetCount: 3,
    unknownAssetCount: 2,
  }));
  data.assetPages[1].assets = [
    {
      assetId: otherAssetId,
      sourceHash: check.original.sha256,
      status: 'UNSUPPORTED',
      reason: 'UNSUPPORTED_FORMAT',
      recordCount: null,
      featureCount: null,
    },
    {
      assetId: manifestId,
      sourceHash: check.manifest.sha256,
      status: 'UNSUPPORTED',
      reason: 'SOURCE_MANIFEST',
      recordCount: null,
      featureCount: null,
    },
  ];
  const request = {
    ...input,
    fixed: {
      ...input.fixed,
      processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V3,
    },
  };
  return { data, check, request };
}

describe('server-verified v3 monthly consumption', () => {
  it('reads and rechecks server provenance, retaining the real batch status and server O/work identity', async () => {
    const { data, check, request } = convertedFixture();
    const fetch = transport(data, {
      onCall: (path) =>
        path.endsWith('/candidate-provenance')
          ? Response.json({ reference, preparedAssetId: assetId, check })
          : undefined,
    });
    const result = await readCandidateMonthlySemantics(
      request,
      new AbortController().signal,
      fetch,
    );
    expect(result).toMatchObject({
      kind: 'READY',
      batchStatus: 'PARTIAL',
      conversionMembers: [
        {
          role: 'original',
          assetId: check.original.assetId,
          status: data.assetPages
            .flatMap((page) => page.assets)
            .find((asset) => asset.assetId === check.original.assetId)!.status,
          reason: data.assetPages
            .flatMap((page) => page.assets)
            .find((asset) => asset.assetId === check.original.assetId)!.reason,
        },
        { role: 'prepared', assetId, status: 'READY', reason: null },
        {
          role: 'manifest',
          assetId: check.manifest.assetId,
          status: 'UNSUPPORTED',
          reason: 'SOURCE_MANIFEST',
        },
      ],
      reportPeriod: '2023-04',
      conversionEvidence: {
        resultId: check.resultId,
        state: 'VERIFIED_EQUIVALENT',
        original: check.original,
        prepared: check.prepared,
      },
    });
    expect(result.records).toHaveLength(3);
    expect(result.records[0].source).toEqual({
      sourceLocalWorkId: check.sourceLocalWorkId,
      assetId,
      originalSha256: check.original.sha256,
      preparedSha256: check.prepared.sha256,
    });
    expect(
      fetch.mock.calls.filter(([url]) =>
        requestPath(url).endsWith('/candidate-provenance'),
      ),
    ).toHaveLength(2);
    expect(data.assetPages[0].status).toBe('PARTIAL');
  });

  it.each(['missing', 'unverified', 'member', 'rule', 'hash', 'other-failure'])(
    'does not trust caller equal hashes or %s server evidence',
    async (caseName) => {
      const { data, check, request } = convertedFixture();
      let value: CandidateConversionCheck | null = check;
      if (caseName === 'missing') value = null;
      if (caseName === 'unverified')
        value = {
          ...check,
          state: 'UNVERIFIABLE',
          comparison: null,
          failureReason: 'TOOL_UNAVAILABLE',
        };
      if (caseName === 'member') check.prepared.assetId = otherAssetId;
      if (caseName === 'rule') check.rule.version = 'unapproved';
      if (caseName === 'hash') check.original.sha256 = '9'.repeat(64);
      if (caseName === 'other-failure') {
        for (const page of data.assetPages) {
          page.totalAssetCount++;
          page.unknownAssetCount++;
        }
        data.assetPages[1].assets.push({
          ...data.assetPages[1].assets[0],
          assetId: '30000000-0000-4000-8000-000000000004',
          status: 'INVALID',
          reason: 'PARSE_FAILED',
        });
      }
      const fetch = transport(data, {
        onCall: (path) =>
          path.endsWith('/candidate-provenance')
            ? Response.json({
                reference,
                preparedAssetId: assetId,
                check: value,
              })
            : undefined,
      });
      const result = await readCandidateMonthlySemantics(
        request,
        new AbortController().signal,
        fetch,
      ).catch((error: unknown) => error);
      if (caseName === 'member')
        expect(result).toMatchObject({ kind: 'invalid' });
      else
        expect(result).toMatchObject({
          kind: 'NOT_PARSED',
          reason:
            caseName === 'missing'
              ? 'SOURCE_NOT_READY'
              : 'CONVERSION_PROVENANCE_UNAVAILABLE',
          records: [],
        });
      expect(
        fetch.mock.calls.some(([url]) =>
          requestPath(url).endsWith('/candidates/records'),
        ),
      ).toBe(false);
    },
  );

  it.each(['changed', 'denied', 'cancelled'])(
    'rejects %s final provenance after all records without releasing semantic output',
    async (caseName) => {
      const { data, check, request } = convertedFixture();
      const abort = new AbortController();
      let reads = 0;
      const fetch = transport(data, {
        onCall: (path) => {
          if (!path.endsWith('/candidate-provenance')) return undefined;
          reads++;
          if (reads === 2 && caseName === 'denied')
            return Response.json({}, { status: 403 });
          if (reads === 2 && caseName === 'cancelled') abort.abort();
          return Response.json({
            reference,
            preparedAssetId: assetId,
            check:
              reads === 2 && caseName === 'changed'
                ? { ...check, resultId: '30000000-0000-4000-8000-000000000099' }
                : check,
          });
        },
      });
      await expect(
        readCandidateMonthlySemantics(request, abort.signal, fetch),
      ).rejects.toMatchObject({
        kind: caseName === 'changed' ? 'stale' : caseName,
      });
      expect(reads).toBe(2);
    },
  );
});

it('discards a late final provenance response after cancellation', async () => {
  const { data, check, request } = convertedFixture();
  const controller = new AbortController();
  let finish!: (value: Response) => void;
  let reached!: () => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let count = 0;
  const base = transport(data, {
    onCall: (path) =>
      path.endsWith('/candidate-provenance')
        ? Response.json({ reference, preparedAssetId: assetId, check })
        : undefined,
  });
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (requestPath(url).endsWith('/candidate-provenance') && ++count === 2) {
      reached();
      return pending;
    }
    return base(url, init);
  };
  const result = readCandidateMonthlySemantics(
    request,
    controller.signal,
    fetch,
  );
  const settled = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await entered;
  controller.abort();
  finish(Response.json({ reference, preparedAssetId: assetId, check }));
  expect(await settled).toMatchObject({ error: { kind: 'cancelled' } });
});

it('rechecks the saved selection for verified conversion and rejects changed fixed content', async () => {
  const { data, check, request } = convertedFixture();
  let opens = 0;
  const fetch = transport(data, {
    onCall: (path) => {
      if (path.endsWith('/candidate-provenance'))
        return Response.json({ reference, preparedAssetId: assetId, check });
      if (path.endsWith('/candidate-saved-views/open') && ++opens === 2)
        return Response.json({
          ...savedOpen(),
          savedView: { ...savedOpen().savedView, title: 'changed fixed view' },
        });
      return undefined;
    },
  });
  await expect(
    readCandidateMonthlySemantics(
      { ...request, savedViewId },
      new AbortController().signal,
      fetch,
    ),
  ).rejects.toMatchObject({ kind: 'stale' });
  expect(opens).toBe(2);
});

it('keeps old 2.0.0 PARTIAL reads closed without silently adopting the new producer', async () => {
  const { data, request } = convertedFixture();
  const fetch = transport(data);
  const result = await readCandidateMonthlySemantics(
    {
      ...request,
      fixed: {
        ...request.fixed,
        processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V2,
      },
    },
    new AbortController().signal,
    fetch,
  );
  expect(result).toMatchObject({
    kind: 'NOT_PARSED',
    reason: 'SOURCE_NOT_READY',
    processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V2,
  });
  expect(
    fetch.mock.calls.some(([url]) =>
      requestPath(url).endsWith('/candidate-provenance'),
    ),
  ).toBe(false);
});
it('keeps old 2.0.0 READY reads independent of the new provenance capability', async () => {
  const fetch = transport(fixture(), {
    onCall: (path) =>
      path.endsWith('/candidate-provenance')
        ? Response.json({}, { status: 404 })
        : undefined,
  });
  const result = await readCandidateMonthlySemantics(
    {
      ...input,
      fixed: {
        ...input.fixed,
        processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V2,
      },
    },
    new AbortController().signal,
    fetch,
  );
  expect(result).toMatchObject({
    kind: 'READY',
    processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V2,
  });
  expect(
    fetch.mock.calls.some(([url]) =>
      requestPath(url).endsWith('/candidate-provenance'),
    ),
  ).toBe(false);
});
