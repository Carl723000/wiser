// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspacePack } from '@/lib/spatial-workspace-contract';
import {
  decodeWorkspaceReadingUrl,
  encodeWorkspaceReadingUrl,
  type WorkspaceReadingUrlState,
} from '@/lib/spatial-workspace-url-state';
import { SpatialWorkspaceShell } from './spatial-workspace-shell';

vi.mock('./spatial-workspace-map', () => ({
  SpatialWorkspaceMap: (props: {
    selection: unknown;
    features: {
      features: { properties: { recordId: string; positionId: string } }[];
    };
    onSelect: (selection: unknown) => void;
  }) => (
    <div
      data-testid="reading-map"
      data-selection={JSON.stringify(props.selection)}
    >
      {props.features.features.map(({ properties: p }) => (
        <button
          key={p.positionId}
          onClick={() =>
            props.onSelect({ recordId: p.recordId, positionId: p.positionId })
          }
        >
          {p.recordId}:{p.positionId}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./spatial-raster-inspection', () => ({
  SpatialRasterInspection: () => <div>Raster reader</div>,
}));
vi.mock('./spatial-candidate-review', () => ({
  SpatialCandidateReview: () => <div>Candidate exercise</div>,
}));
function fixture(): WorkspacePack {
  const source = {
    id: 'report',
    versionId: 'v1',
    title: 'Private report',
    provider: 'Test publisher',
    kind: 'report' as const,
    originalSha256: 'a'.repeat(64),
    processingVersion: 'source-rule',
    evidenceUrl: null,
    regionIds: ['chaobai', 'beiyun'] as const,
    needIds: ['K5-001', 'K5-002'],
    rights: {
      public: false,
      displayAllowed: true,
      redistributionAllowed: false,
      note: 'Fixture only',
    },
    status: {
      original: 'saved',
      parsed: 'ready',
      checked: 'unknown',
      professionalReview: 'pending',
      space: 'reference',
      use: 'unknown',
    },
    duplicateOf: null,
  };
  const position = {
    id: 'area-a',
    expression: 'Reference A',
    role: 'reference' as const,
    match: 'bound' as const,
    geometry: { type: 'Point' as const, coordinates: [116, 40] },
    crs: 'EPSG:4326' as const,
    geometrySourceId: 'report',
    geometryVersionId: 'v1',
    locator: 'fixture-feature:1',
    scaleNote: 'Reference only',
    evidence: { locator: 'table:1/row:1', text: 'Reference place' },
  };
  const record = {
    id: 'r1',
    sourceId: 'report',
    versionId: 'v1',
    objectId: 'object-r1',
    objectLabel: 'Private April object',
    kind: 'observation' as const,
    regionIds: ['chaobai'] as const,
    needIds: ['K5-001'],
    time: {
      start: '2023-04',
      end: '2023-04',
      precision: 'month' as const,
      role: 'publication' as const,
    },
    metric: 'grade',
    value: 'Ⅲ',
    unit: null,
    positions: [
      position,
      {
        ...position,
        id: 'area-b',
        expression: 'Reference B',
        geometry: { type: 'Point' as const, coordinates: [117, 41] },
      },
    ],
    evidence: [
      { locator: 'table:1/row:1', text: 'Private April evidence', url: null },
    ],
    processingVersion: 'record-rule',
    reviewStatus: 'pending' as const,
    missingReasons: [],
  };
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-04',
    processingVersion: 'fixture-only',
    sources: [{ ...source, regionIds: [...source.regionIds] }],
    records: [
      { ...record, regionIds: [...record.regionIds] },
      {
        ...record,
        regionIds: [...record.regionIds],
        id: 'r2',
        objectId: 'object-r2',
        objectLabel: 'Private May object',
        positions: [],
        time: { ...record.time, start: '2023-05', end: '2023-05' },
      },
    ],
    regions: ['bth', 'chaobai', 'beiyun'].map((id) => ({
      id: id as 'bth' | 'chaobai' | 'beiyun',
      name: id,
      aliases: [],
      type: 'region',
      bounds: [113, 36, 120, 43],
    })),
    topicPackages: [],
    rasterReports: [],
  };
}
const initial: WorkspaceReadingUrlState = {
  track: 'REAL',
  regionId: 'chaobai',
  needId: 'K5-001',
  dateRole: 'PUBLICATION',
  monthWindow: { start: '2023-04', end: '2023-04' },
  tab: 'spatial',
  pane: 'evidence',
  source: {
    sourceId: 'report',
    versionId: 'v1',
    sha256: 'a'.repeat(64),
    processingVersion: 'source-rule',
  },
  selection: {
    recordId: 'r1',
    processingVersion: 'record-rule',
    position: {
      positionId: 'area-b',
      geometrySource: {
        sourceId: 'report',
        versionId: 'v1',
        sha256: 'a'.repeat(64),
        processingVersion: 'source-rule',
      },
    },
  },
};
function show(pack = fixture(), state = initial) {
  const props = { pack, locale: 'en' as const, initialReadingState: state };
  return render(<SpatialWorkspaceShell {...props} />);
}
function readUrl(pack = fixture()) {
  return decodeWorkspaceReadingUrl(
    new URLSearchParams(window.location.search),
    { pack },
  );
}
function navigate(state: WorkspaceReadingUrlState, pack = fixture()) {
  const link = encodeWorkspaceReadingUrl('en', state, { pack });
  if (link.status !== 'valid') throw new Error('Invalid test navigation');
  window.history.pushState(null, '', link.href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
beforeEach(() =>
  window.history.replaceState(
    null,
    '',
    '/en/data-foundation/spatial-workspace',
  ),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});
it('restores exact position, monthly filters and pane without the legacy first-position/date-reset effect', () => {
  show();
  expect(screen.getByTestId('reading-map').getAttribute('data-selection')).toBe(
    JSON.stringify({ recordId: 'r1', positionId: 'area-b' }),
  );
  expect(screen.getByLabelText('Start date')).toHaveProperty(
    'value',
    '2023-04-01',
  );
  expect(screen.getByLabelText('End date')).toHaveProperty(
    'value',
    '2023-04-30',
  );
  expect(screen.queryByText('Private May object')).toBeNull();
  expect(
    screen.getByRole('region', { name: 'Object evidence dossier' }).textContent,
  ).toContain('Private April evidence');
});
it('restores a record with no selected position without inventing the first geometry', () => {
  show(fixture(), {
    ...initial,
    selection: { ...initial.selection!, position: null },
  });
  expect(screen.getByTestId('reading-map').getAttribute('data-selection')).toBe(
    JSON.stringify({ recordId: 'r1', positionId: null }),
  );
});
it('restores matrix need/date/region and keeps another selected cell after the hidden map effects run', () => {
  show(fixture(), { ...initial, tab: 'readiness' });
  const table = screen.getByRole('region', {
    name: 'Six-range material readiness matrix',
  });
  const cell = table.querySelector<HTMLButtonElement>(
    '[data-matrix-region="chaobai"][data-matrix-need="K5-001"]',
  )!;
  expect(cell.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByLabelText('Coverage start month')).toHaveProperty(
    'value',
    '2023-04',
  );
  const other = table.querySelector<HTMLButtonElement>(
    '[data-matrix-region="beiyun"][data-matrix-need="K5-002"]',
  )!;
  fireEvent.click(other);
  expect(other.getAttribute('aria-pressed')).toBe('true');
  expect(readUrl()).toMatchObject({
    status: 'valid',
    state: {
      regionId: 'beiyun',
      needId: 'K5-002',
      selection: null,
      source: null,
      tab: 'readiness',
    },
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Space and evidence' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Readiness and review' }));
  expect(other.getAttribute('aria-pressed')).toBe('true');
});
it('writes a complete exact geometry pin on map selection and restores it on browser return', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'r1:area-a' }));
  expect(readUrl()).toMatchObject({
    status: 'valid',
    state: {
      selection: {
        recordId: 'r1',
        processingVersion: 'record-rule',
        position: {
          positionId: 'area-a',
          geometrySource: { processingVersion: 'source-rule' },
        },
      },
    },
  });
  act(() => navigate(initial));
  expect(screen.getByTestId('reading-map').getAttribute('data-selection')).toBe(
    JSON.stringify({ recordId: 'r1', positionId: 'area-b' }),
  );
});
it('retains exact native days on refresh props and browser return rather than widening them to a month', () => {
  const day = {
    ...initial,
    monthWindow: null,
    dayWindow: { start: '2023-04-01', end: '2023-04-17' },
  };
  const { rerender } = show(fixture(), day);
  expect(screen.getByLabelText('End date')).toHaveProperty(
    'value',
    '2023-04-17',
  );
  fireEvent.change(screen.getByLabelText('End date'), {
    target: { value: '2023-04-19' },
  });
  expect(readUrl()).toMatchObject({
    status: 'valid',
    state: {
      monthWindow: null,
      dayWindow: { start: '2023-04-01', end: '2023-04-19' },
    },
  });
  act(() => navigate(day));
  expect(screen.getByLabelText('End date')).toHaveProperty(
    'value',
    '2023-04-17',
  );
  rerender(
    <SpatialWorkspaceShell
      {...{ pack: fixture(), locale: 'en' as const, initialReadingState: day }}
    />,
  );
  expect(screen.getByLabelText('End date')).toHaveProperty(
    'value',
    '2023-04-17',
  );
});
it('closes mounted contents for invalid browser navigation instead of silently defaulting', () => {
  show();
  act(() => {
    window.history.pushState(
      null,
      '',
      '/en/data-foundation/spatial-workspace?record=r1',
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(screen.getByRole('alert').textContent).toContain(
    'The link is incomplete',
  );
  expect(screen.queryByTestId('reading-map')).toBeNull();
  expect(screen.queryByText('Private April evidence')).toBeNull();
  expect(
    screen
      .getByRole('link', { name: 'Return to spatial workspace' })
      .getAttribute('href'),
  ).toBe('/en/data-foundation/spatial-workspace');
});
it('clears selected private contents when the current fixed source loses display permission', () => {
  const { rerender } = show();
  const denied = fixture();
  denied.sources[0].rights.displayAllowed = false;
  rerender(
    <SpatialWorkspaceShell
      {...{ pack: denied, locale: 'en' as const, initialReadingState: initial }}
    />,
  );
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByTestId('reading-map')).toBeNull();
  expect(screen.queryByText('Private April evidence')).toBeNull();
});

it('keeps day conditions visible and unchanged on matrix entry until explicit month-window selection', () => {
  const day = {
    ...initial,
    dateRole: null,
    monthWindow: null,
    dayWindow: { start: '2023-04-01', end: '2023-04-17' },
  };
  show(fixture(), day);
  fireEvent.click(screen.getByRole('tab', { name: 'Readiness and review' }));
  expect(
    screen.getByText(
      'The map and originals use exact day boundaries. Choose a month window for monthly coverage inspection.',
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole('region', {
      name: 'Six-range material readiness matrix',
    }),
  ).toBeNull();
  expect(readUrl()).toMatchObject({
    status: 'valid',
    state: { dateRole: null, dayWindow: day.dayWindow, tab: 'readiness' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Choose month window' }));
  const decoded = readUrl();
  expect(decoded).toMatchObject({
    status: 'valid',
    state: { dateRole: null, monthWindow: null, tab: 'readiness' },
  });
  if (decoded.status === 'valid')
    expect(decoded.state).not.toHaveProperty('dayWindow');
  expect(
    screen.getByRole('region', { name: 'Six-range material readiness matrix' }),
  ).toBeTruthy();
});
it('uses keyboard workspace tabs to update reading state without changing exact selection', () => {
  show();
  const tab = screen.getByRole('tab', { name: 'Space and evidence' });
  tab.focus();
  fireEvent.keyDown(tab, { key: 'ArrowRight' });
  expect(
    screen
      .getByRole('tab', { name: 'Readiness and review' })
      .getAttribute('aria-selected'),
  ).toBe('true');
  expect(readUrl()).toMatchObject({
    status: 'valid',
    state: {
      tab: 'readiness',
      selection: initial.selection,
      monthWindow: initial.monthWindow,
    },
  });
});
it('keeps explicit SYNTHETIC records separate from legacy REAL records during URL reading', () => {
  const pack = fixture();
  const source = {
    ...pack.sources[0],
    id: 'synthetic-report',
    versionId: 'synthetic-v1',
    track: 'SYNTHETIC' as const,
    title: 'Synthetic material',
  };
  pack.sources.push(source);
  pack.records.push({
    ...pack.records[0],
    id: 'synthetic-r1',
    sourceId: source.id,
    versionId: source.versionId,
    track: 'SYNTHETIC',
    reviewStatus: 'synthetic-reviewed',
    objectLabel: 'Synthetic April object',
    positions: [],
  });
  const state = {
    ...initial,
    track: 'SYNTHETIC' as const,
    source: {
      ...initial.source!,
      sourceId: source.id,
      versionId: source.versionId,
    },
    selection: {
      recordId: 'synthetic-r1',
      processingVersion: 'record-rule',
      position: null,
    },
  };
  show(pack, state);
  expect(
    screen.getByRole('region', { name: 'Object evidence dossier' }).textContent,
  ).toContain('Synthetic April object');
  expect(screen.queryByText('Private April object')).toBeNull();
  expect(screen.queryByText('Private May object')).toBeNull();
});

it('reapplies a historical emitted location after going back and then forward', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'r1:area-a' }));
  const decoded = readUrl();
  expect(decoded.status).toBe('valid');
  if (decoded.status !== 'valid') throw new Error('No actual emitted state');
  const emitted = decoded.state;
  act(() => navigate(initial));
  expect(screen.getByTestId('reading-map').getAttribute('data-selection')).toBe(
    JSON.stringify({ recordId: 'r1', positionId: 'area-b' }),
  );
  act(() => navigate(emitted));
  expect(readUrl()).toMatchObject({
    status: 'valid',
    state: { selection: { position: { positionId: 'area-a' } } },
  });
  expect(screen.getByTestId('reading-map').getAttribute('data-selection')).toBe(
    JSON.stringify({ recordId: 'r1', positionId: 'area-a' }),
  );
});

it('opens report-period coverage in the actual shell and retains the role on return to the map', () => {
  const pack = fixture();
  pack.schemaVersion = 2;
  pack.records = pack.records.map((record) => ({
    ...record,
    time: { ...record.time, role: 'report-period' },
  }));
  const state: WorkspaceReadingUrlState = {
    ...initial,
    dateRole: 'REPORT_PERIOD',
    tab: 'readiness',
  };
  show(pack, state);
  expect(
    screen.getByRole('region', { name: 'Six-range material readiness matrix' }),
  ).toBeTruthy();
  expect(screen.getByLabelText('Date role')).toHaveProperty(
    'value',
    'REPORT_PERIOD',
  );
  expect(screen.getByTestId('readiness-active-scope').textContent).toContain(
    'Report month',
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Space and evidence' }));
  expect(readUrl(pack)).toMatchObject({
    status: 'valid',
    state: {
      dateRole: 'REPORT_PERIOD',
      monthWindow: initial.monthWindow,
      selection: initial.selection,
    },
  });
  expect(screen.getByTestId('reading-map').getAttribute('data-selection')).toBe(
    JSON.stringify({ recordId: 'r1', positionId: 'area-b' }),
  );
  expect(pack.records[0].time.precision).toBe('month');
  expect(pack.records[0].value).toBe('Ⅲ');
});
