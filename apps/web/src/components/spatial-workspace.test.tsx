// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import type {
  WorkspacePack,
  WorkspaceRecord,
} from '@/lib/spatial-workspace-contract';
import { getDictionary } from '@/lib/i18n';
import { SpatialWorkspace } from './spatial-workspace';

vi.mock('./spatial-workspace-map', () => ({
  SpatialWorkspaceMap: (props: {
    features: {
      features: { properties: { recordId: string; positionId: string } }[];
    };
    camera: { pitch: number; bearing: number };
    onCamera: (value: unknown) => void;
    onSelect: (value: unknown) => void;
  }) => (
    <div
      data-testid="workspace-map"
      data-pitch={props.camera.pitch}
      data-bearing={props.camera.bearing}
    >
      <button
        onClick={() =>
          props.onCamera({
            longitude: 117,
            latitude: 40,
            zoom: 7,
            pitch: 50,
            bearing: 35,
          })
        }
      >
        Move map
      </button>
      {props.features.features.map((feature) => (
        <button
          key={`${feature.properties.recordId}:${feature.properties.positionId}`}
          onClick={() =>
            props.onSelect({
              recordId: feature.properties.recordId,
              positionId: feature.properties.positionId,
            })
          }
        >
          {feature.properties.recordId}:{feature.properties.positionId}
        </button>
      ))}
    </div>
  ),
}));

const zh = getDictionary('zh-CN').dataFoundation.spatialWorkspace;
const en = getDictionary('en').dataFoundation.spatialWorkspace;
const sampleRecord: WorkspaceRecord = {
  id: 'record-1',
  sourceId: 'report',
  versionId: 'v1',
  objectId: 'source-local-object',
  objectLabel: '潮白河原文对象',
  kind: 'observation',
  regionIds: ['chaobai'],
  needIds: ['K5-001'],
  time: {
    start: '2023-12',
    end: '2023-12',
    precision: 'month',
    role: 'observation',
  },
  metric: '溶解氧',
  value: '7.8',
  unit: 'mg/L',
  processingVersion: 'parse1',
  reviewStatus: 'pending',
  missingReasons: ['仅有一个月'],
  evidence: [
    {
      locator: '表1 行2',
      text: '潮白河 7.8 mg/L',
      url: 'https://example.gov.cn/report',
    },
  ],
  positions: [
    {
      id: 'pos-line',
      expression: '潮白河参考线',
      role: 'reference',
      match: 'bound',
      crs: 'EPSG:4326',
      nativeCrs: 'EPSG:4326',
      geometrySourceId: 'report',
      geometryVersionId: 'v1',
      locator: 'feature 1',
      scaleNote: '参考线，位置待核',
      evidence: { locator: '表1 行2', text: '潮白河' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [116, 39],
          [118, 41],
        ],
      },
    },
  ],
};
const pack: WorkspacePack = {
  schemaVersion: 1,
  generatedAt: '2026-10-02',
  processingVersion: 'parse1',
  sources: [
    {
      id: 'report',
      versionId: 'v1',
      title: '固定版本公开报告',
      provider: '公开机构',
      kind: 'report',
      originalSha256: 'a'.repeat(64),
      originalPath: '/private/original.pdf',
      evidenceUrl: 'https://example.gov.cn/report',
      regionIds: ['chaobai'],
      needIds: ['K5-001'],
      processingVersion: 'parse1',
      duplicateOf: null,
      rights: {
        public: true,
        displayAllowed: true,
        redistributionAllowed: true,
        note: '原件许可',
      },
      status: {
        original: 'obtained',
        parsed: 'partial',
        checked: 'pending',
        professionalReview: 'pending',
        space: 'reference',
        use: 'reading',
      },
    },
  ],
  records: [
    sampleRecord,
    {
      ...sampleRecord,
      id: 'record-unknown',
      objectId: 'unknown',
      objectLabel: '未定位对象',
      time: { start: null, end: null, precision: 'unknown', role: 'unknown' },
      positions: [
        {
          ...sampleRecord.positions[0],
          id: 'pos-unknown',
          match: 'text-only',
          geometry: null,
          geometrySourceId: null,
          geometryVersionId: null,
          locator: null,
        },
      ],
    },
  ],
  regions: [
    {
      id: 'bth',
      name: '京津冀',
      aliases: [],
      type: 'administrative',
      bounds: [113, 36, 120, 43],
    },
    {
      id: 'chaobai',
      name: '潮白河',
      aliases: [],
      type: 'basin',
      bounds: [116, 39, 118, 42],
    },
    {
      id: 'beiyun',
      name: '北运河',
      aliases: [],
      type: 'basin',
      bounds: [116, 38, 118, 41],
    },
    {
      id: 'yongding',
      name: '永定河',
      aliases: [],
      type: 'basin',
      bounds: [114, 38, 117, 42],
    },
    {
      id: 'daqing-baiyangdian',
      name: '大清河—白洋淀',
      aliases: [],
      type: 'basin',
      bounds: [114, 37, 118, 40],
    },
    {
      id: 'bohai',
      name: '渤海湾',
      aliases: [],
      type: 'composite',
      bounds: [117, 37, 120, 40],
    },
  ],
  topicPackages: [
    {
      id: 'topic1',
      title: '潮白河专题资料',
      regionIds: ['chaobai'],
      sourceIds: ['report'],
      recordIds: ['record-1'],
      question: '当前证据覆盖什么',
      gaps: ['缺少连续观测'],
    },
  ],
  rasterReports: [],
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe('spatial workspace actual interactions', () => {
  it('consumes the corrected shared locale branch and preserves dictionary structure', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    render(<SpatialWorkspace pack={pack} locale="en" copy={en} />);
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: en.regions.bohai }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(zh.description)).toBeNull();
  });

  it('navigates all six scopes and clears a previous region rectangle', () => {
    const onRegionChange = vi.fn();
    render(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        onRegionChange={onRegionChange}
      />,
    );
    fireEvent.change(screen.getByLabelText(zh.bbox), {
      target: { value: '116,39,117,40' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.applyBounds }));
    fireEvent.click(screen.getByRole('button', { name: zh.regions.beiyun }));
    expect(onRegionChange).toHaveBeenLastCalledWith('beiyun');
    expect(screen.getByLabelText<HTMLInputElement>(zh.bbox).value).toBe('');
    for (const id of [
      'bth',
      'yongding',
      'chaobai',
      'beiyun',
      'daqing-baiyangdian',
      'bohai',
    ] as const)
      expect(
        screen.getAllByRole('button', { name: zh.regions[id] }).length,
      ).toBeGreaterThan(0);
  });

  it('retains unknown positions alongside the actual rectangle result and rejects invalid bounds', () => {
    render(<SpatialWorkspace pack={pack} locale="zh-CN" copy={zh} />);
    fireEvent.change(screen.getByLabelText(zh.bbox), {
      target: { value: '116,39,117,40' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.applyBounds }));
    expect(screen.getByTestId('spatial-record-count').textContent).toContain(
      '2',
    );
    expect(screen.getByTestId('spatial-geometry-count').textContent).toContain(
      '1',
    );
    expect(screen.getByRole('button', { name: /未定位对象/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(zh.bbox), {
      target: { value: '117,40,116,39' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.applyBounds }));
    expect(screen.getByRole('alert').textContent).toContain(zh.bboxInvalid);
  });

  it('opens an externally selected fixed-version record with a local original locator', () => {
    const onRegionChange = vi.fn();
    const { rerender } = render(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        regionId="bohai"
        selectedRecordId={null}
        onRegionChange={onRegionChange}
        sourceHref={(id, version) => `/source?source=${id}&version=${version}`}
      />,
    );
    rerender(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        regionId="bohai"
        selectedRecordId="record-1"
        onRegionChange={onRegionChange}
        sourceHref={(id, version) => `/source?source=${id}&version=${version}`}
      />,
    );
    const dossier = screen.getByRole('region', { name: zh.dossierTitle });
    expect(within(dossier).getAllByText('表1 行2').length).toBe(2);
    expect(within(dossier).getByText('参考线，位置待核')).toBeTruthy();
    expect(
      within(dossier)
        .getByRole('link', { name: zh.openOriginal })
        .getAttribute('href'),
    ).toBe('/source?source=report&version=v1');
    expect(onRegionChange).toHaveBeenLastCalledWith('chaobai');
    expect(dossier.textContent).not.toContain('/private/original');
  });

  it('clears selected geometry and all source evidence immediately on withdrawal', () => {
    const onSelectRecord = vi.fn();
    const { rerender } = render(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        selectedRecordId="record-1"
        onSelectRecord={onSelectRecord}
      />,
    );
    expect(screen.getByText('潮白河 7.8 mg/L')).toBeTruthy();
    rerender(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        selectedRecordId="record-1"
        onSelectRecord={onSelectRecord}
        invalidations={[{ sourceId: 'report', state: 'revoked' }]}
      />,
    );
    expect(screen.queryByText('潮白河 7.8 mg/L')).toBeNull();
    expect(screen.queryByRole('link', { name: zh.openOriginal })).toBeNull();
    expect(onSelectRecord).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId('spatial-record-count').textContent).toContain(
      '0',
    );
  });

  it('saves pins and camera, restores the shared region, and refuses stale records', () => {
    const onRegionChange = vi.fn();
    const { rerender } = render(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        onRegionChange={onRegionChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: zh.regions.chaobai }));
    fireEvent.change(screen.getByLabelText(zh.sceneName), {
      target: { value: '固定专题视图' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.saveView }));
    const serialized = localStorage.getItem(
      'wiser-spatial-workspace-goal100-v1',
    )!;
    expect(serialized).toContain('report');
    expect(serialized).not.toContain('潮白河 7.8 mg/L');
    fireEvent.click(screen.getByRole('button', { name: zh.regions.bohai }));
    fireEvent.click(screen.getByRole('button', { name: zh.restoreView }));
    expect(onRegionChange).toHaveBeenLastCalledWith('chaobai');
    rerender(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        onRegionChange={onRegionChange}
        invalidations={[{ sourceId: 'report', state: 'stale' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: zh.restoreView }));
    expect(screen.getByTestId('spatial-record-count').textContent).toContain(
      '0',
    );
    expect(screen.getByRole('status').textContent).toContain(zh.stale);
  });

  it('links both comparison cameras and explicitly keeps insufficient evidence side by side', () => {
    render(<SpatialWorkspace pack={pack} locale="zh-CN" copy={zh} />);
    fireEvent.click(screen.getByLabelText(zh.comparisonTitle));
    const maps = screen.getAllByTestId('workspace-map');
    expect(maps).toHaveLength(2);
    fireEvent.click(within(maps[0]).getByRole('button', { name: 'Move map' }));
    expect(
      screen
        .getAllByTestId('workspace-map')
        .map((map) => map.getAttribute('data-bearing')),
    ).toEqual(['35', '35']);
    expect(screen.getByText(zh.sameObjectOnly)).toBeTruthy();
    expect(screen.getByText(zh.comparisonEmpty)).toBeTruthy();
  });

  it('consumes a topic package and keeps missing coverage in the interface', () => {
    const onRegionChange = vi.fn();
    render(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        onRegionChange={onRegionChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: zh.openTopic }));
    expect(onRegionChange).toHaveBeenLastCalledWith('chaobai');
    expect(screen.getByTestId('spatial-record-count').textContent).toContain(
      '1',
    );
    expect(screen.getByText('缺少连续观测')).toBeTruthy();
  });
});
