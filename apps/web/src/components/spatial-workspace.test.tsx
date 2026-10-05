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
import {
  captureSpatialWorkspaceView,
  createSpatialWorkspaceView,
  workspaceRegionCamera,
  type WorkspaceCamera,
} from '@/lib/spatial-workspace-view';
import { defaultWorkspaceReadingState } from '@/lib/spatial-workspace-reading-view';
import { StrictMode, useEffect, useState } from 'react';
import { SpatialWorkspace } from './spatial-workspace';
import { SpatialWorkspaceComparison } from './spatial-workspace-comparison';

const mapProbe = vi.hoisted(() => ({
  camera: null as ((value: unknown) => void) | null,
  mounts: 0,
  unmounts: 0,
  frames: [] as { onCamera: (value: unknown) => void }[],
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
    mapProbe.frames.push({ onCamera: props.onCamera });
    return (
      <div
        data-testid="workspace-map"
        data-camera={JSON.stringify(props.camera)}
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
  mapProbe.frames = [];
});
afterEach(cleanup);

describe('camera proposal region ownership', () => {
  const proposal: WorkspaceCamera = {
    longitude: 117.2,
    latitude: 40.3,
    zoom: 7.4,
    pitch: 50,
    bearing: 35,
  };
  const cameras = () =>
    screen
      .getAllByTestId('workspace-map')
      .map((map) => JSON.parse(map.getAttribute('data-camera')!) as unknown);

  it.each(['reading state', 'legacy region'] as const)(
    'rejects a previous region camera after a %s replacement without emitting a reading change',
    (navigation) => {
      const onReadingStateChange = vi.fn();
      const state = defaultWorkspaceReadingState();
      const props = { pack, locale: 'zh-CN' as const, copy: zh };
      const { rerender } = render(
        <SpatialWorkspace
          {...props}
          {...(navigation === 'reading state'
            ? { readingState: state, onReadingStateChange }
            : { regionId: 'bth' as const })}
        />,
      );
      const delayed = mapProbe.frames.at(-1)!.onCamera;
      rerender(
        <SpatialWorkspace
          {...props}
          {...(navigation === 'reading state'
            ? {
                readingState: { ...state, regionId: 'chaobai' as const },
                onReadingStateChange,
              }
            : { regionId: 'chaobai' as const })}
        />,
      );
      const restored = workspaceRegionCamera(pack, 'chaobai');
      expect(cameras()).toEqual([restored]);
      onReadingStateChange.mockClear();
      act(() => delayed(proposal));
      expect(cameras()).toEqual([restored]);
      expect(onReadingStateChange).not.toHaveBeenCalled();
    },
  );

  it.each(['month', 'evidence'] as const)(
    'accepts an earlier same-region camera after a %s reading change',
    (change) => {
      const state = defaultWorkspaceReadingState();
      const onReadingStateChange = vi.fn();
      const props = { pack, locale: 'zh-CN' as const, copy: zh };
      const { rerender } = render(
        <SpatialWorkspace
          {...props}
          readingState={state}
          onReadingStateChange={onReadingStateChange}
        />,
      );
      const delayed = mapProbe.frames.at(-1)!.onCamera;
      const changed =
        change === 'month'
          ? {
              ...state,
              dateRole: 'OBSERVATION' as const,
              monthWindow: { start: '2023-12', end: '2023-12' },
            }
          : {
              ...state,
              pane: 'evidence' as const,
              source: {
                sourceId: 'report',
                versionId: 'v1',
                sha256: 'a'.repeat(64),
                processingVersion: 'parse1',
              },
              selection: {
                recordId: sampleRecord.id,
                processingVersion: 'parse1',
                position: null,
              },
            };
      rerender(
        <SpatialWorkspace
          {...props}
          readingState={changed}
          onReadingStateChange={onReadingStateChange}
        />,
      );
      onReadingStateChange.mockClear();
      act(() => delayed(proposal));
      expect(cameras()).toEqual([proposal]);
      expect(onReadingStateChange).not.toHaveBeenCalled();
      if (change === 'month') {
        expect(
          screen.getByTestId('workspace-current-period').textContent,
        ).toContain('2023-12');
      } else {
        expect(
          screen.getByTestId('spatial-original-evidence').textContent,
        ).toContain('潮白河 7.8 mg/L');
      }
    },
  );

  it('accepts the camera rendered by the new region', () => {
    const state = defaultWorkspaceReadingState();
    const props = { pack, locale: 'zh-CN' as const, copy: zh };
    const { rerender } = render(
      <SpatialWorkspace {...props} readingState={state} />,
    );
    rerender(
      <SpatialWorkspace
        {...props}
        readingState={{ ...state, regionId: 'chaobai' }}
      />,
    );
    const fresh = mapProbe.frames.at(-1)!.onCamera;
    act(() => fresh(proposal));
    expect(cameras()).toEqual([proposal]);
  });

  function ComparisonHost({ regionId }: { regionId: 'bth' | 'chaobai' }) {
    const [view, setView] = useState(() =>
      createSpatialWorkspaceView(pack, regionId),
    );
    useEffect(() => {
      setView((previous) => ({
        ...createSpatialWorkspaceView(pack, regionId),
        comparison: previous.comparison,
      }));
    }, [regionId]);
    return (
      <SpatialWorkspaceComparison
        pack={pack}
        view={view}
        copy={zh}
        onChange={setView}
        onSelect={() => {}}
      />
    );
  }

  it.each([0, 1])(
    'rejects comparison window %s camera from the previous shared region',
    (side) => {
      const { rerender } = render(<ComparisonHost regionId="bth" />);
      const delayed = mapProbe.frames.slice(-2)[side].onCamera;
      rerender(<ComparisonHost regionId="chaobai" />);
      const restored = workspaceRegionCamera(pack, 'chaobai');
      expect(cameras()).toEqual([restored, restored]);
      act(() => delayed(proposal));
      expect(cameras()).toEqual([restored, restored]);
    },
  );

  it.each([0, 1])(
    'keeps window %s camera shared after a comparison scope and month change',
    (side) => {
      render(<ComparisonHost regionId="bth" />);
      const delayed = mapProbe.frames.slice(-2)[side].onCamera;
      fireEvent.change(screen.getAllByLabelText(zh.region)[0], {
        target: { value: 'chaobai' },
      });
      fireEvent.change(screen.getAllByLabelText(zh.from)[0], {
        target: { value: '2023-12-01' },
      });
      act(() => delayed(proposal));
      expect(cameras()).toEqual([proposal, proposal]);
      expect(
        screen.getAllByLabelText<HTMLSelectElement>(zh.region)[0].value,
      ).toBe('chaobai');
      expect(screen.getAllByLabelText<HTMLInputElement>(zh.from)[0].value).toBe(
        '2023-12-01',
      );
    },
  );

  it('accepts both comparison cameras rendered by the new shared region', () => {
    const { rerender } = render(<ComparisonHost regionId="bth" />);
    rerender(<ComparisonHost regionId="chaobai" />);
    const fresh = mapProbe.frames.slice(-2).map((frame) => frame.onCamera);
    for (const [side, onCamera] of fresh.entries()) {
      const next = { ...proposal, bearing: proposal.bearing + side };
      act(() => onCamera(next));
      expect(cameras()).toEqual([next, next]);
    }
  });
});

describe('spatial result table reading', () => {
  const manyRecords = (located: boolean, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...sampleRecord,
      id: `${located ? 'located' : 'unlocated'}-${index}`,
      objectId: `object-${index}`,
      objectLabel: `${located ? '已定位' : '未定位'}资料 ${index + 1}`,
      positions: located ? sampleRecord.positions : [],
    }));
  const locales = [
    ['zh-CN', zh, '下一页', '上一页'],
    ['en', en, 'Next page', 'Previous page'],
  ] as const;

  it.each(locales)(
    'distinguishes same-name fixed sources and preserves original ranges, roles, zero and missing values in %s',
    (locale, copy) => {
      const source = { ...pack.sources[0], versionId: 'v2', title: '修订报告' };
      const records: WorkspaceRecord[] = [
        {
          ...sampleRecord,
          value: '0',
          time: {
            start: '2023',
            end: '2024',
            precision: 'year',
            role: 'publication',
          },
        },
        {
          ...sampleRecord,
          id: 'same-name-revision',
          versionId: 'v2',
          value: null,
          unit: null,
          positions: sampleRecord.positions.map((position) => ({
            ...position,
            geometryVersionId: 'v2',
          })),
        },
      ];
      const data = { ...pack, sources: [...pack.sources, source], records };
      const original = JSON.stringify(data);
      render(
        <SpatialWorkspace
          pack={data}
          locale={locale}
          copy={copy}
          sourceHref={(id, versionId) =>
            `/source?source=${id}&version=${versionId}`
          }
        />,
      );
      const table = screen.getByRole('table', { name: copy.recordsTitle });
      const rows = within(table).getAllByRole('row').slice(1);
      expect(rows).toHaveLength(2);
      for (const fact of [
        '2023',
        '2024',
        copy.timePrecisions.year,
        copy.timeRoles.publication,
        '0',
        'mg/L',
        '固定版本公开报告',
        '公开机构',
        copy.pending,
        copy.positionRoles.reference,
        '潮白河参考线',
      ])
        expect(rows[0].textContent).toContain(fact);
      expect(rows[1].textContent).toContain('修订报告');
      expect(
        within(rows[1]).getAllByText(copy.unknown).length,
      ).toBeGreaterThanOrEqual(2);
      fireEvent.click(
        within(rows[1]).getByRole('button', {
          name: sampleRecord.objectLabel,
        }),
      );
      const dossier = screen.getByRole('region', { name: copy.dossierTitle });
      expect(
        within(dossier)
          .getByRole('link', { name: copy.openOriginal })
          .getAttribute('href'),
      ).toBe('/source?source=report&version=v2');
      expect(JSON.stringify(data)).toBe(original);
    },
  );

  it.each(locales)(
    'bounds each result table independently and selects an exact later-page record without resetting the map in %s',
    (locale, copy, nextLabel, previousLabel) => {
      const onSelectRecord = vi.fn();
      render(
        <SpatialWorkspace
          pack={{
            ...pack,
            records: [...manyRecords(true, 81), ...manyRecords(false, 82)],
          }}
          locale={locale}
          copy={copy}
          onSelectRecord={onSelectRecord}
        />,
      );
      const located = screen.getByRole('region', { name: copy.recordsTitle });
      const unresolved = screen.getByRole('region', {
        name: copy.unlocatedTitle,
      });
      const map = screen.getByTestId('workspace-map');
      fireEvent.click(within(map).getByRole('button', { name: 'Move map' }));
      for (const region of [located, unresolved])
        expect(within(region).getAllByRole('row')).toHaveLength(41);
      expect(
        within(unresolved)
          .getByRole('button', { name: previousLabel })
          .getAttribute('disabled'),
      ).not.toBeNull();
      fireEvent.click(
        within(unresolved).getByRole('button', { name: nextLabel }),
      );
      expect(
        within(unresolved).queryByRole('button', {
          name: '未定位资料 1',
        }),
      ).toBeNull();
      expect(
        within(located).getByRole('button', {
          name: '已定位资料 1',
        }),
      ).toBeTruthy();
      fireEvent.click(
        within(unresolved).getByRole('button', {
          name: '未定位资料 41',
        }),
      );
      expect(onSelectRecord).toHaveBeenLastCalledWith('unlocated-40');
      expect(map.getAttribute('data-bearing')).toBe('35');
      expect(mapProbe.mounts).toBe(1);
      expect(
        within(unresolved)
          .getByRole('button', { name: '未定位资料 41' })
          .getAttribute('aria-pressed'),
      ).toBe('true');
      fireEvent.click(
        within(unresolved).getByRole('button', { name: nextLabel }),
      );
      expect(within(unresolved).getAllByRole('row')).toHaveLength(3);
      expect(
        within(unresolved)
          .getByRole('button', { name: nextLabel })
          .getAttribute('disabled'),
      ).not.toBeNull();
      fireEvent.click(
        within(unresolved).getByRole('button', { name: previousLabel }),
      );
      expect(
        within(unresolved)
          .getByRole('button', { name: '未定位资料 41' })
          .getAttribute('aria-pressed'),
      ).toBe('true');
    },
  );

  it('resets the page for a new filter while removing a withdrawn source from mounted results and later pages', () => {
    const data = { ...pack, records: manyRecords(false, 85) };
    const props = { pack: data, locale: 'zh-CN' as const, copy: zh };
    const { rerender } = render(<SpatialWorkspace {...props} />);
    const unresolved = screen.getByRole('region', { name: zh.unlocatedTitle });
    const table = within(unresolved).getByRole('table', {
      name: zh.unlocatedTitle,
    });
    fireEvent.click(within(unresolved).getByRole('button', { name: '下一页' }));
    fireEvent.change(screen.getByLabelText(zh.recordSearch), {
      target: { value: '未定位资料 1' },
    });
    expect(
      within(table).getByRole('button', { name: '未定位资料 1' }),
    ).toBeTruthy();
    expect(
      within(unresolved)
        .getByRole('button', { name: '上一页' })
        .getAttribute('disabled'),
    ).not.toBeNull();
    fireEvent.change(screen.getByLabelText(zh.recordSearch), {
      target: { value: '' },
    });
    fireEvent.click(within(unresolved).getByRole('button', { name: '下一页' }));
    fireEvent.click(
      within(unresolved).getByRole('button', {
        name: '未定位资料 41',
      }),
    );
    rerender(
      <SpatialWorkspace
        {...props}
        invalidations={[{ sourceId: 'report', state: 'revoked' }]}
      />,
    );
    expect(
      screen.queryByRole('table', { name: zh.unlocatedTitle, hidden: true }),
    ).toBeNull();
    expect(screen.queryByText('未定位资料 41')).toBeNull();
    expect(screen.queryByText('固定版本公开报告')).toBeNull();
    expect(screen.getByTestId('spatial-record-count').textContent).toContain(
      '0',
    );
  });

  it('preserves the rectangle recovery action with the exact outside record', () => {
    render(
      <SpatialWorkspace
        pack={{ ...pack, records: [sampleRecord] }}
        locale="zh-CN"
        copy={zh}
      />,
    );
    fireEvent.change(screen.getByLabelText(zh.bbox), {
      target: { value: '113,36,114,37' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.applyBounds }));
    const summary = screen.getByText(`${zh.outsideBounds} · 1`);
    const outside = summary.closest('details')!;
    fireEvent.click(summary);
    expect(
      within(outside).getByRole('table', { name: zh.outsideBounds }),
    ).toBeTruthy();
    fireEvent.click(
      within(outside).getByRole('button', {
        name: sampleRecord.objectLabel,
      }),
    );
    expect(screen.getByTestId('spatial-record-count').textContent).toContain(
      '1',
    );
    expect(
      JSON.parse(
        screen.getByTestId('workspace-map').getAttribute('data-selection')!,
      ),
    ).toEqual({ recordId: sampleRecord.id, positionId: 'pos-line' });
    expect(
      within(screen.getByRole('region', { name: zh.dossierTitle })).getByText(
        '潮白河 7.8 mg/L',
      ),
    ).toBeTruthy();
  });
});

describe('business-first evidence reading', () => {
  const version = 'f'.repeat(64);
  const digest = 'a'.repeat(64);
  const processing = 'monthly-parser:fixed-original:reference-geometry:v101';
  const record = {
    ...sampleRecord,
    id: 'source-row-101',
    versionId: version,
    processingVersion: processing,
    missingReasons: ['concentrations-not-published'],
    positions: sampleRecord.positions.map((position) => ({
      ...position,
      geometryVersionId: version,
    })),
  };
  const data = {
    ...pack,
    sources: [{ ...pack.sources[0], versionId: version }],
    records: [record],
  };
  const locales = [
    ['zh-CN', zh, '技术详情', '定位技术详情', '对象身份说明'],
    [
      'en',
      en,
      'Technical details',
      'Location technical details',
      'Object identity information',
    ],
  ] as const;

  it.each(locales)(
    'keeps business facts and original access visible while technical references start collapsed in %s',
    (locale, copy, technicalLabel) => {
      const frozen = JSON.stringify(data);
      render(
        <SpatialWorkspace
          pack={data}
          locale={locale}
          copy={copy}
          selectedRecordId={record.id}
          sourceHref={(id, versionId) =>
            `/source?source=${id}&version=${versionId}`
          }
        />,
      );
      const dossier = screen.getByRole('region', { name: copy.dossierTitle });
      expect(
        within(dossier)
          .getAllByText(version, { exact: true })
          .every((element) => element.closest('details')?.open === false),
      ).toBe(true);
      expect(
        screen.getByRole('button', { name: /潮白河原文对象/ }).textContent,
      ).not.toContain(version);
      for (const fact of [
        copy.pending,
        '公开机构',
        '溶解氧',
        '7.8',
        'mg/L',
        '原件许可',
      ])
        expect(
          within(dossier)
            .getByText(fact, { exact: true })
            .closest('details:not([open])'),
        ).toBeNull();
      const href = `/source?source=report&version=${version}`;
      expect(
        within(dossier)
          .getByRole('link', { name: copy.openOriginal })
          .getAttribute('href'),
      ).toBe(href);
      const summary = within(dossier).getByText(technicalLabel, {
        exact: true,
      });
      fireEvent.click(summary);
      const details = summary.closest('details')!;
      for (const identifier of [version, digest, record.id, processing])
        expect(
          within(details)
            .getByText(identifier, { exact: true })
            .closest('details')?.open,
        ).toBe(true);
      expect(dossier.textContent).not.toContain('/private/original');
      expect(
        within(dossier)
          .getByRole('link', { name: copy.openOriginal })
          .getAttribute('href'),
      ).toBe(href);
      expect(JSON.stringify(data)).toBe(frozen);
    },
  );

  it.each(locales)(
    'retains visible position limits and localized missing facts while codes and geometry provenance are disclosed on demand in %s',
    (locale, copy, technicalLabel, locationLabel, identityLabel) => {
      render(
        <SpatialWorkspace
          pack={data}
          locale={locale}
          copy={copy}
          selectedRecordId={record.id}
        />,
      );
      const dossier = screen.getByRole('region', { name: copy.dossierTitle });
      expect(
        within(dossier)
          .getByText(copy.missingReasons['concentrations-not-published'])
          .closest('details:not([open])'),
      ).toBeNull();
      expect(
        within(dossier)
          .getByText('concentrations-not-published', {
            exact: true,
          })
          .closest('details')?.open,
      ).toBe(false);
      for (const fact of [
        copy.positionRoles.reference,
        '参考线，位置待核',
        copy.referenceLocation,
      ])
        expect(
          within(dossier)
            .getByText(fact, { exact: true })
            .closest('details:not([open])'),
        ).toBeNull();
      const position = dossier.querySelector<HTMLElement>(
        '[data-position-id="pos-line"]',
      )!;
      const location = within(position)
        .getByText(locationLabel)
        .closest('details')!;
      expect(location.open).toBe(false);
      fireEvent.click(within(location).getByText(locationLabel));
      expect(
        within(location).getByText(version, { exact: true }).closest('details')
          ?.open,
      ).toBe(true);
      expect(
        within(location)
          .getAllByText('EPSG:4326')
          .every((element) => element.textContent === 'EPSG:4326'),
      ).toBe(true);
      fireEvent.click(
        within(dossier).getByText(technicalLabel, { exact: true }),
      );
      expect(
        within(dossier)
          .getByText('concentrations-not-published', {
            exact: true,
          })
          .closest('details')?.open,
      ).toBe(true);
      expect(
        within(dossier)
          .getByText(copy.sourceDistinct)
          .closest('[role="note"]')
          ?.hasAttribute('hidden'),
      ).toBe(true);
      const help = within(dossier).getByRole('button', { name: identityLabel });
      fireEvent.click(help);
      expect(
        within(dossier)
          .getByText(copy.sourceDistinct)
          .closest('[role="note"]')
          ?.hasAttribute('hidden'),
      ).toBe(false);
      fireEvent.keyDown(help, { key: 'Escape' });
      expect(
        within(dossier)
          .getByText(copy.sourceDistinct)
          .closest('[role="note"]')
          ?.hasAttribute('hidden'),
      ).toBe(true);
    },
  );

  it.each(locales)(
    'removes opened original and geometry technical evidence immediately on withdrawal in %s',
    (locale, copy, technicalLabel, locationLabel) => {
      const props = { pack: data, locale, copy, selectedRecordId: record.id };
      const { rerender } = render(<SpatialWorkspace {...props} />);
      const dossier = screen.getByRole('region', { name: copy.dossierTitle });
      fireEvent.click(
        within(dossier).getByText(technicalLabel, { exact: true }),
      );
      fireEvent.click(
        within(dossier).getByText(locationLabel, { exact: true }),
      );
      expect(
        within(dossier).getAllByText(version, { exact: true }),
      ).toHaveLength(2);
      rerender(
        <SpatialWorkspace
          {...props}
          invalidations={[{ sourceId: 'report', state: 'revoked' }]}
        />,
      );
      for (const identifier of [version, digest, record.id, processing])
        expect(
          within(dossier).queryByText(identifier, { exact: true }),
        ).toBeNull();
      expect(
        within(dossier).queryByText(technicalLabel, { exact: true }),
      ).toBeNull();
      expect(
        within(dossier).queryByRole('link', { name: copy.openOriginal }),
      ).toBeNull();
    },
  );
});

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
          return query === '(max-width: 1100px), (max-height: 500px)' && narrow;
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

  it('covers the stacked-layout breakpoint and phone landscape rather than only 800px', () => {
    render(<SpatialWorkspace pack={pack} locale="zh-CN" copy={zh} />);
    expect(window.matchMedia).toHaveBeenCalledWith(
      '(max-width: 1100px), (max-height: 500px)',
    );
  });

  it('preserves the selected second position when reopening the same result', () => {
    const second = {
      ...sampleRecord.positions[0],
      id: 'pos-second',
      expression: '另一处原文参考线',
    };
    const multiple = {
      ...pack,
      records: [
        { ...sampleRecord, positions: [...sampleRecord.positions, second] },
      ],
    };
    render(
      <SpatialWorkspace
        pack={multiple}
        locale="zh-CN"
        copy={zh}
        selectedRecordId={sampleRecord.id}
      />,
    );
    fireEvent.click(
      screen.getAllByRole('button', { name: zh.locatePosition })[1],
    );
    const map = screen.getByTestId('workspace-map');
    expect(JSON.parse(map.getAttribute('data-selection')!)).toEqual({
      recordId: sampleRecord.id,
      positionId: second.id,
    });
    fireEvent.click(screen.getByRole('tab', { name: '结果' }));
    fireEvent.click(screen.getByRole('button', { name: /潮白河原文对象/ }));
    expect(JSON.parse(map.getAttribute('data-selection')!)).toEqual({
      recordId: sampleRecord.id,
      positionId: second.id,
    });
    expect(
      screen
        .getAllByRole('button', { name: zh.locatePosition })[1]
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('chooses a default position only from the fixed geometry versions in a restored scene', () => {
    const versions = ['v1', 'v2'].map((versionId) => ({
      ...pack.sources[0],
      id: 'geometry',
      versionId,
    }));
    const multiple = {
      ...pack,
      sources: [...pack.sources, ...versions],
      records: [
        {
          ...sampleRecord,
          positions: versions.map((source, index) => ({
            ...sampleRecord.positions[0],
            id: `pos-${index}`,
            geometrySourceId: source.id,
            geometryVersionId: source.versionId,
          })),
        },
      ],
    };
    const saved = captureSpatialWorkspaceView(
      multiple,
      createSpatialWorkspaceView(multiple, 'chaobai'),
    );
    saved.sourcePins = saved.sourcePins!.filter(
      (pin) => pin.sourceId !== 'geometry' || pin.versionId === 'v2',
    );
    localStorage.setItem(
      'wiser-spatial-workspace-goal100-v1',
      JSON.stringify([
        {
          id: 'pinned',
          name: 'Fixed geometry version',
          createdAt: '2026-10-03',
          view: saved,
        },
      ]),
    );
    render(<SpatialWorkspace pack={multiple} locale="zh-CN" copy={zh} />);
    fireEvent.click(screen.getByRole('button', { name: zh.restoreView }));
    fireEvent.click(screen.getByRole('tab', { name: '结果' }));
    fireEvent.click(screen.getByRole('button', { name: /潮白河原文对象/ }));
    expect(
      JSON.parse(
        screen.getByTestId('workspace-map').getAttribute('data-selection')!,
      ),
    ).toEqual({ recordId: sampleRecord.id, positionId: 'pos-1' });
  });

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

  it.each([
    ['地图', 'Move map'],
    ['结果', /潮白河原文对象/],
  ] as const)(
    'keeps the focused %s control visible when a desktop layout becomes narrow',
    (pane, control) => {
      narrow = false;
      render(
        <SpatialWorkspace
          pack={pack}
          locale="zh-CN"
          copy={zh}
          selectedRecordId={sampleRecord.id}
        />,
      );
      const focused = screen.getByRole('button', { name: control });
      focused.focus();
      act(() => {
        narrow = true;
        viewportChanged?.();
      });
      expect(
        screen.getByRole('tab', { name: pane }).getAttribute('aria-selected'),
      ).toBe('true');
      expect(screen.getByRole('tabpanel').contains(focused)).toBe(true);
      expect(document.activeElement).toBe(focused);
    },
  );

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

describe('first-screen effective scope', () => {
  it.each([
    ['zh-CN', zh, '当前筛选条件', '检索：潮白', '排除时间未知', '资料图层：'],
    [
      'en',
      en,
      'Active filters',
      'Search: 潮白',
      'Unknown time excluded',
      'Material layers:',
    ],
  ] as const)(
    'keeps applied search, layers, undated exclusion and rectangle readable with filters closed in %s',
    (locale, copy, summaryLabel, searchLabel, undatedLabel, layerLabel) => {
      render(<SpatialWorkspace pack={pack} locale={locale} copy={copy} />);
      const disclosure = screen.getByText(copy.filters).closest('details');
      if (!disclosure) throw new Error('Missing filter disclosure');
      disclosure.open = true;
      fireEvent.change(screen.getByLabelText(copy.recordSearch), {
        target: { value: '  潮白  ' },
      });
      fireEvent.click(screen.getByLabelText(copy.includeUndated));
      fireEvent.click(screen.getByLabelText(copy.kinds.policy));
      fireEvent.change(screen.getByLabelText(copy.bbox), {
        target: { value: '116,39,117,40' },
      });
      expect(
        screen.queryByRole('group', { name: summaryLabel })?.textContent ?? '',
      ).not.toContain('116, 39, 117, 40');
      fireEvent.click(screen.getByRole('button', { name: copy.applyBounds }));
      disclosure.open = false;
      const summary = screen.getByRole('group', { name: summaryLabel });
      expect(summary.closest('details')).toBeNull();
      for (const label of [
        searchLabel,
        undatedLabel,
        layerLabel,
        copy.bbox,
        '116, 39, 117, 40',
      ])
        expect(summary.textContent).toContain(label);
      expect(summary.textContent).not.toContain(copy.kinds.policy);
      expect(screen.getByTestId('spatial-record-count').textContent).toContain(
        '1',
      );
      disclosure.open = true;
      const layerChecks = within(disclosure).getByRole('group', {
        name: copy.layers,
      });
      for (const checkbox of within(layerChecks).getAllByRole('checkbox')) {
        if (checkbox instanceof HTMLInputElement && checkbox.checked)
          fireEvent.click(checkbox);
      }
      disclosure.open = false;
      expect(summary.textContent).toContain(
        locale === 'zh-CN' ? '未选择资料图层' : 'No material layers selected',
      );
      expect(screen.getByTestId('spatial-record-count').textContent).toContain(
        '0',
      );
      fireEvent.change(screen.getByLabelText(copy.recordSearch), {
        target: { value: '   ' },
      });
      expect(summary.textContent).not.toContain(searchLabel);
      disclosure.open = true;
      fireEvent.click(screen.getByRole('button', { name: copy.clearFilters }));
      disclosure.open = false;
      expect(screen.queryByRole('group', { name: summaryLabel })).toBeNull();
      expect(screen.getByTestId('spatial-record-count').textContent).toContain(
        '2',
      );
    },
  );

  it.each([
    ['zh-CN', zh, '月份窗口', '日期窗口'],
    ['en', en, 'Month window', 'Date window'],
  ] as const)(
    'distinguishes existing month and exact day reading windows with identical filter boundaries in %s',
    (locale, copy, monthLabel, dayLabel) => {
      const monthlyRecord = {
        ...sampleRecord,
        time: {
          start: '2023-04',
          end: '2023-04',
          precision: 'month' as const,
          role: 'observation' as const,
        },
      };
      const data = { ...pack, records: [monthlyRecord] };
      const common = {
        regionId: 'bth' as const,
        needId: null,
        dateRole: 'OBSERVATION' as const,
        tab: 'spatial' as const,
        pane: 'map' as const,
        source: null,
        selection: null,
      };
      const { rerender } = render(
        <SpatialWorkspace
          pack={data}
          locale={locale}
          copy={copy}
          readingState={{
            ...common,
            monthWindow: { start: '2023-04', end: '2023-04' },
          }}
        />,
      );
      expect(
        screen.getByTestId('workspace-current-period').textContent,
      ).toContain(monthLabel);
      expect(
        screen.getByTestId('workspace-current-period').textContent,
      ).toContain('2023-04 — 2023-04');
      expect(screen.getByTestId('spatial-record-count').textContent).toContain(
        '1',
      );
      expect(screen.getByLabelText<HTMLInputElement>(copy.from).value).toBe(
        '2023-04-01',
      );
      expect(screen.getByLabelText<HTMLInputElement>(copy.to).value).toBe(
        '2023-04-30',
      );
      fireEvent.change(screen.getByLabelText(copy.from), {
        target: { value: '2023-04-02' },
      });
      expect(
        screen.getByTestId('workspace-current-period').textContent,
      ).toContain(dayLabel);
      expect(
        screen.getByTestId('workspace-current-period').textContent,
      ).not.toContain(monthLabel);
      rerender(
        <SpatialWorkspace
          pack={data}
          locale={locale}
          copy={copy}
          readingState={{
            ...common,
            monthWindow: null,
            dayWindow: { start: '2023-04-01', end: '2023-04-30' },
          }}
        />,
      );
      expect(
        screen.getByTestId('workspace-current-period').textContent,
      ).toContain(dayLabel);
      expect(
        screen.getByTestId('workspace-current-period').textContent,
      ).toContain('2023-04-01 — 2023-04-30');
      expect(
        screen.getByTestId('workspace-current-period').textContent,
      ).not.toContain(monthLabel);
      expect(screen.getByTestId('spatial-record-count').textContent).toContain(
        '1',
      );
      expect(data.records[0].time.precision).toBe('month');
    },
  );
});
