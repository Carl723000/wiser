import { afterEach, describe, expect, it } from 'vitest';
import {
  CnemcOfflineError,
  CnemcLoopbackClient,
  buildCnemcRequest,
  decodeCnemcResponse,
  inspectCnemcPages,
  startSyntheticSupplier,
  syntheticEnvelope,
  type CnemcQuery,
  type SyntheticSupplier,
} from '../src/connectors/cnemc-offline/index.js';

const daily: CnemcQuery = {
  resource: 'daily',
  startDate: '2026-08-01',
  endDate: '2026-08-31',
  evaluationSystem: '十五五',
  stationCode: 'SYNTHETIC_STATION',
};
const monthly: CnemcQuery = {
  resource: 'monthly',
  year: 2026,
  month: 8,
  datatype: 'month',
};
function page(offset: number, size: number, total: number, start = offset) {
  return decodeCnemcResponse(
    'daily',
    JSON.stringify(syntheticEnvelope('daily', size, total, start)),
    offset,
  );
}

describe('offline CNEMC request protocol', () => {
  it('uses only the documented daily query, POST, empty body and fixed page stride', () => {
    const request = buildCnemcRequest(daily, 1000);
    expect(request).toEqual({
      resource: 'daily',
      method: 'POST',
      path: '/synthetic/daily',
      body: '',
      query: {
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        evaluation_system: '十五五',
        stationCode: 'SYNTHETIC_STATION',
        offsetValue: '1000',
      },
      uniqueIdSemantics: 'unknown',
    });
  });

  it.each([
    [1, "'01'"],
    [8, "'08'"],
    [9, "'09'"],
    [10, '10'],
    [12, '12'],
  ])('preserves literal month quoting for month %s', (month, expected) => {
    const request = buildCnemcRequest({ ...monthly, month });
    expect(request.query).toEqual({
      datatype: 'month',
      wq_inf_year: '2026',
      wq_inf_month: expected,
      offsetValue: '0',
    });
    expect(new URLSearchParams(request.query).get('wq_inf_month')).toBe(
      expected,
    );
  });

  it('keeps cumulative-month syntax unimplemented until supplier evidence exists', () => {
    expect(() => buildCnemcRequest({ ...monthly, datatype: 'months' })).toThrow(
      'UNSUPPORTED_QUERY',
    );
  });

  it.each([
    { ...daily, startDate: '2026-02-30' },
    { ...daily, startDate: '2026-09-01' },
    { ...daily, evaluationSystem: 'synthetic-unknown-system' },
    { ...daily, stationCode: 'SYNTHETIC\nHEADER' },
    { ...monthly, month: 0 },
    { ...monthly, month: 13 },
    { ...monthly, stationCode: 'SYNTHETIC_NOT_A_MONTHLY_FILTER' },
    { ...daily, url: 'https://example.invalid/' },
  ])('rejects invalid or undocumented request parameters: %#', (input) => {
    expect(() => buildCnemcRequest(input as CnemcQuery)).toThrow(
      'INVALID_QUERY',
    );
  });

  it.each([-1, 1, 999, 1001, Number.NaN])(
    'rejects an offset that cannot represent the fixed 1000-row page stride: %s',
    (offset) => {
      expect(() => buildCnemcRequest(daily, offset)).toThrow('INVALID_QUERY');
    },
  );

  it('accepts a real calendar leap day without inventing supplier coverage', () => {
    expect(
      buildCnemcRequest({
        resource: 'daily',
        startDate: '2024-02-29',
        endDate: '2024-02-29',
      }).query,
    ).toEqual({
      start_date: '2024-02-29',
      end_date: '2024-02-29',
      offsetValue: '0',
    });
  });
});

describe('offline CNEMC decoding and integrity', () => {
  it('preserves number, numeric string, null and sentinel representations by field', () => {
    const envelope = syntheticEnvelope('daily', 1, 1);
    envelope.data.data[0]!.factorVal = '-';
    envelope.data.data[0]!.factorValue = '-1.0';
    envelope.data.data[0]!.factorNumValue = 2.5;
    envelope.data.data[0]!.factorId = null;
    const parsed = decodeCnemcResponse('daily', JSON.stringify(envelope));
    expect(parsed.rows[0]).toMatchObject({
      factorVal: '-',
      factorValue: '-1.0',
      factorNumValue: 2.5,
      factorId: null,
    });
    expect(parsed.sentinelCells).toBe(2);
    expect(parsed.valuePreference).toBe('unknown');
    expect(parsed.uniqueIdSemantics).toBe('unknown');
  });

  it('retains a decimal pH despite the source declaration of an integer field', () => {
    const envelope = syntheticEnvelope('monthly', 1, 1);
    envelope.data.data[0]!.w01001 = 7.25;
    expect(
      decodeCnemcResponse('monthly', JSON.stringify(envelope)).rows[0]!.w01001,
    ).toBe(7.25);
  });

  it('decodes explicitly tabular rows using the returned column names', () => {
    const envelope = syntheticEnvelope('daily', 1, 1);
    const row = envelope.data.data[0]!;
    const tabular = {
      ...envelope,
      data: {
        ...envelope.data,
        data: [envelope.data.columnNames.map((column) => row[column])],
      },
    };
    expect(
      decodeCnemcResponse('daily', JSON.stringify(tabular)).rows[0],
    ).toEqual(row);
  });

  it('separates successful zero rows from JSON and XML business failures', () => {
    expect(page(0, 0, 0).rows).toEqual([]);
    expect(() =>
      decodeCnemcResponse(
        'daily',
        '<response><code>2009</code><message>SYNTHETIC_PRIVATE_TEXT</message></response>',
      ),
    ).toThrow('SOURCE_AUTHENTICATION');
    expect(() =>
      decodeCnemcResponse('daily', '<response><code>9999</code></response>'),
    ).toThrow('SOURCE_XML_ERROR');
    expect(() =>
      decodeCnemcResponse(
        'daily',
        JSON.stringify({ errCode: 'SYNTHETIC_ERROR', errMsg: 'PRIVATE_TEXT' }),
      ),
    ).toThrow('SOURCE_BUSINESS_ERROR');
  });

  it.each([
    { totalSize: '-1' },
    { totalSize: '1.0' },
    { rowSize: 2 },
    { columnSize: 2 },
    { columnNames: ['unknown_column'] },
    { data: [] },
    { data: [{ stationCode: { nested: 'SYNTHETIC_VALUE' } }] },
  ])(
    'rejects inconsistent counts and schema rather than trusting a 200: %#',
    (change) => {
      const envelope = syntheticEnvelope('daily', 1, 1);
      expect(() =>
        decodeCnemcResponse(
          'daily',
          JSON.stringify({
            ...envelope,
            data: { ...envelope.data, ...change },
          }),
        ),
      ).toThrow('INVALID_RESPONSE');
    },
  );

  it.each(['not-json', '<html>not a supplier envelope</html>', '{', 'null'])(
    'rejects unexpected content without exposing it: %#',
    (body) => {
      try {
        decodeCnemcResponse('daily', body);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CnemcOfflineError);
        expect((error as Error).message).not.toContain(body);
      }
    },
  );

  it('reports fixed-stride complete pagination and preserves unknown supplier semantics', () => {
    const report = inspectCnemcPages([
      page(0, 1000, 1002),
      page(1000, 2, 1002),
    ]);
    expect(report).toMatchObject({
      state: 'complete',
      total: 1002,
      receivedRows: 1002,
      offsets: [0, 1000],
      issues: [],
      supplierSnapshotVerified: false,
      uniqueIdSemantics: 'unknown',
    });
    expect(inspectCnemcPages([page(0, 0, 0)]).state).toBe('empty');
  });

  it.each([
    [[page(0, 1000, 1002), page(1000, 0, 1002)], 'EARLY_EMPTY_PAGE'],
    [[page(0, 1, 1002)], 'SHORT_PAGE'],
    [[page(0, 1000, 1002), page(1000, 2, 1003)], 'TOTAL_CHANGED'],
    [[page(0, 1000, 2000), page(1000, 1000, 2000, 0)], 'REPEATED_PAGE'],
    [[page(0, 1000, 1002), page(2000, 2, 1002)], 'OFFSET_DISCONTINUITY'],
    [[page(0, 1000, 1002), page(1000, 2, 1002, 999)], 'REPEATED_ROW'],
  ] as const)(
    'never labels an anomalous sequence complete: %#',
    (pages, issue) => {
      const report = inspectCnemcPages(pages);
      expect(report.state).toBe('incomplete');
      expect(report.issues).toContain(issue);
    },
  );
});

describe('bounded synthetic supplier on loopback', () => {
  const suppliers: SyntheticSupplier[] = [];
  afterEach(async () => {
    await Promise.all(suppliers.splice(0).map((supplier) => supplier.close()));
  });
  async function supplier(
    options: Parameters<typeof startSyntheticSupplier>[0] = {},
  ) {
    const result = await startSyntheticSupplier(options);
    suppliers.push(result);
    return result;
  }

  it.each([
    'https://example.invalid',
    'http://localhost:1234',
    'http://192.0.2.1:1234',
    'http://user:password@127.0.0.1:1234',
    'http://127.0.0.1:1234/provider',
    'http://127.0.0.1:1234/?token=SYNTHETIC',
  ])(
    'rejects non-literal-loopback and configurable provider targets: %#',
    (origin) => {
      expect(() => new CnemcLoopbackClient({ origin })).toThrow(
        'INVALID_CONFIGURATION',
      );
    },
  );

  it('sends POST, exact OnlineToken spelling, quoted query month, and no body', async () => {
    const source = await supplier({ rowCount: 2 });
    const client = new CnemcLoopbackClient({ origin: source.origin });
    const result = await client.collect(monthly);
    expect(result.report.state).toBe('complete');
    expect(result.rows).toHaveLength(2);
    expect(source.requests[0]).toMatchObject({
      method: 'POST',
      bodyBytes: 0,
      onlineTokenSpellingMatches: true,
      query: { datatype: 'month', wq_inf_month: "'08'", offsetValue: '0' },
    });
  });

  it('uses offset 1000 even when the final page has only two rows', async () => {
    const source = await supplier({ rowCount: 1002 });
    const client = new CnemcLoopbackClient({ origin: source.origin });
    const result = await client.collect(daily);
    expect(result.report.state).toBe('complete');
    expect(source.requests.map((entry) => entry.query.offsetValue)).toEqual([
      '0',
      '1000',
    ]);
  });

  it.each([
    ['empty', 'empty', null],
    ['duplicate-page', 'incomplete', 'REPEATED_PAGE'],
    ['early-empty', 'incomplete', 'EARLY_EMPTY_PAGE'],
    ['short-page', 'incomplete', 'SHORT_PAGE'],
    ['total-changed', 'incomplete', 'TOTAL_CHANGED'],
    ['xml-auth', 'incomplete', 'SOURCE_AUTHENTICATION'],
    ['json-business', 'incomplete', 'SOURCE_BUSINESS_ERROR'],
    ['redirect', 'incomplete', 'SOURCE_REDIRECT'],
    ['oversize', 'incomplete', 'RESPONSE_TOO_LARGE'],
    ['chunked-oversize', 'incomplete', 'RESPONSE_TOO_LARGE'],
    ['unsupported-encoding', 'incomplete', 'UNSUPPORTED_ENCODING'],
  ] as const)(
    'handles synthetic %s without weakening completeness',
    async (fault, state, issue) => {
      const source = await supplier({ rowCount: 2000, fault });
      const client = new CnemcLoopbackClient({
        origin: source.origin,
        maxResponseBytes: fault.includes('oversize') ? 1024 : undefined,
      });
      const result = await client.collect(daily);
      expect(result.report.state).toBe(state);
      if (issue) expect(result.report.issues).toContain(issue);
      expect(source.redirectTargetRequests).toBe(0);
      expect(JSON.stringify(result.report)).not.toContain('PRIVATE_TEXT');
      expect(JSON.stringify(result.report)).not.toContain('OnlineToken');
    },
  );

  it('stops at a declared local page bound and records unfinished paging', async () => {
    const source = await supplier({ rowCount: 2000 });
    const client = new CnemcLoopbackClient({ origin: source.origin });
    const result = await client.collect(daily, { maxPages: 1 });
    expect(result.report.state).toBe('incomplete');
    expect(result.report.issues).toContain('PAGE_LIMIT');
    expect(source.requests).toHaveLength(1);
  });

  it('bounds both response headers and streamed bodies by the same deadline', async () => {
    for (const fault of ['timeout', 'body-timeout'] as const) {
      const source = await supplier({ rowCount: 2, fault });
      const client = new CnemcLoopbackClient({
        origin: source.origin,
        timeoutMs: 50,
      });
      const result = await client.collect(daily);
      expect(result.report.issues).toContain('SOURCE_TIMEOUT');
      expect(result.report.state).toBe('incomplete');
    }
  });

  it('honors cancellation before dispatch and while the supplier is responding', async () => {
    const source = await supplier({ rowCount: 2, fault: 'body-timeout' });
    const client = new CnemcLoopbackClient({ origin: source.origin });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      (await client.collect(daily, { signal: cancelled.signal })).report.issues,
    ).toContain('CANCELLED');
    expect(source.requests).toHaveLength(0);
    const active = new AbortController();
    const timer = setTimeout(() => active.abort(), 30);
    try {
      const result = await client.collect(daily, { signal: active.signal });
      expect(result.report.issues).toContain('CANCELLED');
      expect(result.rows).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });
});
