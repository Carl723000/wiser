// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  IngestionCandidateReadInputSchema,
  CreateIngestionCandidateViewInputSchema,
} from '@wiser/data-contracts';
import type { CandidateRelationPages } from '@/lib/candidate-relation-reader';
import { CandidateReaderError } from '@/lib/ingestion-candidate-reader';
import { IngestionCandidateReader } from './ingestion-candidate-reader';
type CandidateRelationSnapshot = CandidateRelationPages['get']['relation'];

const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/candidate-relation-reader', () => ({
  readCandidateRelation: read,
}));
vi.mock('./data-foundation-map', () => ({ DataFoundationMap: () => null }));
vi.mock('./candidate-followup-panel', () => ({
  CandidateFollowupPanel: () => null,
}));
vi.mock('./ingestion-candidate-raster-panel', () => ({
  IngestionCandidateRasterPanel: () => null,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  read.mockReset();
});
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
function snapshot(): CandidateRelationSnapshot {
  return {
    revision: {
      relationId: id(4),
      revisionId: id(5),
      lineageId: id(6),
      revision: 2,
      supersedesId: id(7),
      reference,
      mappingVersion: 'source-map/1',
      ruleVersion: 'source-rule/1',
      content: {
        subject: {
          key: 'reach-a',
          label: 'Source reach',
          kind: 'RIVER_REACH',
          externalId: null,
        },
        predicate: 'BELONGS_TO_BASIN',
        object: {
          key: 'basin-b',
          label: 'Source basin',
          kind: 'BASIN',
          externalId: null,
        },
        qualifiers: {
          measure: null,
          reportedValue: null,
          reportedLimit: null,
          unit: null,
          observedAt: null,
          missing: false,
          spatialScope: null,
          limitations: [],
          reportedConclusion: null,
          context: {
            recordNature: 'SOURCE_RELATION',
            timeRole: 'UNKNOWN',
            validFrom: null,
            validTo: null,
            locationRole: 'REFERENCE_LOCATION',
            applicability: 'Source statement only',
          },
        },
        generation: { method: 'SOURCE_TABLE', model: null },
        evidence: [
          {
            reference,
            assetId: id(3),
            recordId: id(8),
            sourceHash: 'b'.repeat(64),
            locator: 'table:1/row:2',
            excerpt: 'Original relation excerpt',
            polarity: 'SUPPORTS',
          },
        ],
      },
    },
    state: 'PENDING_REVIEW',
    decisionVersion: 3,
    createdAt: '2026-10-09T00:00:00Z',
  };
}
function mount(
  locale: 'en' | 'zh-CN' = 'en',
  fetch: typeof globalThis.fetch = () =>
    Promise.resolve(Response.json(assets())),
) {
  vi.stubGlobal('fetch', vi.fn(fetch));
  read.mockImplementation((action) =>
    Promise.resolve(
      action === 'list'
        ? { relations: [snapshot()], nextCursor: 'next-page' }
        : { relation: snapshot() },
    ),
  );
  return render(
    <IngestionCandidateReader reference={reference} locale={locale} />,
  );
}
function assets(ref = reference) {
  return {
    reference: ref,
    parserVersion: 'source-parser/1',
    status: 'READY',
    createdAt: '2026-10-09T00:00:00Z',
    totalAssetCount: 1,
    knownRecordCount: 1,
    knownFeatureCount: 0,
    unknownAssetCount: 0,
    assets: [
      {
        assetId: id(3),
        sourceHash: 'b'.repeat(64),
        status: 'READY',
        reason: null,
        recordCount: 1,
        featureCount: 0,
      },
    ],
    nextCursor: null,
  };
}
async function list() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read relation evidence' }),
  );
  await screen.findByRole('button', {
    name: 'Inspect relation: Source reach · Source basin',
  });
}
it('reads only an explicit page of 25 and gets the exact revision and decision before showing evidence', async () => {
  mount();
  await screen.findByRole('button', { name: 'Read relation evidence' });
  expect(read).not.toHaveBeenCalled();
  await list();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0].slice(0, 2)).toEqual([
    'list',
    { references: [reference], first: 25 },
  ]);
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect relation: Source reach · Source basin',
    }),
  );
  await screen.findByText('Original relation excerpt');
  expect(read.mock.calls[1].slice(0, 2)).toEqual([
    'get',
    {
      references: [reference],
      relationId: id(4),
      revision: 2,
      decisionVersion: 3,
    },
  ]);
  expect(screen.getByText('table:1/row:2')).toBeDefined();
  expect(
    screen.getByText(
      'Relation decisions do not grant professional approval or establish requirement, region or map membership.',
    ),
  ).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Next relation page' }));
  await act(async () => {});
  expect(read.mock.calls[2][1]).toEqual({
    references: [reference],
    first: 25,
    after: 'next-page',
  });
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
});
it('clears content and shows denial rather than an empty list', async () => {
  mount();
  await list();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect relation: Source reach · Source basin',
    }),
  );
  await screen.findByText('Original relation excerpt');
  read.mockRejectedValueOnce(new CandidateReaderError('denied'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Read relation evidence' }),
  );
  await screen.findByRole('alert');
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
  expect(screen.queryByText('Source reach')).toBeNull();
  expect(screen.queryByText('No readable relations in this page.')).toBeNull();
});
it('does not falsely reject a readable PARTIAL CSV plus source manifest batch', async () => {
  mount('en', (_url, init) => {
    const input = IngestionCandidateReadInputSchema.parse(
      JSON.parse(init?.body as string) as unknown,
    );
    const page = assets();
    const manifest = {
      assetId: id(15),
      sourceHash: 'c'.repeat(64),
      status: 'UNSUPPORTED',
      reason: 'SOURCE_MANIFEST',
      recordCount: null,
      featureCount: null,
    };
    return Promise.resolve(
      Response.json({
        ...page,
        status: 'PARTIAL',
        totalAssetCount: 2,
        unknownAssetCount: 1,
        assets: input.first === 1 ? page.assets : [...page.assets, manifest],
        nextCursor: input.first === 1 ? 'remaining-asset' : null,
      }),
    );
  });
  await list();
  expect(read.mock.calls[0][1]).toEqual({ references: [reference], first: 25 });
  expect(screen.queryByRole('alert')).toBeNull();
});
it('aborts an in-flight relation detail during browser recovery and discards its late response', async () => {
  mount();
  await list();
  let finish!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect relation: Source reach · Source basin',
    }),
  );
  await act(async () => {});
  const signal = read.mock.calls[1][2] as AbortSignal;
  act(() => {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
  });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish({ relation: snapshot() });
    await Promise.resolve();
  });
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
  expect(
    screen.queryByRole('button', {
      name: 'Inspect relation: Source reach · Source basin',
    }),
  ).toBeNull();
});
it('clears relation content during browser recovery', async () => {
  mount();
  await list();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect relation: Source reach · Source basin',
    }),
  );
  await screen.findByText('Original relation excerpt');
  act(() => {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
  });
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
});
it('discards a late response after replacing the candidate owner', async () => {
  const view = mount();
  await list();
  let finish!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect relation: Source reach · Source basin',
    }),
  );
  await act(async () => {});
  view.rerender(
    <IngestionCandidateReader
      reference={{ ...reference, processingBatchId: id(9) }}
      locale="en"
    />,
  );
  await act(async () => {
    finish({ relation: snapshot() });
    await Promise.resolve();
  });
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
});
it('distinguishes confirmed relation status from professional approval in Chinese', async () => {
  mount('zh-CN');
  read.mockResolvedValue({
    relations: [{ ...snapshot(), state: 'CONFIRMED' }],
    nextCursor: null,
  });
  fireEvent.click(await screen.findByRole('button', { name: '读取关系依据' }));
  await screen.findByText('关系已确认');
  expect(
    screen.getByText(
      '关系决定不代表专业批准，也不据此确定需求、区域或地图归属。',
    ),
  ).toBeDefined();
});
it('rechecks all saved topic sources even when an empty relation page is returned', async () => {
  const second = {
    ...reference,
    ingestionId: id(10),
    processingBatchId: id(11),
  };
  const refs = [reference, second];
  const opened = {
    status: 'READABLE',
    specVersion: 2,
    savedView: {
      kind: 'ingestion-candidate-view',
      viewId: id(12),
      title: 'Fixed relation topic',
      visibility: 'private',
      createdAt: '2026-10-09T00:00:00Z',
      revokedAt: null,
      specVersion: 2,
    },
    references: refs,
    viewSpec: {
      schemaVersion: 2,
      page: { kind: 'assets', reference, first: 50 },
      period: {
        timeRole: 'REPORT_PERIOD',
        windowMode: 'month',
        from: null,
        to: null,
        displayUnit: 'month',
        includeUndated: true,
      },
      topic: {
        question: 'Retained question',
        regionIds: ['bth'],
        needIds: ['K5-001'],
        recordPins: [],
      },
      rulePins: ['projection', 'readiness', 'requirement', 'impact'].map(
        (kind) => ({ kind, ruleId: `fixed-${kind}`, version: '1' }),
      ),
      dependencyPins: [
        {
          kind: 'asset',
          reference,
          assetId: id(3),
          sourceHash: 'b'.repeat(64),
          parserVersion: 'source-parser/1',
        },
      ],
      relationPins: [],
    },
    request: {
      capabilityId: 'data.ingestion.candidate.get',
      input: { ...reference, first: 50 },
    },
  };
  let denied = false;
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      paths.push(url);
      if (url.endsWith('/candidate-topics/open'))
        return Promise.resolve(Response.json(opened));
      const input = IngestionCandidateReadInputSchema.parse(
        JSON.parse(init.body as string) as unknown,
      );
      if (denied && input.ingestionId === second.ingestionId)
        return Promise.resolve(Response.json({}, { status: 403 }));
      return Promise.resolve(
        Response.json(
          assets(input.ingestionId === second.ingestionId ? second : reference),
        ),
      );
    }),
  );
  read.mockImplementation(() => {
    denied = true;
    return Promise.resolve({ relations: [], nextCursor: null });
  });
  render(
    <IngestionCandidateReader
      reference={null}
      ingestionId={reference.ingestionId}
      savedTopicId={id(12)}
      locale="en"
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read relation evidence' }),
  );
  await screen.findByRole('alert');
  expect(read.mock.calls[0][1]).toEqual({ references: refs, first: 25 });
  expect(screen.queryByText('No readable relations in this page.')).toBeNull();
  expect(screen.queryByText('Fixed relation topic')).toBeNull();
  expect(
    paths.filter((path) => path.endsWith('/candidate-topics/open')).length,
  ).toBeGreaterThanOrEqual(4);
  expect(paths.some((path) => path.endsWith('/candidate-views/open'))).toBe(
    false,
  );
});

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
async function inspect() {
  await list();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect relation: Source reach · Source basin',
    }),
  );
  await screen.findAllByText('Original relation excerpt');
}
function recordPage(after?: string) {
  return {
    reference,
    assetId: id(3),
    columns: [{ key: 'text', label: 'Original text' }],
    records: [
      {
        recordId: after ? id(8) : id(18),
        assetId: id(3),
        index: after ? 2 : 1,
        sourceId: after ? 'table:1/row:2' : 'table:1/row:1',
        values: { text: after ? 'Exact source row' : 'Other source row' },
        hasGeometry: false,
      },
    ],
    nextCursor: after ? null : 'record-after-1',
  };
}
it('rechecks the source hash and seeks the exact native row across pages in a readable PARTIAL batch', async () => {
  const reads: Array<{ action: string; body: Record<string, unknown> }> = [];
  mount('en', (url, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    const action = requestUrl(url).split('/').at(-1)!;
    reads.push({ action, body });
    if (action === 'records')
      return Promise.resolve(
        Response.json(recordPage(body.after as string | undefined)),
      );
    return Promise.resolve(
      Response.json({
        ...assets(),
        status: 'PARTIAL',
        totalAssetCount: 2,
        unknownAssetCount: 1,
      }),
    );
  });
  await inspect();
  reads.length = 0;
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  const selected = await screen.findByRole('button', {
    name: 'Select record 2',
  });
  expect(selected.getAttribute('aria-pressed')).toBe('true');
  expect(
    screen.getByRole('tab', { name: 'Records' }).getAttribute('aria-selected'),
  ).toBe('true');
  expect(reads[0]?.action).toBe('get');
  expect(
    reads.filter((r) => r.action === 'records').map((r) => r.body),
  ).toEqual([
    { ...reference, assetId: id(3), first: 50 },
    { ...reference, assetId: id(3), first: 50, after: 'record-after-1' },
  ]);
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
});
it('does not navigate evidence from a different fixed candidate or infer a row from its locator', async () => {
  mount();
  const relation = snapshot();
  relation.revision.content.evidence[0].reference = {
    ...reference,
    reviewHash: 'c'.repeat(64),
  };
  const noRecord = { ...snapshot().revision.content.evidence[0] };
  delete noRecord.recordId;
  relation.revision.content.evidence.push(noRecord);
  read.mockImplementation((action) =>
    Promise.resolve(
      action === 'list'
        ? { relations: [relation], nextCursor: null }
        : { relation },
    ),
  );
  await inspect();
  expect(
    screen.queryByRole('button', { name: 'View matching record' }),
  ).toBeNull();
  expect(
    screen.getByText(
      'This evidence comes from another candidate. Open that material to inspect it.',
    ),
  ).toBeDefined();
  expect(
    screen.getByText(
      'This evidence does not identify a record. Its excerpt and source location remain available.',
    ),
  ).toBeDefined();
});
it('clears old evidence and never requests records when the freshly read source hash differs', async () => {
  let changed = false;
  const records = vi.fn();
  mount('en', (url) => {
    if (requestUrl(url).endsWith('/records')) records();
    const page = assets();
    if (changed) page.assets[0].sourceHash = 'c'.repeat(64);
    return Promise.resolve(Response.json(page));
  });
  await inspect();
  changed = true;
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  await screen.findByRole('alert');
  expect(records).not.toHaveBeenCalled();
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
});
it('looks up an asset beyond the current page before requesting its records', async () => {
  let looking = false;
  const reads: Array<Record<string, unknown>> = [];
  mount('en', (url, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    if (requestUrl(url).endsWith('/records')) {
      expect(reads.some((r) => r.after === 'asset-after-1')).toBe(true);
      return Promise.resolve(Response.json(recordPage('found')));
    }
    if (!looking) return Promise.resolve(Response.json(assets()));
    reads.push(body);
    const page = assets();
    return Promise.resolve(
      Response.json(
        body.after
          ? page
          : {
              ...page,
              assets: [{ ...page.assets[0], assetId: id(15) }],
              nextCursor: 'asset-after-1',
            },
      ),
    );
  });
  await inspect();
  looking = true;
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  expect(
    (
      await screen.findByRole('button', { name: 'Select record 2' })
    ).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(reads[0]?.after).toBeUndefined();
});
it('cancels a source lookup when the owner changes and discards its late response', async () => {
  let looking = false;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  let activeReference = reference;
  const view = mount('en', (_url, init) => {
    if (!looking)
      return Promise.resolve(Response.json(assets(activeReference)));
    signal = init?.signal as AbortSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await inspect();
  looking = true;
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  await act(async () => {});
  looking = false;
  activeReference = { ...reference, ingestionId: id(20) };
  view.rerender(
    <IngestionCandidateReader reference={activeReference} locale="en" />,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish(Response.json(assets()));
    await Promise.resolve();
  });
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Select record 2' })).toBeNull();
});
it('clears the relation page and detail on denial during the source lookup', async () => {
  let denied = false;
  mount('en', () =>
    Promise.resolve(
      denied
        ? Response.json({ error: 'FORBIDDEN' }, { status: 403 })
        : Response.json(assets()),
    ),
  );
  await inspect();
  denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
  expect(screen.queryByText('Source reach')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Select record 2' })).toBeNull();
});

it('bounds the fresh asset lookup to ten pages and reads no records if the source is beyond that boundary', async () => {
  let looking = false;
  let assetReads = 0;
  const records = vi.fn();
  mount('en', (url) => {
    if (requestUrl(url).endsWith('/records')) records();
    if (!looking) return Promise.resolve(Response.json(assets()));
    assetReads++;
    const page = assets();
    return Promise.resolve(
      Response.json({
        ...page,
        totalAssetCount: 11,
        assets: [{ ...page.assets[0], assetId: id(100 + assetReads) }],
        nextCursor: `asset-page-${assetReads}`,
      }),
    );
  });
  await inspect();
  looking = true;
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  await screen.findByText(
    'The source was not located within ten pages. Return to the source list to continue reading.',
  );
  expect(assetReads).toBe(10);
  expect(records).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Select record 2' })).toBeNull();
});
it('bounds the native record lookup to ten pages without selecting an unrelated row', async () => {
  let recordReads = 0;
  mount('en', (url) => {
    if (!requestUrl(url).endsWith('/records'))
      return Promise.resolve(Response.json(assets()));
    recordReads++;
    const page = recordPage();
    return Promise.resolve(
      Response.json({
        ...page,
        records: [
          {
            ...page.records[0],
            recordId: id(100 + recordReads),
            index: recordReads,
          },
        ],
        nextCursor: `record-page-${recordReads}`,
      }),
    );
  });
  await inspect();
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  await screen.findByRole('button', { name: 'Select record 10' });
  await act(async () => {});
  expect(recordReads).toBe(10);
  expect(
    screen
      .getByRole('button', { name: 'Select record 10' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
});
it('clears content on denial during a later record page after hash verification', async () => {
  let recordReads = 0;
  mount('en', (url) => {
    if (!requestUrl(url).endsWith('/records'))
      return Promise.resolve(Response.json(assets()));
    recordReads++;
    return Promise.resolve(
      recordReads === 1
        ? Response.json(recordPage())
        : Response.json({ error: 'FORBIDDEN' }, { status: 403 }),
    );
  });
  await inspect();
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  await screen.findByRole('alert');
  expect(recordReads).toBe(2);
  expect(screen.queryByText('Other source row')).toBeNull();
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
});
it('cancels a record lookup during browser recovery and never selects its late row', async () => {
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  let recordReads = 0;
  mount('en', (url, init) => {
    if (!requestUrl(url).endsWith('/records'))
      return Promise.resolve(Response.json(assets()));
    if (++recordReads > 1) return Promise.resolve(Response.json(recordPage()));
    signal = init?.signal as AbortSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await inspect();
  fireEvent.click(screen.getByRole('button', { name: 'View matching record' }));
  await act(async () => {});
  act(() => {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish(Response.json(recordPage('found')));
    await Promise.resolve();
  });
  expect(screen.queryByRole('button', { name: 'Select record 2' })).toBeNull();
  expect(screen.queryByText('Original relation excerpt')).toBeNull();
});
it('uses the existing formal Chinese source-row action', async () => {
  mount('zh-CN');
  fireEvent.click(await screen.findByRole('button', { name: '读取关系依据' }));
  fireEvent.click(
    await screen.findByRole('button', {
      name: '查看关系: Source reach · Source basin',
    }),
  );
  expect(
    await screen.findByRole('button', { name: '查看对应记录' }),
  ).toBeDefined();
});

it.each([false, true])(
  'keeps the visible source page separate from a background evidence lookup (later asset page: %s), then saves and reopens the same page',
  async (laterPage) => {
    const savedView = {
      kind: 'ingestion-candidate-view',
      viewId: id(90),
      title: 'Evidence reading position',
      visibility: 'private',
      createdAt: '2026-10-09T00:00:00Z',
      revokedAt: null,
    };
    let savedInput:
      | ReturnType<typeof CreateIngestionCandidateViewInputSchema.parse>
      | undefined;
    const visible = {
      ...assets(),
      totalAssetCount: 2,
      assets: [{ ...assets().assets[0], assetId: id(15) }],
    };
    mount('en', (url, init) => {
      const path = requestUrl(url);
      const body: unknown = JSON.parse(init?.body as string);
      if (path.endsWith('/create')) {
        savedInput = CreateIngestionCandidateViewInputSchema.parse(body);
        return Promise.resolve(Response.json({ savedView }));
      }
      if (path.endsWith('/list'))
        return Promise.resolve(
          Response.json({ items: [savedView], nextCursor: null }),
        );
      if (path.endsWith('/open')) {
        if (!savedInput) throw new Error('No saved reading exists');
        return Promise.resolve(
          Response.json({
            kind: 'ingestion-candidate-view',
            savedView,
            references: savedInput.references,
            viewSpec: savedInput.viewSpec,
            request: {
              capabilityId: 'data.ingestion.candidate.get',
              input: { ...reference, first: 50 },
            },
          }),
        );
      }
      if (path.endsWith('/records'))
        return Promise.resolve(Response.json(recordPage('found')));
      const input = IngestionCandidateReadInputSchema.parse(body);
      if (input.first !== 200) return Promise.resolve(Response.json(visible));
      if (laterPage && !input.after)
        return Promise.resolve(
          Response.json({ ...visible, nextCursor: 'background-assets' }),
        );
      return Promise.resolve(
        Response.json({
          ...assets(),
          totalAssetCount: 2,
          assets: [...assets().assets, ...visible.assets],
        }),
      );
    });
    await inspect();
    fireEvent.click(
      screen.getByRole('button', { name: 'View matching record' }),
    );
    expect(
      (
        await screen.findByRole('button', { name: 'Select record 2' })
      ).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Originals' }));
    const beforeSave = within(
      screen.getByRole('tabpanel', { name: 'Originals' }),
    )
      .getAllByRole('link', { name: 'Download original' })
      .map((link) => link.getAttribute('href')?.split('?')[0]);
    fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), {
      target: { value: savedView.title },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await screen.findByText('View saved.');
    expect(savedInput?.viewSpec.page).toEqual({
      kind: 'assets',
      reference,
      first: 50,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load saved views' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen view' }));
    await screen.findByText(savedView.title);
    await act(async () => {});
    expect(
      screen
        .getByRole('tab', { name: 'Originals' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      within(screen.getByRole('tabpanel', { name: 'Originals' }))
        .getAllByRole('link', { name: 'Download original' })
        .map((link) => link.getAttribute('href')?.split('?')[0]),
    ).toEqual(beforeSave);
    expect(beforeSave).toHaveLength(1);
  },
);
