// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  IngestionCandidateAssetPage,
  IngestionCandidateRecord,
  IngestionCandidateRecordPage,
} from '@wiser/data-contracts';
import type { CandidateConversionCheck } from '@wiser/data-contracts/candidate-conversion';
import {
  CANDIDATE_MONTHLY_RULE_VERSION,
  CANDIDATE_MONTHLY_RULE_VERSION_V2,
} from '@wiser/data-core/candidate-monthly-projection';
import * as monthlyReader from '@/lib/candidate-monthly-semantic-reader';
import type { CandidateMonthlyReadInput } from '@/lib/candidate-monthly-semantic-reader';
import { IngestionCandidateReader } from './ingestion-candidate-reader';
vi.mock('./data-foundation-map', () => ({
  DataFoundationMap: () => <div>Native map</div>,
}));
vi.mock('./candidate-followup-panel', () => ({
  CandidateFollowupPanel: () => null,
}));
vi.mock('./ingestion-candidate-raster-panel', () => ({
  IngestionCandidateRasterPanel: () => null,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
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
      processingRuleVersion: CANDIDATE_MONTHLY_RULE_VERSION_V2,
    },
  };
  return { data, check, request };
}

function requestPath(url: RequestInfo | URL): string {
  return typeof url === 'string'
    ? url
    : url instanceof URL
      ? url.href
      : url.url;
}
function requestText(init?: RequestInit): string {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON string');
  return init.body;
}
function fakeHttp(
  override?: (
    path: string,
    body: Record<string, unknown>,
  ) => Response | Promise<Response> | undefined,
) {
  const { data, check } = convertedFixture();
  const get = {
    ...data.assetPages[0],
    assets: data.assetPages.flatMap((page) => page.assets),
    nextCursor: null,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = requestPath(url),
      body = JSON.parse(requestText(init)) as Record<string, unknown>;
    const replaced = override?.(path, body);
    if (replaced) return replaced;
    if (path.endsWith('/candidates/get')) return Response.json(get);
    if (path.endsWith('/candidate-provenance'))
      return Response.json({ reference, preparedAssetId: assetId, check });
    if (path.endsWith('/candidates/records'))
      return Response.json(data.recordPages[body.after ? 1 : 0]);
    throw new Error(`Unexpected test request: ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, data, check };
}
async function openMonthly(readOnly = true) {
  render(
    <IngestionCandidateReader
      reference={reference}
      locale="en"
      readOnly={readOnly}
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read monthly originals' }),
  );
  return screen.findByRole('region', { name: 'Monthly originals' });
}
it('reads actual semantic pages and selects the exact native row on a later records page', async () => {
  const { fetch } = fakeHttp();
  const panel = within(await openMonthly());
  expect(panel.getByText('2023-04')).toBeDefined();
  expect(panel.getByText('无水')).toBeDefined();
  expect(panel.getByText('封闭无法监测')).toBeDefined();
  expect(panel.getByText('Pending independent review')).toBeDefined();
  fireEvent.click(
    panel.getByRole('button', { name: 'View source row: 密云水库' }),
  );
  const selection = await screen.findByRole('button', {
    name: 'Select record 9',
  });
  expect(selection.getAttribute('aria-pressed')).toBe('true');
  expect(
    screen.getByRole('tab', { name: 'Records' }).getAttribute('aria-selected'),
  ).toBe('true');
  expect(
    fetch.mock.calls.some(
      ([url, init]) =>
        requestPath(url).endsWith('/candidates/records') &&
        requestText(init).includes('record-after-5'),
    ),
  ).toBe(true);
  expect(
    fetch.mock.calls.some(([, init]) =>
      requestText(init).includes('versionId'),
    ),
  ).toBe(false);
});
it('clears monthly values and original content when fresh authority is denied', async () => {
  let denied = false;
  fakeHttp(() => (denied ? Response.json({}, { status: 403 }) : undefined));
  await openMonthly();
  denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh candidate' }));
  await screen.findByRole('alert');
  expect(
    screen.queryByRole('region', { name: 'Monthly originals' }),
  ).toBeNull();
  expect(screen.queryByText('封闭无法监测')).toBeNull();
});
it('does not render a late provenance result after replacing the candidate owner', async () => {
  let release!: (response: Response) => void, arrived!: () => void;
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const { check } = fakeHttp((path) => {
    if (path.endsWith('/candidate-provenance')) {
      arrived();
      return pending;
    }
    return undefined;
  });
  const view = render(
    <IngestionCandidateReader reference={reference} locale="en" readOnly />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read monthly originals' }),
  );
  await entered;
  view.rerender(
    <IngestionCandidateReader
      reference={{ ...reference, reviewHash: 'f'.repeat(64) }}
      locale="en"
      readOnly
    />,
  );
  await act(async () => {
    release(Response.json({ reference, preparedAssetId: assetId, check }));
    await Promise.resolve();
  });
  expect(
    screen.queryByRole('region', { name: 'Monthly originals' }),
  ).toBeNull();
  expect(screen.queryByText('封闭无法监测')).toBeNull();
});

function topic(version = 'beijing-monthly-docx-c3/2.1.0') {
  return {
    status: 'READABLE',
    specVersion: 2,
    savedView: {
      kind: 'ingestion-candidate-view',
      viewId: savedViewId,
      title: 'Fixed monthly topic',
      visibility: 'private',
      createdAt: '2026-10-03T10:00:00Z',
      revokedAt: null,
      specVersion: 2,
    },
    references: [
      reference,
      {
        ...reference,
        ingestionId: '90000000-0000-4000-8000-000000000001',
        processingBatchId: '90000000-0000-4000-8000-000000000002',
      },
    ],
    viewSpec: {
      schemaVersion: 2,
      page: { kind: 'assets', reference, first: 50 },
      period: {
        timeRole: 'REPORT_PERIOD',
        windowMode: 'month',
        from: '2023-04',
        to: '2023-04',
        displayUnit: 'month',
        includeUndated: false,
      },
      topic: {
        question: 'Fixed source categories',
        regionIds: ['retained-region'],
        needIds: ['retained-need'],
        recordPins: [],
      },
      rulePins: [
        { kind: 'projection', ruleId: 'beijing-monthly-docx-c3', version },
        ...['readiness', 'requirement', 'impact'].map((kind) => ({
          kind,
          ruleId: `retained-${kind}`,
          version: '1',
        })),
      ],
      dependencyPins: [
        {
          kind: 'asset',
          reference,
          assetId,
          sourceHash: originalSha256,
          parserVersion: 'docx-c3-fixture',
        },
      ],
      relationPins: [],
    },
    request: {
      capabilityId: 'data.ingestion.candidate.get',
      input: { ...reference, first: 50 },
    },
  };
}
it('uses the complete topic authority before and after monthly reading, never v1 saved open', async () => {
  const { fetch } = fakeHttp((path) =>
    path.endsWith('/candidate-topics/open')
      ? Response.json(topic())
      : undefined,
  );
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={reference.ingestionId}
      savedTopicId={savedViewId}
      locale="en"
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read monthly originals' }),
  );
  await screen.findByRole('region', { name: 'Monthly originals' });
  expect(screen.getByText('封闭无法监测')).toBeDefined();
  const paths = fetch.mock.calls.map(([url]) => requestPath(url));
  expect(paths.some((path) => path.includes('candidate-saved-views'))).toBe(
    false,
  );
  const provenance = paths.lastIndexOf(
    '/api/data-foundation/candidate-provenance',
  );
  expect(provenance).toBeGreaterThan(0);
  expect(paths.at(-1)).toBe('/api/data-foundation/candidate-topics/open');
});
it('does not upgrade an old topic projection pin to trusted 2.1 consumption', async () => {
  const { fetch } = fakeHttp((path) =>
    path.endsWith('/candidate-topics/open')
      ? Response.json(topic('beijing-monthly-docx-c3/2.0.0'))
      : undefined,
  );
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={reference.ingestionId}
      savedTopicId={savedViewId}
      locale="en"
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read monthly originals' }),
  );
  const panel = within(
    await screen.findByRole('region', { name: 'Monthly originals' }),
  );
  expect(
    panel.getByText(
      'Monthly originals cannot be read yet. You can inspect the original files and parsed records.',
    ),
  ).toBeDefined();
  expect(panel.queryByText('封闭无法监测')).toBeNull();
  expect(
    fetch.mock.calls.some(([url]) =>
      requestPath(url).endsWith('/candidate-provenance'),
    ),
  ).toBe(false);
});
it('withholds monthly content if any complete topic member loses access at the final check', async () => {
  let provenanceReads = 0;
  fakeHttp((path) => {
    if (path.endsWith('/candidate-provenance')) {
      provenanceReads++;
      return undefined;
    }
    if (path.endsWith('/candidate-topics/open'))
      return provenanceReads >= 2
        ? Response.json({}, { status: 403 })
        : Response.json(topic());
    return undefined;
  });
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={reference.ingestionId}
      savedTopicId={savedViewId}
      locale="en"
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read monthly originals' }),
  );
  await screen.findByRole('alert');
  expect(
    screen.queryByRole('region', { name: 'Monthly originals' }),
  ).toBeNull();
  expect(screen.queryByText('Fixed monthly topic')).toBeNull();
});
it('immediately clears monthly output on browser restoration and rechecks the current owner', async () => {
  let restoring = false;
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const { data } = fakeHttp((path) =>
    restoring && path.endsWith('/candidates/get') ? pending : undefined,
  );
  await openMonthly();
  restoring = true;
  fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
  expect(
    screen.queryByRole('region', { name: 'Monthly originals' }),
  ).toBeNull();
  await act(async () => {
    release(
      Response.json({
        ...data.assetPages[0],
        assets: data.assetPages.flatMap((page) => page.assets),
        nextCursor: null,
      }),
    );
    await Promise.resolve();
  });
  expect(screen.queryByText('封闭无法监测')).toBeNull();
});

it('preserves bounded seeking without a semantic cursor index and never selects an unrelated row', async () => {
  const actualRead = monthlyReader.readCandidateMonthlySemantics;
  vi.spyOn(monthlyReader, 'readCandidateMonthlySemantics').mockImplementation(
    async (...args) => {
      const value = await actualRead(...args);
      return value.kind === 'READY'
        ? { ...value, recordPageIndex: undefined }
        : value;
    },
  );
  let seeking = false;
  let reads = 0;
  const { data } = convertedFixture();
  fakeHttp((path) => {
    if (seeking && path.endsWith('/candidates/records')) {
      reads++;
      return Response.json({
        ...data.recordPages[0],
        nextCursor: `unmatched-${reads}`,
      });
    }
    return undefined;
  });
  const panel = within(await openMonthly());
  seeking = true;
  fireEvent.click(
    panel.getByRole('button', { name: 'View source row: 密云水库' }),
  );
  await screen.findByText(
    'The selected record was not found within this bounded read. Continue paging to check it.',
  );
  expect(reads).toBe(10);
  expect(screen.queryByRole('button', { name: 'Select record 9' })).toBeNull();
  expect(
    screen
      .getByRole('button', { name: 'Select record 5' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
});
it('keeps report period, actual partial state and review limits visible in Chinese', async () => {
  fakeHttp();
  render(
    <IngestionCandidateReader reference={reference} locale="zh-CN" readOnly />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '读取月报原值' }));
  const panel = within(await screen.findByRole('region', { name: '月报原值' }));
  expect(panel.getByText('待独立审核')).toBeDefined();
  expect(panel.getByText('报告期')).toBeDefined();
  expect(panel.getByText('2023-04')).toBeDefined();
  expect(within(panel.getByRole('list')).getByText('历史原件')).toBeDefined();
  expect(
    panel.getByRole('button', { name: '查看原表行: 密云水库' }),
  ).toBeDefined();
});

it('connects the production panel to evidenced Chaobai K5-001 monthly readiness without district or lake inference', async () => {
  const { data } = convertedFixture();
  const scoped = data.recordPages.map((page) => ({
    ...page,
    records: page.records.map((record) =>
      record.index === 5
        ? {
            ...record,
            values: {
              ...record.values,
              c1: '潮白河水系 | 清水涧 | 密云 | 无水',
              c3: {
                ...(record.values.c3 as object),
                cells: [
                  cell(1, '潮白河水系', 'restart'),
                  cell(2, '清水涧'),
                  cell(3, '密云'),
                  cell(4, '无水'),
                ],
              },
            },
          }
        : record,
    ),
  }));
  fakeHttp((path, body) =>
    path.endsWith('/candidates/records')
      ? Response.json(scoped[body.after ? 1 : 0])
      : undefined,
  );
  const panel = within(await openMonthly());
  const scope = within(
    panel.getByRole('region', { name: 'Current monthly report readiness' }),
  );
  expect(scope.getByText('Surface water quality monitoring')).toBeDefined();
  expect(scope.getByText('Chaobai River')).toBeDefined();
  expect(scope.getByText('Mapped original rows: 1')).toBeDefined();
  expect(scope.getByText('Unmapped original rows: 2')).toBeDefined();
  expect(
    scope.getByRole('button', { name: 'View mapped source row: 清水涧' }),
  ).toBeDefined();
  expect(
    scope
      .getAllByRole('button')
      .every((button) => button.textContent?.includes('清水涧')),
  ).toBe(true);
  expect(scope.getAllByText('无水').length).toBeGreaterThan(0);
  expect(scope.queryByText('密云水库')).toBeNull();
  expect(scope.getAllByRole('group')).toHaveLength(9);
  expect(
    scope.getByText(
      'Month coverage and object correspondence remain unconfirmed. Report period is not sampling date; category inspection supplies no concentration or load calculation evidence.',
    ),
  ).toBeDefined();
});

it('selects a legitimate monthly original beyond row 500 using the acquired bounded cursor page', async () => {
  const { data } = convertedFixture();
  const expanded = [
    ...Array.from({ length: 520 }, (_, index) =>
      paragraph(index + 1, 'Synthetic non-table paragraph'),
    ),
    ...records.map((record) => ({
      ...record,
      index: record.index + 520,
      recordId: `20000000-0000-4000-8000-${String(record.index + 520).padStart(12, '0')}`,
    })),
  ];
  const get = {
    ...data.assetPages[0],
    assets: data.assetPages
      .flatMap((p) => p.assets)
      .map((asset) =>
        asset.assetId === assetId
          ? { ...asset, recordCount: expanded.length }
          : asset,
      ),
    knownRecordCount: expanded.length,
    nextCursor: null,
  };
  let seeking = false;
  let savedInput: Record<string, unknown> | null = null;
  const requested: Record<string, unknown>[] = [];
  fakeHttp((path, body) => {
    if (path.endsWith('/candidate-saved-views/create')) {
      savedInput = body;
      return Response.json({}, { status: 403 });
    }
    if (path.endsWith('/candidates/get')) return Response.json(get);
    if (path.endsWith('/candidates/records')) {
      if (seeking) requested.push(body);
      const start = body.after
        ? Number(
            (typeof body.after === 'string' ? body.after : '').replace(
              'page-',
              '',
            ),
          )
        : 0;
      const first = Number(body.first);
      return Response.json({
        reference,
        assetId,
        columns,
        records: expanded.slice(start, start + first),
        nextCursor:
          start + first < expanded.length ? `page-${start + first}` : null,
      });
    }
    return undefined;
  });
  const panel = within(await openMonthly(false));
  seeking = true;
  fireEvent.click(
    panel.getByRole('button', { name: 'View source row: 密云水库' }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Select record 529' })
        .getAttribute('aria-pressed'),
    ).toBe('true'),
  );
  expect(requested).toHaveLength(1);
  expect(requested[0]).toMatchObject({
    ...reference,
    assetId,
    after: 'page-400',
    first: 200,
  });
  fireEvent.change(screen.getByLabelText('View name'), {
    target: { value: 'Synthetic far-row read' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
  await waitFor(() => expect(savedInput).not.toBeNull());
  expect(savedInput).toMatchObject({
    viewSpec: {
      page: {
        kind: 'records',
        reference,
        assetId,
        first: 200,
        afterRecordId: expanded[399].recordId,
      },
      focus: { reference, assetId, recordId: expanded[528].recordId },
    },
  });
  expect(JSON.stringify(savedInput)).not.toContain('page-400');
  await screen.findByRole('alert');
});

for (const change of [
  'reference',
  'asset',
  'denied',
  'rule',
  'late-rule',
  'record',
] as const) {
  it(`clears indexed monthly selection beyond row 500 after fresh ${change} changes`, async () => {
    const { data, check } = convertedFixture();
    const expanded = [
      ...Array.from({ length: 520 }, (_, index) =>
        paragraph(index + 1, 'Synthetic non-table paragraph'),
      ),
      ...records.map((record) => ({
        ...record,
        index: record.index + 520,
        recordId: `20000000-0000-4000-8000-${String(record.index + 520).padStart(12, '0')}`,
      })),
    ];
    const get = {
      ...data.assetPages[0],
      assets: data.assetPages
        .flatMap((p) => p.assets)
        .map((asset) =>
          asset.assetId === assetId
            ? { ...asset, recordCount: expanded.length }
            : asset,
        ),
      knownRecordCount: expanded.length,
      nextCursor: null,
    };
    let seeking = false;
    let provenanceReads = 0;
    fakeHttp((path, body) => {
      if (seeking && path.endsWith('/candidate-provenance')) provenanceReads++;
      if (path.endsWith('/candidates/get')) return Response.json(get);
      if (
        seeking &&
        path.endsWith('/candidate-provenance') &&
        (change === 'rule' || (change === 'late-rule' && provenanceReads > 1))
      )
        return Response.json({
          reference,
          preparedAssetId: assetId,
          check: { ...check, rule: { ...check.rule, version: '2.0.0' } },
        });
      if (path.endsWith('/candidates/records')) {
        if (seeking && change === 'denied')
          return Response.json({}, { status: 403 });
        const start = body.after
          ? Number(
              (typeof body.after === 'string' ? body.after : '').replace(
                'page-',
                '',
              ),
            )
          : 0;
        const first = Number(body.first);
        return Response.json({
          reference:
            seeking && change === 'reference'
              ? { ...reference, reviewHash: 'f'.repeat(64) }
              : reference,
          assetId: seeking && change === 'asset' ? otherAssetId : assetId,
          columns,
          records: expanded
            .slice(start, start + first)
            .map((record) =>
              seeking && change === 'record' && record.index === 529
                ? { ...record, sourceId: 'table:999/row:2' }
                : record,
            ),
          nextCursor:
            start + first < expanded.length ? `page-${start + first}` : null,
        });
      }
      return undefined;
    });
    const panel = within(await openMonthly());
    seeking = true;
    fireEvent.click(
      panel.getByRole('button', { name: 'View source row: 密云水库' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('region', { name: 'Monthly originals' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Select record 529' }),
    ).toBeNull();
    expect(screen.queryByText('封闭无法监测')).toBeNull();
  });
}

it('uses the acquired monthly cursor when legitimate short pages place a nearby row beyond ten pages', async () => {
  const { data } = convertedFixture();
  const expanded = [
    ...Array.from({ length: 220 }, (_, index) =>
      paragraph(index + 1, 'Synthetic non-table paragraph'),
    ),
    ...records.map((record) => ({
      ...record,
      index: record.index + 220,
      recordId: `20000000-0000-4000-8000-${String(record.index + 220).padStart(12, '0')}`,
    })),
  ];
  const get = {
    ...data.assetPages[0],
    assets: data.assetPages
      .flatMap((p) => p.assets)
      .map((asset) =>
        asset.assetId === assetId
          ? { ...asset, recordCount: expanded.length }
          : asset,
      ),
    knownRecordCount: expanded.length,
    nextCursor: null,
  };
  let seeking = false;
  const requested: Record<string, unknown>[] = [];
  fakeHttp((path, body) => {
    if (path.endsWith('/candidates/get')) return Response.json(get);
    if (path.endsWith('/candidates/records')) {
      if (seeking) requested.push(body);
      const start =
        typeof body.after === 'string'
          ? Number(body.after.replace('short-page-', ''))
          : 0;
      // The records contract permits byte-budget-shortened pages below requested first.
      const delivered = Math.min(Number(body.first), 20);
      return Response.json({
        reference,
        assetId,
        columns,
        records: expanded.slice(start, start + delivered),
        nextCursor:
          start + delivered < expanded.length
            ? `short-page-${start + delivered}`
            : null,
      });
    }
    return undefined;
  });
  const panel = within(await openMonthly());
  seeking = true;
  fireEvent.click(
    panel.getByRole('button', { name: 'View source row: 密云水库' }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Select record 229' })
        .getAttribute('aria-pressed'),
    ).toBe('true'),
  );
  expect(requested).toEqual([
    { ...reference, assetId, first: 200, after: 'short-page-220' },
  ]);
});
