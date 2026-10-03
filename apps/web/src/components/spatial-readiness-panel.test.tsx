// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { syntheticReviewRecord } from '../lib/spatial-candidate-review';
import {
  SpatialReadinessPanel,
  type ReadinessCopy,
} from './spatial-readiness-panel';
import type {
  Material,
  WorkspacePack,
} from '../lib/spatial-workspace-contract';
const copy: ReadinessCopy = {
  title: 'Readiness',
  scopeNote: 'Slots are not datasets',
  unknown: 'Unknown',
  needHeading: 'Demand evidence',
  needLabel: 'Need',
  stateLabel: 'Status',
  sourcesLabel: 'Sources',
  recordsLabel: 'Records',
  counts: {
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
afterEach(cleanup);
function inspectionPack(): WorkspacePack {
  const record = {
    ...syntheticReviewRecord(),
    reviewStatus: 'pending' as const,
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
    within(details).getByRole('button', { name: /Later original object/ }),
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
it('shows all nine questions and 19 needs and passes an evidence selection upward', () => {
  const record = {
    ...syntheticReviewRecord(),
    reviewStatus: 'pending' as const,
  };
  const pack: WorkspacePack = {
    schemaVersion: 1,
    generatedAt: '2026-10-02',
    processingVersion: 'p1',
    sources: [],
    records: [record],
    regions: [],
    topicPackages: [],
    rasterReports: [],
  };
  const select = vi.fn();
  render(
    <SpatialReadinessPanel
      pack={pack}
      regionId="chaobai"
      copy={copy}
      onSelectRecord={select}
    />,
  );
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(9);
  expect(screen.getAllByText(/^K5-\d{3}$/)).toHaveLength(19);
  expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole('button', { name: /Inspect/ })[0]);
  expect(select).toHaveBeenCalledWith(record.id);
});
