// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  WorkspacePack,
  WorkspaceRecord,
} from '@/lib/spatial-workspace-contract';
import { SpatialWorkspaceShell } from './spatial-workspace-shell';

vi.mock('./spatial-workspace', () => ({
  SpatialWorkspace: (props: {
    regionId: string;
    selectedRecordId: string | null;
    invalidations: unknown[];
    storageKey: string;
    onRegionChange: (id: string) => void;
    onSelectRecord: (id: string) => void;
  }) => (
    <div
      data-testid={
        props.storageKey.includes('synthetic')
          ? 'spatial-exercise-state'
          : 'spatial-state'
      }
    >
      <output>{JSON.stringify(props)}</output>
      <button
        onClick={() => {
          props.onRegionChange('beiyun');
          props.onSelectRecord('changed-in-exercise');
        }}
      >
        change view in {props.storageKey}
      </button>
    </div>
  ),
}));
vi.mock('./spatial-readiness-panel', () => ({
  SpatialReadinessPanel: (props: {
    onSelectRecord: (id: string) => void;
    staleRecordIds: string[];
  }) => (
    <div>
      <button onClick={() => props.onSelectRecord('r1')}>inspect record</button>
      <output data-testid="matrix-impact">
        {JSON.stringify(props.staleRecordIds)}
      </output>
    </div>
  ),
}));
vi.mock('./spatial-candidate-review', () => ({
  SpatialCandidateReview: (props: {
    record: { id: string } | null;
    onRegenerate: (...args: unknown[]) => void;
    onEndExercise: () => void;
  }) => (
    <div>
      <output data-testid="candidate-selection">{props.record?.id}</output>
      <button
        onClick={() =>
          props.onRegenerate({}, [], {
            originalRecordId: 'r1',
            originalSourceId: 's1',
            originalVersionId: 'v1',
            syntheticRecordId: 'synthetic',
          })
        }
      >
        regenerate exercise
      </button>
      <button onClick={props.onEndExercise}>return to real</button>
    </div>
  ),
}));
const record = {
  id: 'r1',
  sourceId: 's1',
  versionId: 'v1',
  objectId: 's1:object',
  objectLabel: '真实河段',
  kind: 'observation',
  regionIds: ['chaobai'],
  needIds: ['K5-001'],
  time: {
    start: '2023-04',
    end: '2023-04',
    precision: 'month',
    role: 'observation',
  },
  metric: '水质类别',
  value: 'Ⅲ',
  unit: null,
  positions: [],
  evidence: [],
  processingVersion: 'p1',
  reviewStatus: 'pending',
  missingReasons: [],
} as const;
const pack: WorkspacePack = {
  schemaVersion: 1,
  generatedAt: '2026-10-02T00:00:00Z',
  processingVersion: 'p1',
  sources: [],
  records: [JSON.parse(JSON.stringify(record)) as WorkspaceRecord],
  regions: [
    {
      id: 'bth',
      name: '京津冀',
      aliases: [],
      type: 'region',
      bounds: [113, 36, 120, 43],
    },
    {
      id: 'chaobai',
      name: '潮白河',
      aliases: [],
      type: 'basin',
      bounds: [115, 39, 118, 42],
    },
  ],
  topicPackages: [],
  rasterReports: [],
};
afterEach(cleanup);
it('carries a real matrix selection into the region, dossier and candidate review in one workspace', () => {
  render(<SpatialWorkspaceShell pack={pack} locale="zh-CN" />);
  fireEvent.click(screen.getByRole('tab', { name: '资料就绪与复核' }));
  fireEvent.click(screen.getByRole('button', { name: 'inspect record' }));
  expect(screen.getByTestId('spatial-state').textContent).toContain(
    '"regionId":"chaobai"',
  );
  expect(screen.getByTestId('spatial-state').textContent).toContain(
    '"selectedRecordId":"r1"',
  );
  expect(screen.getByTestId('candidate-selection').textContent).toBe('r1');
  expect(
    screen
      .getByRole('tab', { name: '空间与证据' })
      .getAttribute('aria-selected'),
  ).toBe('true');
});
it('isolates exercise views and saved scenes while preserving the mounted real selection on exit', () => {
  const before = JSON.stringify(pack);
  render(<SpatialWorkspaceShell pack={pack} locale="zh-CN" />);
  fireEvent.click(screen.getByRole('tab', { name: '资料就绪与复核' }));
  fireEvent.click(screen.getByRole('button', { name: 'inspect record' }));
  const realBefore = screen.getByTestId('spatial-state').textContent;
  fireEvent.click(screen.getByRole('button', { name: 'regenerate exercise' }));
  expect(screen.getByTestId('matrix-impact').textContent).toBe('["r1"]');
  expect(screen.getByTestId('spatial-exercise-state').textContent).toContain(
    '"affectedRecordIds":["r1"]',
  );
  expect(screen.getByTestId('spatial-state').textContent).toBe(realBefore);
  fireEvent.click(
    screen.getByRole('button', { name: /change view in .*synthetic/ }),
  );
  expect(screen.getByTestId('spatial-exercise-state').textContent).toContain(
    '"regionId":"beiyun"',
  );
  expect(screen.getByTestId('spatial-state').textContent).toBe(realBefore);
  expect(screen.getByRole('status', { name: '合成演练依赖预览' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'return to real' }));
  expect(screen.getByTestId('matrix-impact').textContent).toBe('[]');
  expect(screen.getByTestId('spatial-state').textContent).toContain(
    '"invalidations":[]',
  );
  expect(screen.getByTestId('spatial-state').textContent).toBe(realBefore);
  expect(screen.queryByTestId('spatial-exercise-state')).toBeNull();
  expect(JSON.stringify(pack)).toBe(before);
});
