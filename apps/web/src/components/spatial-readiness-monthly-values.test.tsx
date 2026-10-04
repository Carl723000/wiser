// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getDictionary } from '../lib/i18n';
import { materialReference } from '../lib/spatial-readiness-facts';
import type { ProjectReadinessInput } from '@wiser/data-core/project-readiness';
import type {
  Material,
  WorkspacePack,
  WorkspaceRecord,
} from '../lib/spatial-workspace-contract';
import { syntheticReviewRecord } from '../lib/spatial-candidate-review';
import { SpatialReadinessPanel } from './spatial-readiness-panel';
import * as readiness from '../lib/spatial-readiness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fixture(values: readonly (string | null)[], unknownMonth = false) {
  const base = syntheticReviewRecord();
  const sources: Material[] = values.map((_, index) => ({
    id: `source-${index}`,
    workId: `work-${index}`,
    versionId: `version-${index}`,
    title: `Monthly source ${index}`,
    provider: 'Synthetic provider',
    kind: 'report',
    originalSha256: String(index + 1).padStart(64, '0'),
    evidenceUrl: null,
    rights: {
      public: false,
      displayAllowed: true,
      redistributionAllowed: false,
      note: 'Synthetic test',
    },
    regionIds: ['chaobai'],
    needIds: ['K5-001'],
    processingVersion: 'test-parser',
    duplicateOf: null,
    status: {
      original: 'obtained',
      parsed: 'indexed',
      checked: 'unknown',
      professionalReview: 'pending',
      space: 'text-only',
      use: 'local-inspection',
    },
  }));
  const records: WorkspaceRecord[] = values.map((value, index) => ({
    ...base,
    id: `record-${index}`,
    sourceId: sources[index].id,
    versionId: sources[index].versionId,
    reviewStatus: 'pending',
    track: 'REAL',
    objectId: 'river',
    objectLabel: 'Original river reach',
    kind: 'observation',
    needIds: ['K5-001'],
    regionIds: ['chaobai'],
    processingVersion: 'test-parser',
    value,
    metric: 'reported-category',
    unit: null,
    positions: [],
    time: {
      start: `2023-${String(index + 1).padStart(2, '0')}`,
      end: `2023-${String(index + 1).padStart(2, '0')}`,
      precision: 'month',
      role:
        unknownMonth && index === values.length - 1
          ? 'observation'
          : 'publication',
    },
    evidence: [
      {
        locator: 'table:1/row:5',
        text: 'Synthetic original category row',
        url: null,
      },
    ],
  }));
  const pack: WorkspacePack = {
    schemaVersion: 1,
    generatedAt: '2026-10-05',
    processingVersion: 'test-parser',
    sources,
    records,
    regions: [],
    topicPackages: [],
    rasterReports: [],
  };
  const refs = sources.map(materialReference);
  const facts: ProjectReadinessInput = {
    track: 'REAL',
    requirement: {
      needId: 'K5-001',
      version: 'test-need',
      regionId: 'chaobai',
      purpose: 'category-reading',
      dateRole: 'PUBLICATION',
      window: { start: '2023-01', end: '2023-09' },
    },
    sources: refs.map((source) => ({
      ...source,
      track: 'REAL',
      kind: 'MONTHLY_REPORT',
      needIds: ['K5-001'],
      regionIds: ['chaobai'],
    })),
    records: records.map((record, index) => ({
      id: record.id,
      source: refs[index],
      needIds: ['K5-001'],
      regionIds: ['chaobai'],
      object: {
        key: record.objectId,
        originalName: record.objectLabel,
        markers: [],
        footnotes: [],
      },
      series: { id: 'declared-series', version: 'v1' },
      time: {
        value: record.time.start,
        role:
          record.time.role === 'observation' ? 'OBSERVATION' : 'PUBLICATION',
        precision: 'MONTH',
      },
      rawValue: record.value,
      metric: {
        code: record.metric,
        kind: 'CATEGORY',
        unit: record.unit,
        method: null,
      },
      parsing: 'READY',
      professionalState: 'PENDING_REVIEW',
      spatial: null,
      evidence: [
        {
          source: refs[index],
          locator: 'table:1/row:5',
          excerpt: 'Synthetic original category row',
        },
      ],
    })),
    series: [
      {
        id: 'declared-series',
        version: 'v1',
        sources: refs,
        evidence: [
          {
            source: refs[0],
            locator: 'series/title',
            excerpt: 'Synthetic declared monthly sequence',
          },
        ],
      },
    ],
    correspondences: [],
  };
  return { pack, facts };
}

function openDensity(
  locale: 'zh-CN' | 'en',
  data: ReturnType<typeof fixture>,
  select = vi.fn(),
  sourceHref?: (sourceId: string, versionId: string) => string,
) {
  const copy = getDictionary(locale).dataFoundation.spatialReadiness;
  const view = render(
    <SpatialReadinessPanel
      pack={data.pack}
      regionId="chaobai"
      facts={data.facts}
      copy={copy}
      onSelectRecord={select}
      sourceHref={sourceHref}
    />,
  );
  fireEvent.click(
    within(
      screen
        .getByRole('heading', { name: copy.questionLabels.density })
        .closest('article')!,
    ).getByRole('button', { name: new RegExp(copy.inspect) }),
  );
  return { ...view, copy, select };
}

it.each(['zh-CN', 'en'] as const)(
  'reads raw values and their kinds directly by month in %s',
  (locale) => {
    const data = fixture([
      'Ⅱ',
      'Ⅱ～Ⅲ',
      '无水',
      '封闭无法监测',
      null,
      '',
      '0',
      'Native note',
    ]);
    const { select } = openDensity(locale, data);
    const readout = screen.getByTestId('readiness-monthly-values');
    const cells = readout.querySelectorAll<HTMLElement>('[data-readout-month]');
    expect(cells).toHaveLength(9);
    const kinds = [
      'CATEGORY',
      'CATEGORY_RANGE',
      'DRY',
      'UNMONITORED',
      'NULL',
      'EMPTY',
      'NUMERIC',
      'TEXT',
    ];
    kinds.forEach((kind, index) => {
      expect(
        cells[index]
          .querySelector('[data-readout-value-kind]')
          ?.getAttribute('data-readout-value-kind'),
      ).toBe(kind);
      expect(cells[index].getAttribute('data-readout-state')).toBe('PRESENT');
    });
    expect(cells[6].textContent).toContain('0');
    expect(cells[8].getAttribute('data-readout-state')).toBe('MISSING');
    expect(cells[0].textContent).toContain('Monthly source 0');
    fireEvent.click(within(cells[6]).getByRole('button'));
    expect(select).toHaveBeenCalledExactlyOnceWith('record-6');
  },
);

it('retains two same-month values with their own source and fixed record selection', () => {
  const data = fixture(['Ⅱ', 'Ⅳ']);
  data.pack.records[1].time = { ...data.pack.records[0].time };
  data.facts = {
    ...data.facts,
    records: data.facts.records.map((r, index) =>
      index ? { ...r, time: data.facts.records[0].time } : r,
    ),
  };
  const { select } = openDensity('en', data);
  const january = screen
    .getByTestId('readiness-monthly-values')
    .querySelector<HTMLElement>('[data-readout-month="2023-01"]')!;
  const buttons = within(january).getAllByRole('button');
  expect(buttons).toHaveLength(2);
  expect(buttons[0].textContent).toContain('Ⅱ');
  expect(buttons[0].textContent).toContain('Monthly source 0');
  expect(buttons[1].textContent).toContain('Ⅳ');
  expect(buttons[1].textContent).toContain('Monthly source 1');
  fireEvent.click(buttons[1]);
  expect(select).toHaveBeenCalledExactlyOnceWith('record-1');
});

it('keeps unknown-role values outside month cells and does not guess the empty month cause', () => {
  const data = fixture(['Ⅱ', 'Ⅲ'], true);
  openDensity('en', data);
  const readout = screen.getByTestId('readiness-monthly-values');
  const february = readout.querySelector<HTMLElement>(
    '[data-readout-month="2023-02"]',
  )!;
  expect(february.getAttribute('data-readout-state')).toBe('UNKNOWN');
  expect(within(february).queryByRole('button')).toBeNull();
  const unknown = within(readout).getByTestId('readiness-unknown-month-values');
  expect(unknown.textContent).toContain('Ⅲ');
  expect(unknown.textContent).toContain('Monthly source 1');
});

it('clears the readout when a fixed source is withdrawn and computes the new scope without old values', () => {
  const data = fixture(['Ⅱ', 'Ⅳ']);
  const { rerender, copy } = openDensity('en', data);
  expect(screen.getByTestId('readiness-monthly-values').textContent).toContain(
    'Monthly source 1',
  );
  const next = {
    ...data.pack,
    sources: data.pack.sources.map((s, index) =>
      index ? { ...s, rights: { ...s.rights, displayAllowed: false } } : s,
    ),
  };
  rerender(
    <SpatialReadinessPanel
      pack={next}
      regionId="chaobai"
      facts={data.facts}
      copy={copy}
    />,
  );
  expect(screen.queryByTestId('readiness-monthly-values')).toBeNull();
  fireEvent.click(
    within(
      screen
        .getByRole('heading', { name: copy.questionLabels.density })
        .closest('article')!,
    ).getByRole('button', { name: new RegExp(copy.inspect) }),
  );
  const readout = screen.getByTestId('readiness-monthly-values');
  expect(readout.textContent).not.toContain('Monthly source 1');
  expect(readout.textContent).not.toContain('Ⅳ');
});

it('keeps raw evidence but refuses a record-selection callback with an ambiguous current ID', () => {
  const data = fixture(['Ⅱ']);
  const result = readiness.buildReadiness(
    data.pack,
    'chaobai',
    [],
    data.facts,
    {
      needId: 'K5-001',
      track: 'REAL',
      dateRole: 'PUBLICATION',
      window: data.facts.requirement.window,
    },
  );
  vi.spyOn(readiness, 'buildReadiness').mockReturnValue({
    ...result,
    records: [
      ...result.records,
      { ...result.records[0], sourceId: 'another-source' },
    ],
  });
  const { select } = openDensity('en', data);
  const readout = screen.getByTestId('readiness-monthly-values');
  expect(readout.textContent).toContain('Ⅱ');
  expect(within(readout).queryByRole('button')).toBeNull();
  expect(
    within(readout).getByTestId('readiness-monthly-unresolved-selection'),
  ).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
});

it('does not locate a record through a Material with a mismatched fixed original reference', () => {
  const data = fixture(['Ⅱ']);
  const result = readiness.buildReadiness(
    data.pack,
    'chaobai',
    [],
    data.facts,
    {
      needId: 'K5-001',
      track: 'REAL',
      dateRole: 'PUBLICATION',
      window: data.facts.requirement.window,
    },
  );
  vi.spyOn(readiness, 'buildReadiness').mockReturnValue(result);
  data.pack.sources[0] = {
    ...data.pack.sources[0],
    originalSha256: 'f'.repeat(64),
  };
  const { select } = openDensity('en', data);
  const readout = screen.getByTestId('readiness-monthly-values');
  expect(within(readout).queryByRole('button')).toBeNull();
  expect(
    within(readout).getByTestId('readiness-monthly-unresolved-selection'),
  ).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
});

it('limits mounted same-month values while preserving the full count and exact selection after reveal', () => {
  const data = fixture(Array.from({ length: 50 }, () => 'Ⅱ'));
  data.pack.records = data.pack.records.map((record) => ({
    ...record,
    time: data.pack.records[0].time,
  }));
  data.facts = {
    ...data.facts,
    records: data.facts.records.map((record) => ({
      ...record,
      time: data.facts.records[0].time,
    })),
  };
  const { select, copy } = openDensity('en', data);
  const readout = screen.getByTestId('readiness-monthly-values');
  const january = readout.querySelector<HTMLElement>(
    '[data-readout-month="2023-01"]',
  )!;
  expect(within(january).getAllByRole('button')).toHaveLength(40);
  expect(january.textContent).toContain('40/50 original values shown');
  const coverage = screen.getByRole('table', { name: copy.reportWindowsLabel });
  expect(
    within(coverage).getAllByRole('button', { hidden: true }),
  ).toHaveLength(40);
  expect(coverage.textContent).toContain('40/50 original values shown');
  fireEvent.click(
    within(readout).getByRole('button', { name: /Show more original values/ }),
  );
  const buttons = within(january).getAllByRole('button');
  expect(buttons).toHaveLength(50);
  expect(
    within(coverage).getAllByRole('button', { hidden: true }),
  ).toHaveLength(50);
  fireEvent.click(buttons[49]);
  expect(select).toHaveBeenCalledExactlyOnceWith('record-49');
});

it('reveals later months without changing the applied window or monthly coverage counts', () => {
  const data = fixture(Array.from({ length: 13 }, () => 'Ⅱ'));
  const month = (index: number) =>
    `${2023 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  data.pack.records = data.pack.records.map((record, index) => ({
    ...record,
    time: { ...record.time, start: month(index), end: month(index) },
  }));
  data.facts = {
    ...data.facts,
    requirement: {
      ...data.facts.requirement,
      window: { start: '2023-01', end: '2024-02' },
    },
    records: data.facts.records.map((record, index) => ({
      ...record,
      time: { ...record.time, value: month(index) },
    })),
  };
  const { copy, select } = openDensity('en', data);
  const readout = screen.getByTestId('readiness-monthly-values');
  expect(readout.querySelectorAll('[data-readout-month]')).toHaveLength(12);
  expect(readout.textContent).toContain('12/14 months shown');
  expect(readout.textContent).not.toContain('Monthly source 12');
  const coverageBefore = screen.getByRole('table', {
    name: copy.reportWindowsLabel,
  }).textContent;
  fireEvent.click(
    within(readout).getByRole('button', { name: /Show more months/ }),
  );
  expect(readout.querySelectorAll('[data-readout-month]')).toHaveLength(14);
  expect(
    readout
      .querySelector('[data-readout-month="2024-02"]')
      ?.getAttribute('data-readout-state'),
  ).toBe('MISSING');
  expect(
    screen.getByRole('table', { name: copy.reportWindowsLabel }).textContent,
  ).toBe(coverageBefore);
  fireEvent.click(
    within(
      readout.querySelector<HTMLElement>('[data-readout-month="2024-01"]')!,
    ).getByRole('button'),
  );
  expect(select).toHaveBeenCalledExactlyOnceWith('record-12');
});

it('links the selected original value to its current exact source and fixed version', () => {
  const data = fixture(['Ⅱ']);
  const { copy } = openDensity(
    'en',
    data,
    vi.fn(),
    (id, version) => `/fixed-original/${id}?version=${version}`,
  );
  const readout = screen.getByTestId('readiness-monthly-values');
  expect(
    within(readout)
      .getByRole('link', { name: copy.evidence })
      .getAttribute('href'),
  ).toBe('/fixed-original/source-0?version=version-0');
  const details = within(readout)
    .getByText(copy.technicalDetails)
    .closest('details')!;
  expect(details.textContent).toContain('work-0');
  expect(details.textContent).toContain('version-0');
  expect(details.textContent).toContain(
    materialReference(data.pack.sources[0]).assetId,
  );
  expect(details.textContent).toContain('table:1/row:5');
});
