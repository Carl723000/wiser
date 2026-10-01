// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { syntheticReviewRecord } from '../lib/spatial-candidate-review';
import {
  SpatialReadinessPanel,
  type ReadinessCopy,
} from './spatial-readiness-panel';
import type { WorkspacePack } from '../lib/spatial-workspace-contract';
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
