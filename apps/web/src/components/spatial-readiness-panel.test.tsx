// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { getDictionary } from '../lib/i18n';
import { syntheticReviewRecord } from '../lib/spatial-candidate-review';
import {
  SpatialReadinessPanel,
  type ReadinessCopy,
} from './spatial-readiness-panel';
import type {
  Material,
  RegionId,
  WorkspacePack,
} from '../lib/spatial-workspace-contract';
import type { ProjectReadinessInput } from '@wiser/data-core/project-readiness';
import { materialReference } from '../lib/spatial-readiness-facts';
import * as readiness from '../lib/spatial-readiness';
const copy: ReadinessCopy = {
  ...getDictionary('en').dataFoundation.spatialReadiness,
  title: 'Readiness',
  scopeNote: 'Slots are not datasets',
  unknown: 'Unknown',
  needHeading: 'Demand evidence',
  needLabel: 'Need',
  stateLabel: 'Status',
  sourcesLabel: 'Sources',
  recordsLabel: 'Records',
  counts: {
    ...getDictionary('en').dataFoundation.spatialReadiness.counts,
    sources: 'Independent sources',
    versions: 'Versions',
    records: 'Candidate rows',
    sourceObjects: 'Source objects',
    geometryRecords: 'Geometries',
    samplingSites: 'Sampling sites',
    validObservations: 'Valid observations',
    professionallyReviewed: 'Reviewed',
  },
  questionLabels: {
    inventory: 'What exists',
    quantity: 'How much',
    quality: 'Quality',
    structure: 'Structure',
    density: 'Density',
    gaps: 'Gaps',
    cleaning: 'Cleaning',
    'quality-control': 'Checks',
    computations: 'Computations',
  },
  detailLabels: {},
  needLabels: {},
  states: {
    'not-obtained': 'Not obtained',
    partial: 'Partial',
    restricted: 'Restricted',
    stale: 'Stale',
  },
  inspect: 'Inspect',
  usesHeading: 'Uses',
  useLabels: {
    archive: 'Archive',
    'monthly-category': 'Categories',
    'report-summary': 'Report',
    'reference-map': 'Reference map',
    'concentration-trend': 'Concentration',
    'pollution-load': 'Load',
  },
  useEligible: 'Eligible',
  useBlocked: 'Insufficient evidence',
  reportWindowsLabel: 'Report months',
  missingWindowsLabel: 'Missing months',
  fieldNamesLabel: 'Fields',
  statusLabels: {
    original: 'Original',
    parsed: 'Parsed',
    checked: 'Checked',
    professionalReview: 'Review',
    space: 'Space',
    use: 'Use',
  },
  gapLabel: 'Missing',
  none: 'None',
  staleLabel: 'Affected records',
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([
  {
    locale: 'zh-CN' as const,
    label: '当前可见范围',
    boundary: '不表示全部所需资料已获授权',
  },
  {
    locale: 'en' as const,
    label: 'Current visible scope',
    boundary: 'does not establish authorization for every required material',
  },
])(
  'labels the matrix as current visible scope in $locale without hidden counts',
  ({ locale, label, boundary }) => {
    const localized = {
      ...copy,
      ...getDictionary(locale).dataFoundation.spatialReadiness,
    };
    const input = inspectionPack();
    const hidden = {
      ...input.sources[0],
      id: 'hidden-source',
      title: 'Hidden source name',
      rights: { ...input.sources[0].rights, displayAllowed: false },
    };
    render(
      <SpatialReadinessPanel
        pack={{
          ...input,
          sources: [...input.sources, hidden],
          records: [
            ...input.records,
            { ...input.records[0], id: 'hidden-record', sourceId: hidden.id },
          ],
        }}
        regionId="chaobai"
        copy={localized}
      />,
    );
    const cell = document.querySelector(
      'button[data-matrix-region="chaobai"][data-matrix-need="K5-001"]',
    );
    expect(cell?.textContent).toContain(label);
    expect(localized.matrixHelp).toContain(boundary);
    expect(screen.queryByText('Hidden source name')).toBeNull();
    expect(document.body.textContent).not.toContain('hidden-record');
  },
);
function inspectionPack(): WorkspacePack {
  const record = {
    ...syntheticReviewRecord(),
    reviewStatus: 'pending' as const,
    needIds: ['K5-001'],
  };
  const source: Material = {
    id: record.sourceId,
    versionId: record.versionId,
    title: 'Fixed source',
    provider: 'Public provider',
    kind: 'report',
    originalSha256: 'a'.repeat(64),
    evidenceUrl: null,
    rights: {
      public: true,
      displayAllowed: true,
      redistributionAllowed: false,
      note: 'Local inspection',
    },
    regionIds: ['chaobai'],
    needIds: record.needIds,
    processingVersion: record.processingVersion,
    duplicateOf: null,
    status: {
      original: 'obtained',
      parsed: 'partial',
      checked: 'unknown',
      professionalReview: 'pending',
      space: 'text-only',
      use: 'local-inspection',
    },
  };
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-03',
    processingVersion: 'p1',
    sources: [source],
    records: [
      record,
      { ...record, id: 'later-record', objectLabel: 'Later original object' },
    ],
    regions: [],
    topicPackages: [],
    rasterReports: [],
  };
}
function ControlledPanel({
  pack,
  onSelectRegion,
}: {
  pack: WorkspacePack;
  onSelectRegion?: (id: RegionId) => void;
}) {
  const [regionId, setRegionId] = useState<RegionId>('bth');
  return (
    <>
      <button type="button" onClick={() => setRegionId('bth')}>
        Return to overview
      </button>
      <SpatialReadinessPanel
        pack={pack}
        regionId={regionId}
        copy={copy}
        onSelectRegion={(id) => {
          onSelectRegion?.(id);
          setRegionId(id);
        }}
      />
    </>
  );
}
it('reuses readiness calculation during unrelated rerenders and recalculates changed stale facts', () => {
  const calculation = vi.spyOn(readiness, 'buildReadiness');
  const pack = inspectionPack();
  const { rerender } = render(
    <SpatialReadinessPanel pack={pack} regionId="chaobai" copy={copy} />,
  );
  const initialCalls = calculation.mock.calls.length;
  expect(initialCalls).toBeGreaterThan(0);
  rerender(
    <SpatialReadinessPanel
      pack={pack}
      regionId="chaobai"
      copy={copy}
      onSelectRecord={vi.fn()}
    />,
  );
  expect(calculation.mock.calls.length).toBe(initialCalls);
  rerender(
    <SpatialReadinessPanel
      pack={pack}
      regionId="chaobai"
      copy={copy}
      staleRecordIds={[pack.records[0].id]}
    />,
  );
  expect(calculation.mock.calls.length).toBeGreaterThan(initialCalls);
  expect(screen.getByRole('status').textContent).toContain(copy.staleLabel);
});
it('opens the actual quantity result set and lets the reader choose a later record', () => {
  const select = vi.fn();
  render(
    <SpatialReadinessPanel
      pack={inspectionPack()}
      regionId="chaobai"
      copy={copy}
      onSelectRecord={select}
    />,
  );
  const article = screen
    .getByRole('heading', { name: 'How much' })
    .closest('article')!;
  fireEvent.click(within(article).getByRole('button', { name: /Inspect/ }));
  expect(select).not.toHaveBeenCalled();
  const details = screen.getByRole('region', { name: 'How much' });
  fireEvent.click(
    within(
      within(details).getByRole('group', { name: copy.grains.RECORD }),
    ).getByRole('button', { name: /Later original object/ }),
  );
  expect(select).toHaveBeenCalledExactlyOnceWith('later-record');
});
it('does not claim a cleaning processor or open every record as a cleaning task', () => {
  render(
    <SpatialReadinessPanel
      pack={inspectionPack()}
      regionId="chaobai"
      copy={{
        ...copy,
        detailLabels: {
          'local-deterministic-processing': 'Local processor assigned',
        },
      }}
      onSelectRecord={vi.fn()}
    />,
  );
  const article = screen
    .getByRole('heading', { name: 'Cleaning' })
    .closest('article')!;
  expect(within(article).queryByText('Local processor assigned')).toBeNull();
  expect(within(article).queryByRole('button', { name: /Inspect/ })).toBeNull();
});
it('opens each source-version detail with only its own fixed-version link', () => {
  const pack = inspectionPack();
  pack.sources.push({
    ...pack.sources[0],
    versionId: 'v2',
    title: 'Second fixed version',
  });
  pack.records[1] = { ...pack.records[1], versionId: 'v2' };
  render(
    <SpatialReadinessPanel
      pack={pack}
      regionId="chaobai"
      copy={copy}
      sourceHref={(id, version) => `/source?source=${id}&version=${version}`}
    />,
  );
  const article = screen
    .getByRole('heading', { name: 'How much' })
    .closest('article')!;
  fireEvent.click(within(article).getByRole('button', { name: /Inspect/ }));
  const details = screen.getByRole('region', { name: 'How much' });
  fireEvent.click(within(details).getByText(`${copy.grains.VERSION} (2)`));
  const group = within(details).getByRole('group', {
    name: copy.grains.VERSION,
  });
  const links = within(group).getAllByRole('link');
  expect(links).toHaveLength(2);
  expect(links[0].getAttribute('href')).toContain(
    `version=${pack.sources[0].versionId}`,
  );
  expect(links[1].getAttribute('href')).toContain('version=v2');
});
it('rejects an overlong inclusive coverage window without replacing the current result', () => {
  render(
    <SpatialReadinessPanel
      pack={inspectionPack()}
      regionId="chaobai"
      copy={copy}
    />,
  );
  fireEvent.change(screen.getByLabelText(copy.startMonth), {
    target: { value: '1923-04' },
  });
  fireEvent.change(screen.getByLabelText(copy.endMonth), {
    target: { value: '2023-04' },
  });
  fireEvent.click(screen.getByRole('button', { name: copy.applyWindow }));
  expect(screen.getByRole('alert').textContent).toBe(copy.windowError);
  expect(
    screen.getByTestId('readiness-active-scope').textContent,
  ).not.toContain('1923-04');
});
it('separates same-ID facts by grain and leaves an unassigned task owner explicit', () => {
  const pack = inspectionPack();
  const source = materialReference(pack.sources[0]);
  const evidence = [
    { source, locator: 'test:record', excerpt: 'Synthetic unit-test evidence' },
  ];
  const facts: ProjectReadinessInput = {
    track: 'REAL',
    requirement: {
      needId: 'K5-001',
      version: 'test-v1',
      regionId: 'chaobai',
      purpose: 'inspection',
      dateRole: 'PUBLICATION',
      window: null,
    },
    sources: [
      {
        ...source,
        track: 'REAL',
        kind: 'DOCUMENT',
        needIds: ['K5-001'],
        regionIds: ['chaobai'],
      },
    ],
    records: [],
    series: [],
    correspondences: [],
    fields: [
      {
        id: 'same-id',
        source,
        name: 'Native field',
        type: 'string',
        unit: null,
        timeRole: null,
        positionRole: null,
        primaryKey: null,
        formatVersion: null,
        evidence,
      },
    ],
    tasks: [
      {
        id: 'same-id',
        kind: 'CLEANING',
        sources: [source],
        recordIds: [],
        state: 'OPEN',
        owner: null,
        processor: null,
        nextAction: 'Inspect the original',
        evidence,
      },
    ],
  };
  render(
    <SpatialReadinessPanel
      pack={pack}
      regionId="chaobai"
      copy={copy}
      facts={facts}
    />,
  );
  const card = screen
    .getByRole('heading', { name: 'Cleaning' })
    .closest('article')!;
  fireEvent.click(within(card).getByRole('button', { name: /Inspect/ }));
  const details = screen.getByRole('region', { name: 'Cleaning' });
  expect(within(details).getByText(copy.unassigned)).toBeTruthy();
  expect(within(details).getByText(copy.notRegistered)).toBeTruthy();
  expect(within(details).queryByText(copy.fieldType)).toBeNull();
});
it('removes an opened record set as soon as its fixed source loses readability', () => {
  const pack = inspectionPack();
  const select = vi.fn();
  const view = render(
    <SpatialReadinessPanel
      pack={pack}
      regionId="chaobai"
      copy={copy}
      onSelectRecord={select}
    />,
  );
  fireEvent.click(
    within(
      screen.getByRole('heading', { name: 'How much' }).closest('article')!,
    ).getByRole('button', { name: /Inspect/ }),
  );
  expect(screen.getByRole('region', { name: 'How much' })).toBeTruthy();
  view.rerender(
    <SpatialReadinessPanel
      pack={{
        ...pack,
        sources: pack.sources.map((source) => ({
          ...source,
          rights: { ...source.rights, displayAllowed: false },
        })),
      }}
      regionId="chaobai"
      copy={copy}
      onSelectRecord={select}
    />,
  );
  expect(screen.queryByRole('region', { name: 'How much' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: /Later original object/ }),
  ).toBeNull();
  expect(select).not.toHaveBeenCalled();
});
it('shows all nine questions and 19 needs and passes an explicitly selected evidence record upward', () => {
  const pack = inspectionPack();
  pack.records = pack.records.slice(0, 1);
  const record = pack.records[0];
  const select = vi.fn();
  render(
    <SpatialReadinessPanel
      pack={pack}
      regionId="chaobai"
      copy={copy}
      onSelectRecord={select}
    />,
  );
  for (const title of Object.values(copy.questionLabels)) {
    expect(
      screen.getByRole('heading', { level: 3, name: title }).closest('article'),
    ).not.toBeNull();
  }
  expect(
    within(screen.getByText(copy.needHeading).parentElement!).getAllByText(
      /^K5-\d{3}$/,
    ),
  ).toHaveLength(19);
  expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  const article = screen
    .getByRole('heading', { name: 'How much' })
    .closest('article')!;
  fireEvent.click(within(article).getByRole('button', { name: /Inspect/ }));
  expect(select).not.toHaveBeenCalled();
  const detail = screen.getByRole('region', { name: 'How much' });
  fireEvent.click(
    within(
      within(detail).getByRole('group', { name: copy.grains.RECORD }),
    ).getByRole('button'),
  );
  expect(select).toHaveBeenCalledWith(record.id);
});

it('places the six-range matrix first and selects the matching need and regional detail', () => {
  const onSelectRegion = vi.fn();
  render(
    <ControlledPanel pack={inspectionPack()} onSelectRegion={onSelectRegion} />,
  );
  const matrix = screen.getByRole('region', { name: copy.matrixTitle });
  expect(matrix.querySelectorAll('button[data-matrix-region]')).toHaveLength(
    114,
  );
  const cell = matrix.querySelector<HTMLButtonElement>(
    'button[data-matrix-region="chaobai"][data-matrix-need="K5-001"]',
  )!;
  fireEvent.click(cell);
  expect(onSelectRegion).toHaveBeenCalledWith('chaobai');
  expect(screen.getByTestId('readiness-active-scope').textContent).toContain(
    copy.matrixRegions.chaobai,
  );
  expect(
    screen.getByRole<HTMLSelectElement>('combobox', {
      name: copy.needLabel,
    }).value,
  ).toBe('K5-001');
  expect(cell.getAttribute('aria-pressed')).toBe('true');
});

it('follows the controlled parent when returning to the region before a matrix selection', () => {
  render(<ControlledPanel pack={inspectionPack()} />);
  const matrix = screen.getByRole('region', { name: copy.matrixTitle });
  const regionalCell = matrix.querySelector<HTMLButtonElement>(
    'button[data-matrix-region="chaobai"][data-matrix-need="K5-001"]',
  );
  const overviewCell = matrix.querySelector<HTMLButtonElement>(
    'button[data-matrix-region="bth"][data-matrix-need="K5-001"]',
  );
  if (!regionalCell || !overviewCell) throw new Error('Matrix fixture missing');
  fireEvent.click(regionalCell);
  expect(screen.getByTestId('readiness-active-scope').textContent).toContain(
    copy.matrixRegions.chaobai,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Return to overview' }));
  expect(screen.getByTestId('readiness-active-scope').textContent).toContain(
    copy.matrixRegions.bth,
  );
  expect(overviewCell.getAttribute('aria-pressed')).toBe('true');
  expect(regionalCell.getAttribute('aria-pressed')).toBe('false');
});

it('retains standalone matrix selection without a controlled parent callback', () => {
  render(
    <SpatialReadinessPanel
      pack={inspectionPack()}
      regionId="bth"
      copy={copy}
    />,
  );
  const matrix = screen.getByRole('region', { name: copy.matrixTitle });
  const cell = matrix.querySelector<HTMLButtonElement>(
    'button[data-matrix-region="chaobai"][data-matrix-need="K5-001"]',
  );
  if (!cell) throw new Error('Matrix fixture missing');
  fireEvent.click(cell);
  expect(screen.getByTestId('readiness-active-scope').textContent).toContain(
    copy.matrixRegions.chaobai,
  );
  expect(cell.getAttribute('aria-pressed')).toBe('true');
});

it('shows unknown computation information separately from an unmet-condition verdict', () => {
  render(
    <SpatialReadinessPanel
      pack={inspectionPack()}
      regionId="chaobai"
      copy={copy}
    />,
  );
  const uses = screen.getByText(copy.usesHeading).parentElement!;
  const load = within(uses)
    .getByText(copy.useLabels['pollution-load'])
    .closest('li')!;
  expect(
    within(load)
      .getByText(copy.factStates.UNKNOWN)
      .getAttribute('data-use-state'),
  ).toBe('UNKNOWN');
});

it('opens gap followups with only explicit candidate identities in the selected region and demand', () => {
  const pack = inspectionPack();
  const candidateReference = {
    kind: 'ingestion-candidate' as const,
    ingestionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    processingBatchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    reviewHash: 'c'.repeat(64),
  };
  const candidateSource = {
    candidateReference,
    assetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sourceLocalWorkId: 'Actual candidate A',
    track: 'REAL' as const,
    kind: 'DOCUMENT' as const,
    needIds: ['K5-001'],
    regionIds: ['chaobai'],
  };
  const facts: ProjectReadinessInput = {
    track: 'REAL',
    requirement: {
      needId: 'K5-001',
      version: 'current-rule',
      regionId: 'chaobai',
      purpose: 'inspection',
      dateRole: 'PUBLICATION',
      window: null,
    },
    sources: [
      candidateSource,
      {
        ...candidateSource,
        sourceLocalWorkId: 'Other region source',
        regionIds: ['yongding'],
        candidateReference: {
          ...candidateReference,
          reviewHash: 'e'.repeat(64),
        },
      },
      {
        ...materialReference(pack.sources[0]),
        track: 'REAL',
        kind: 'DOCUMENT',
        needIds: ['K5-001'],
        regionIds: ['chaobai'],
      },
    ],
    records: [],
    series: [],
    correspondences: [],
  };
  render(
    <SpatialReadinessPanel
      locale="en"
      pack={pack}
      regionId="chaobai"
      copy={copy}
      facts={facts}
    />,
  );
  const question = screen
    .getByRole('heading', { level: 3, name: 'Gaps' })
    .closest('article')!;
  fireEvent.click(within(question).getByRole('button', { name: copy.inspect }));
  const select = screen.getByLabelText('Fixed candidate source');
  expect(within(select).getAllByRole('option')).toHaveLength(1);
  expect(
    within(select).getByRole('option', { name: 'Actual candidate A' }),
  ).toBeTruthy();
  expect(
    within(select).queryByRole('option', { name: 'Other region source' }),
  ).toBeNull();
  expect(screen.queryByText(/Select a fixed candidate source/)).toBeNull();
});
