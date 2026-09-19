// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BusinessSceneCanvas } from './business-scene-canvas';
import { defaultSceneView } from '@/lib/business-scene-view';
import type { BusinessScene } from '@/lib/business-scene';
import type { RelationAssertion } from '@wiser/data-contracts';
vi.mock('next/dynamic', () => ({ default: () => () => null }));
class Resize {
  observe() {}
  disconnect() {}
}
const node = (id: string) => ({
  id,
  label: id,
  kind: 'PLACE' as const,
  group: 'PLACE',
  classificationBasis: null,
  record: null,
  periods: [],
});
const row = (a: string, b: string) =>
  ({
    candidate: {
      subject: { label: a },
      object: { label: b },
      predicate: 'ABOUT_ENTITY',
    },
  }) as RelationAssertion;
const scene: BusinessScene = {
  nodes: ['a', 'b', 'c', 'x'].map(node),
  edges: [
    { id: 'ab', from: 'a', to: 'b', row: row('a', 'b') },
    { id: 'bc', from: 'b', to: 'c', row: row('b', 'c') },
  ],
};
const props = {
  scene,
  settings: defaultSceneView,
  onSettings: vi.fn(),
  selectedId: null,
  selectedEdge: null,
  onSelect: vi.fn(),
  onEdge: vi.fn(),
  locale: 'zh-CN' as const,
  queryId: 'query',
  onInvalidated: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('keeps every relation visible while focusing one edge, and the evidence list selects the exact assertion', () => {
  vi.stubGlobal('ResizeObserver', Resize);
  const view = render(
    <BusinessSceneCanvas
      {...props}
      selectedEdge="ab"
      evidence={<p>原表第3行第6列</p>}
    />,
  );
  const root = screen.getByTestId('business-scene');
  expect(root.querySelectorAll('[data-edge-id]')).toHaveLength(2);
  expect(
    root.querySelector('[data-edge-id="ab"]')?.getAttribute('data-highlighted'),
  ).toBe('true');
  expect(
    root.querySelector('[data-edge-id="bc"]')?.getAttribute('data-highlighted'),
  ).toBe('false');
  expect(screen.getByText('原表第3行第6列')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'a → 涉及对象 → b' }));
  expect(props.onEdge).toHaveBeenCalledWith('ab');
  view.rerender(<BusinessSceneCanvas {...props} selectedId="b" />);
  expect(
    root.querySelectorAll('[data-edge-id][data-highlighted="true"]'),
  ).toHaveLength(2);
  expect(root.querySelectorAll('[data-node-id]')).toHaveLength(4);
});
it('zooms at the cursor without changing layout coordinates and restores the preceding viewport', async () => {
  vi.stubGlobal('ResizeObserver', Resize);
  render(<BusinessSceneCanvas {...props} />);
  const graph = screen.getByRole('img', { name: '平面图谱' });
  const before = [...graph.querySelectorAll('[data-world-x]')].map((n) =>
    n.getAttribute('data-world-x'),
  );
  fireEvent.wheel(graph, { deltaY: -100, clientX: 200, clientY: 200 });
  await waitFor(() =>
    expect(
      Number(screen.getByTestId('business-scene').dataset.zoom),
    ).toBeGreaterThan(1),
  );
  expect(
    [...graph.querySelectorAll('[data-world-x]')].map((n) =>
      n.getAttribute('data-world-x'),
    ),
  ).toEqual(before);
  expect(graph.querySelectorAll('[data-edge-id]')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '上一步视野' }));
  expect(screen.getByTestId('business-scene').dataset.zoom).toBe('1');
  fireEvent.keyDown(graph, { key: '+' });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 180));
  });
  expect(props.onSettings).toHaveBeenCalled();
});
it('names category layers and retains the same nodes and directed edges across rotation', () => {
  vi.stubGlobal('ResizeObserver', Resize);
  const view = render(
    <BusinessSceneCanvas
      {...props}
      settings={{ ...defaultSceneView, form: 'layers' }}
    />,
  );
  expect(screen.getAllByText('地点 · 4')).toHaveLength(2);
  const root = screen.getByTestId('business-scene');
  const before = root.querySelector('polygon')?.getAttribute('points');
  view.rerender(
    <BusinessSceneCanvas
      {...props}
      settings={{ ...defaultSceneView, form: 'layers', yaw: 50 }}
    />,
  );
  expect(root.querySelector('polygon')?.getAttribute('points')).not.toBe(
    before,
  );
  expect(root.querySelectorAll('[data-node-id]')).toHaveLength(4);
  expect(root.querySelectorAll('[data-edge-id]')).toHaveLength(2);
  fireEvent.click(screen.getByText('显示设置'));
  fireEvent.change(screen.getByRole('slider', { name: /旋转角度/ }), {
    target: { value: '90' },
  });
  expect(props.onSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ yaw: 90 }),
  );
});
it('offers a keyboard list and clears focus without changing the result scope', () => {
  vi.stubGlobal('ResizeObserver', Resize);
  render(<BusinessSceneCanvas {...props} selectedId="a" />);
  fireEvent.change(screen.getByRole('searchbox', { name: '查找节点或关系' }), {
    target: { value: 'x' },
  });
  const inspector = screen.getByRole('complementary', {
    name: '所选关系的原文依据',
  });
  fireEvent.click(
    within(inspector).getByRole('button', { name: '地点 · x 来源标题未登记' }),
  );
  expect(props.onSelect).toHaveBeenCalledWith('x');
  fireEvent.click(screen.getByRole('button', { name: '清除聚焦' }));
  expect(props.onSelect).toHaveBeenCalledWith(null);
  expect(screen.getByTestId('business-scene').dataset.edgeCount).toBe('2');
});
it('returns from an object-centered view to a cleared panorama', () => {
  vi.stubGlobal('ResizeObserver', Resize);
  render(
    <BusinessSceneCanvas
      {...props}
      selectedId="a"
      settings={{ ...defaultSceneView, view: 'object', zoom: 3 }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '返回全景' }));
  expect(props.onSettings).toHaveBeenCalledWith(
    expect.objectContaining({ view: 'overview', zoom: 1, panX: 0, panY: 0 }),
  );
  expect(props.onSelect).toHaveBeenCalledWith(null);
  expect(props.onEdge).toHaveBeenCalledWith(null);
});
it('clears an earlier selected assertion when switching to a category focus', () => {
  vi.stubGlobal('ResizeObserver', Resize);
  render(<BusinessSceneCanvas {...props} selectedEdge="ab" />);
  const legend = screen.getByText('分层依据 · 1').closest('details')!;
  legend.open = true;
  fireEvent.click(within(legend).getByRole('button', { name: /地点 · 4/ }));
  expect(props.onEdge).toHaveBeenCalledWith(null);
});

it('pans without rewriting node geometry and hit-tests overlapping edges in the translated view', () => {
  vi.stubGlobal('ResizeObserver', Resize);
  const overlapping = {
    ...scene,
    edges: [scene.edges[0], { ...scene.edges[0], id: 'ab-other-source' }],
  };
  render(<BusinessSceneCanvas {...props} scene={overlapping} />);
  const graph = screen.getByRole('img', { name: '平面图谱' });
  const geometry = () =>
    [...graph.querySelectorAll('[data-node-id] circle')].map((el) => [
      el.getAttribute('cx'),
      el.getAttribute('cy'),
    ]);
  const before = geometry();
  fireEvent.keyDown(graph, { key: 'ArrowLeft' });
  expect(geometry()).toEqual(before);
  const hit = graph.querySelector(
    '[data-edge-id="ab"] line[stroke="transparent"]',
  )!;
  fireEvent.click(hit, {
    clientX:
      (Number(hit.getAttribute('x1')) + Number(hit.getAttribute('x2'))) / 2 +
      40,
    clientY:
      (Number(hit.getAttribute('y1')) + Number(hit.getAttribute('y2'))) / 2,
  });
  expect(screen.getByText(/重叠.*2/)).toBeTruthy();
  expect(graph.querySelectorAll('[data-node-id]')).toHaveLength(4);
  expect(graph.querySelectorAll('[data-edge-id]')).toHaveLength(2);
});

it('distinguishes type families and review status without changing identities when changing reading presets', () => {
  vi.stubGlobal('ResizeObserver', Resize);
  const typedScene: BusinessScene = {
    nodes: [
      { ...node('river'), kind: 'RIVER_REACH' },
      { ...node('station'), kind: 'MONITORING_POINT' },
      { ...node('paper'), kind: 'DOCUMENT' },
      { ...node('claim'), kind: 'CLAIM' },
    ],
    edges: [
      {
        id: 'identity',
        from: 'river',
        to: 'station',
        row: {
          ...row('river', 'station'),
          status: 'PENDING_REVIEW',
          candidate: {
            ...row('river', 'station').candidate,
            predicate: 'IDENTITY_MATCH',
          },
        },
      },
    ],
  };
  render(<BusinessSceneCanvas {...props} scene={typedScene} />);
  const root = screen.getByTestId('business-scene');
  expect(
    root.querySelector('[data-node-id="river"]')?.getAttribute('data-family'),
  ).toBe('water');
  expect(
    root.querySelector('[data-node-id="station"]')?.getAttribute('data-family'),
  ).toBe('site');
  expect(
    root.querySelector('[data-node-id="paper"]')?.getAttribute('data-family'),
  ).toBe('asset');
  expect(
    root.querySelector('[data-node-id="claim"]')?.getAttribute('data-family'),
  ).toBe('claim');
  const line = root.querySelector(
    '[data-edge-id="identity"] line[data-relation-line]',
  )!;
  expect(line.getAttribute('marker-end')).toBeNull();
  expect(line.getAttribute('stroke-dasharray')).toBe('5 3');
  expect(screen.getByText(/虚线.*待审/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '流畅优先' }));
  expect(props.onSettings).toHaveBeenCalledWith(
    expect.objectContaining({ style: 'smooth' }),
  );
  expect(
    [...root.querySelectorAll('[data-node-id]')].map((n) =>
      n.getAttribute('data-node-id'),
    ),
  ).toEqual(['river', 'station', 'paper', 'claim']);
});
