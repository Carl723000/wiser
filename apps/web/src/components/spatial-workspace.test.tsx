// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  act,
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
import { StrictMode, useEffect, useState } from 'react';
import { SpatialWorkspace } from './spatial-workspace';

const mapProbe = vi.hoisted(() => ({
  camera: null as ((value: unknown) => void) | null,
  mounts: 0,
  unmounts: 0,
}));

vi.mock('./spatial-workspace-map', () => ({
  SpatialWorkspaceMap: (props: {
    features: {
      features: { properties: { recordId: string; positionId: string } }[];
    };
    camera: { pitch: number; bearing: number };
    selection: { recordId: string; positionId: string | null } | null;
    onCamera: (value: unknown) => void;
    onSelect: (value: unknown) => void;
  }) => {
    useEffect(() => {
      mapProbe.mounts++;
      return () => {
        mapProbe.unmounts++;
      };
    }, []);
    if (!mapProbe.camera) mapProbe.camera = props.onCamera;
    return (
      <div
        data-testid="workspace-map"
        data-pitch={props.camera.pitch}
        data-bearing={props.camera.bearing}
        data-selection={JSON.stringify(props.selection)}
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
    );
  },
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
  mapProbe.camera = null;
  mapProbe.mounts = 0;
  mapProbe.unmounts = 0;
});
afterEach(cleanup);

describe('spatial workspace actual interactions', () => {
  it.each([
    ['zh-CN', zh, '原资料未公布浓度明细', '政策要求不代表实测成效'],
    [
      'en',
      en,
      'Concentration details not published',
      'Policy requirements are not observed outcomes',
    ],
  ] as const)(
    'explains missing-reason codes in %s while retaining original codes, evidence and counts',
    (locale, copy, concentrationLabel, policyLabel) => {
      const reasons = [
        'concentrations-not-published',
        'policy-not-observed-outcome',
        '仅有一个月',
      ];
      const data = {
        ...pack,
        records: [{ ...sampleRecord, missingReasons: reasons }],
      };
      const originalData = JSON.stringify(data);
      render(
        <SpatialWorkspace
          pack={data}
          locale={locale}
          copy={{
            ...copy,
            missingReasons: {
              'concentrations-not-published': concentrationLabel,
              'policy-not-observed-outcome': policyLabel,
            },
          }}
          selectedRecordId={sampleRecord.id}
        />,
      );
      const dossier = screen.getByRole('region', { name: copy.dossierTitle });
      expect(within(dossier).getByText(concentrationLabel)).toBeTruthy();
      expect(within(dossier).getByText(policyLabel)).toBeTruthy();
      for (const reason of reasons)
        expect(within(dossier).getByText(reason)).toBeTruthy();
      expect(
        screen.getByTestId('spatial-original-evidence').textContent,
      ).toContain('潮白河 7.8 mg/L');
      expect(screen.getByTestId('spatial-record-count').textContent).toContain(
        '1',
      );
      expect(
        screen.getByTestId('spatial-geometry-count').textContent,
      ).toContain('1');
      expect(JSON.stringify(data)).toBe(originalData);
    },
  );

  it('keeps the new record, filters and comparison when an earlier map camera callback arrives late', () => {
    const { rerender } = render(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        selectedRecordId={null}
      />,
    );
    const delayedCamera = mapProbe.camera!;
    rerender(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        selectedRecordId={sampleRecord.id}
      />,
    );
    fireEvent.click(screen.getByLabelText(zh.comparisonTitle));
    fireEvent.change(screen.getByLabelText(zh.recordSearch), {
      target: { value: '潮白河' },
    });
    act(() =>
      delayedCamera({
        longitude: 117,
        latitude: 40,
        zoom: 7,
        pitch: 50,
        bearing: 35,
      }),
    );
    expect(screen.getByTestId('spatial-original-evidence')).toBeTruthy();
    expect(screen.getAllByTestId('workspace-map')).toHaveLength(2);
    expect(screen.getByLabelText<HTMLInputElement>(zh.recordSearch).value).toBe(
      '潮白河',
    );
  });
  it('keeps a B-style shared selection when region and record arrive together under a fresh invalidations array', () => {
    const data = {
      ...pack,
      records: [
        { ...sampleRecord, regionIds: ['bth' as const, 'chaobai' as const] },
      ],
    };
    function SharedHost() {
      const [regionId, setRegionId] = useState<'bth' | 'chaobai' | 'bohai'>(
        'bohai',
      );
      const [selectedRecordId, setSelectedRecordId] = useState<string | null>(
        null,
      );
      const [tab, setTab] = useState('readiness');
      return (
        <>
          <button
            onClick={() => {
              setRegionId('chaobai');
              setSelectedRecordId(sampleRecord.id);
              setTab('spatial');
            }}
          >
            Inspect B record
          </button>
          <output data-testid="shared-region">{regionId}</output>
          <div hidden={tab !== 'spatial'}>
            <SpatialWorkspace
              pack={data}
              locale="zh-CN"
              copy={zh}
              regionId={regionId}
              selectedRecordId={selectedRecordId}
              onRegionChange={(id) =>
                setRegionId(id as 'bth' | 'chaobai' | 'bohai')
              }
              onSelectRecord={setSelectedRecordId}
              invalidations={[]}
            />
          </div>
        </>
      );
    }
    render(
      <StrictMode>
        <SharedHost />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect B record' }));
    expect(screen.getByTestId('spatial-original-evidence')).toBeTruthy();
    expect(screen.getByTestId('shared-region').textContent).toBe('chaobai');
    expect(
      screen
        .getByRole('button', { name: zh.regions.chaobai })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('preserves a repeated external record while its supported region changes', () => {
    const data = {
      ...pack,
      records: [
        { ...sampleRecord, regionIds: ['bth' as const, 'chaobai' as const] },
      ],
    };
    const { rerender } = render(
      <SpatialWorkspace
        pack={data}
        locale="zh-CN"
        copy={zh}
        regionId="bth"
        selectedRecordId={sampleRecord.id}
        invalidations={[]}
      />,
    );
    expect(screen.getByTestId('spatial-original-evidence')).toBeTruthy();
    rerender(
      <SpatialWorkspace
        pack={data}
        locale="zh-CN"
        copy={zh}
        regionId="chaobai"
        selectedRecordId={sampleRecord.id}
        invalidations={[]}
      />,
    );
    expect(screen.getByTestId('spatial-original-evidence')).toBeTruthy();
  });
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

  it('identifies affected dossier and comparison scopes while suppressing revoked details', () => {
    const { rerender } = render(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        selectedRecordId={sampleRecord.id}
      />,
    );
    fireEvent.click(screen.getByLabelText(zh.comparisonTitle));
    const stale = [
      {
        sourceId: 'report',
        state: 'stale' as const,
        reason: '规则更新，需要重新核对',
        affectedRecordIds: [sampleRecord.id],
      },
    ];
    rerender(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        selectedRecordId={sampleRecord.id}
        invalidations={stale}
      />,
    );
    expect(
      within(screen.getByRole('region', { name: zh.dossierTitle })).getByText(
        zh.stale,
      ),
    ).toBeTruthy();
    const right = screen.getByRole('region', { name: zh.rightWindow });
    expect(within(right).getByText('规则更新，需要重新核对')).toBeTruthy();
    expect(screen.queryByText('潮白河 7.8 mg/L')).toBeNull();
    rerender(
      <SpatialWorkspace
        pack={pack}
        locale="zh-CN"
        copy={zh}
        selectedRecordId={sampleRecord.id}
        invalidations={[
          {
            sourceId: 'report',
            state: 'revoked',
            reason: '不应公开的撤回详情',
          },
        ]}
      />,
    );
    expect(
      within(screen.getByRole('region', { name: zh.dossierTitle })).getByText(
        zh.revoked,
      ),
    ).toBeTruthy();
    expect(screen.queryByText('不应公开的撤回详情')).toBeNull();
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

describe('narrow spatial reading panes', () => {
  let narrow = true;
  let viewportChanged: (() => void) | undefined;
  beforeEach(() => {
    narrow = true;
    viewportChanged = undefined;
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        get matches() {
          return query === '(max-width: 800px)' && narrow;
        },
        media: query,
        addEventListener: vi.fn((_type: string, listener: () => void) => {
          viewportChanged = listener;
        }),
        removeEventListener: vi.fn(),
      })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['zh-CN', zh, ['地图', '结果', '证据']],
    ['en', en, ['Map', 'Results', 'Evidence']],
  ] as const)(
    'shows one reading pane with named keyboard navigation in %s',
    (locale, copy, names) => {
      render(<SpatialWorkspace pack={pack} locale={locale} copy={copy} />);
      const tabs = names.map((name) => screen.getByRole('tab', { name }));
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
      expect(tabs[0].getAttribute('aria-selected')).toBe('true');
      expect(
        screen.queryByRole('region', { name: copy.recordsTitle }),
      ).toBeNull();
      expect(
        screen.queryByRole('region', { name: copy.dossierTitle }),
      ).toBeNull();
      tabs[0].focus();
      fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
      expect(document.activeElement).toBe(tabs[1]);
      expect(tabs[1].getAttribute('aria-selected')).toBe('true');
      expect(
        screen.getByRole('region', { name: copy.unlocatedTitle }),
      ).toBeTruthy();
      fireEvent.keyDown(tabs[1], { key: 'End' });
      expect(document.activeElement).toBe(tabs[2]);
      expect(screen.getByRole('tabpanel').id).toBe(
        tabs[2].getAttribute('aria-controls'),
      );
      expect(
        screen.getByRole('region', { name: copy.dossierTitle }).textContent,
      ).toContain(copy.selectRecord);
      fireEvent.keyDown(tabs[2], { key: 'Home' });
      expect(document.activeElement).toBe(tabs[0]);
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    },
  );

  it('keeps the exact location, camera and mounted map through result, evidence and map switches', () => {
    render(<SpatialWorkspace pack={pack} locale="zh-CN" copy={zh} />);
    const map = screen.getByTestId('workspace-map');
    fireEvent.click(within(map).getByRole('button', { name: 'Move map' }));
    fireEvent.click(screen.getByRole('tab', { name: '结果' }));
    fireEvent.click(screen.getByRole('button', { name: /潮白河原文对象/ }));
    expect(
      screen.getByRole('tab', { name: '证据' }).getAttribute('aria-selected'),
    ).toBe('true');
    const evidence = screen.getByRole('tabpanel');
    expect(document.activeElement).toBe(evidence);
    expect(
      within(evidence).getByTestId('spatial-original-evidence').textContent,
    ).toContain('潮白河 7.8 mg/L');
    fireEvent.click(
      within(evidence).getByRole('button', { name: zh.locatePosition }),
    );
    expect(
      screen.getByRole('tab', { name: '地图' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByTestId('workspace-map')).toBe(map);
    expect(map.getAttribute('data-bearing')).toBe('35');
    expect(JSON.parse(map.getAttribute('data-selection')!)).toEqual({
      recordId: 'record-1',
      positionId: 'pos-line',
    });
    for (const name of ['证据', '结果', '地图'])
      fireEvent.click(screen.getByRole('tab', { name }));
    expect(screen.getByTestId('workspace-map')).toBe(map);
    expect(mapProbe.mounts).toBe(1);
    expect(mapProbe.unmounts).toBe(0);
  });

  it('retains unknown-position results and a selected record when moving between narrow and desktop layouts', () => {
    render(<SpatialWorkspace pack={pack} locale="zh-CN" copy={zh} />);
    fireEvent.click(screen.getByRole('tab', { name: '结果' }));
    fireEvent.click(screen.getByRole('button', { name: /未定位对象/ }));
    expect(
      screen.getByRole('region', { name: zh.dossierTitle }).textContent,
    ).toContain('未定位对象');
    const map = screen.getByTestId('workspace-map');
    act(() => {
      narrow = false;
      viewportChanged?.();
    });
    expect(screen.queryByRole('tab', { name: '地图' })).toBeNull();
    expect(screen.getByRole('region', { name: zh.recordsTitle })).toBeTruthy();
    expect(
      screen.getByRole('region', { name: zh.unlocatedTitle }),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', { name: zh.dossierTitle }).textContent,
    ).toContain('未定位对象');
    act(() => {
      narrow = true;
      viewportChanged?.();
    });
    expect(
      screen.getByRole('tab', { name: '证据' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByTestId('workspace-map')).toBe(map);
    expect(mapProbe.mounts).toBe(1);
  });

  it('does not let a hidden map callback reset the active pane, filters or selected evidence', () => {
    render(<SpatialWorkspace pack={pack} locale="zh-CN" copy={zh} />);
    const delayedCamera = mapProbe.camera!;
    fireEvent.click(screen.getByRole('tab', { name: '结果' }));
    fireEvent.click(screen.getByRole('button', { name: /潮白河原文对象/ }));
    fireEvent.change(screen.getByLabelText(zh.recordSearch), {
      target: { value: '潮白河' },
    });
    act(() =>
      delayedCamera({
        longitude: 117,
        latitude: 40,
        zoom: 7,
        pitch: 50,
        bearing: 35,
      }),
    );
    expect(
      screen.getByRole('tab', { name: '证据' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByTestId('spatial-original-evidence').textContent,
    ).toContain('潮白河 7.8 mg/L');
    expect(screen.getByLabelText<HTMLInputElement>(zh.recordSearch).value).toBe(
      '潮白河',
    );
    expect(
      screen.getByTestId('workspace-map').getAttribute('data-bearing'),
    ).toBe('35');
  });

  it('removes withdrawn evidence from every mounted pane before it can be reopened', () => {
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
    fireEvent.click(screen.getByRole('tab', { name: '地图' }));
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
    expect(
      screen.queryByRole('link', { name: zh.openOriginal, hidden: true }),
    ).toBeNull();
    for (const name of ['结果', '证据', '地图']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(screen.queryByText('潮白河 7.8 mg/L')).toBeNull();
    }
    expect(onSelectRecord).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId('spatial-record-count').textContent).toContain(
      '0',
    );
  });
});
