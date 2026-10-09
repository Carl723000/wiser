// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IngestionCandidateReadInputSchema } from '@wiser/data-contracts';
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
