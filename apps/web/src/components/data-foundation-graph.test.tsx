// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GraphOptions } from '@antv/g6';
import { KnowledgeGraphCanvas } from './data-foundation-graph';

const engine = vi.hoisted(() => ({
  options: null as GraphOptions | null,
  render: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
  resize: vi.fn(),
  fitView: vi.fn().mockResolvedValue(undefined),
  fitCenter: vi.fn().mockResolvedValue(undefined),
  zoomTo: vi.fn().mockResolvedValue(undefined),
  getZoom: vi.fn(() => 1),
  getElementPosition: vi.fn((id: string): [number, number] => {
    const node = engine.options?.data?.nodes?.find((n) => n.id === id);
    return [Number(node?.style?.x), Number(node?.style?.y)];
  }),
  focusElement: vi.fn().mockResolvedValue(undefined),
  draw: vi.fn().mockResolvedValue(undefined),
  updateNodeData: vi.fn<
    (
      nodes: {
        id: string;
        style?: { labelVisibility?: string; labelLineHeight?: number };
      }[],
    ) => void
  >(),
  updateEdgeData: vi.fn(),
  setElementState: vi.fn().mockResolvedValue(undefined),
  click: null as ((event: { target: { id: string } }) => void) | null,
}));
vi.mock('@antv/g6', () => ({
  NodeEvent: { CLICK: 'node:click' },
  GraphEvent: { AFTER_TRANSFORM: 'aftertransform' },
  Graph: class {
    constructor(options: GraphOptions) {
      engine.options = options;
    }
    on(_event: string, callback: typeof engine.click) {
      if (_event === 'node:click') engine.click = callback;
    }
    render = engine.render;
    destroy = engine.destroy;
    resize = engine.resize;
    fitView = engine.fitView;
    fitCenter = engine.fitCenter;
    zoomTo = engine.zoomTo;
    getZoom = engine.getZoom;
    getElementPosition = engine.getElementPosition;
    focusElement = engine.focusElement;
    draw = engine.draw;
    updateNodeData = engine.updateNodeData;
    updateEdgeData = engine.updateEdgeData;
    setElementState = engine.setElementState;
  },
}));
class WorkerDouble {
  static current: WorkerDouble;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    WorkerDouble.current = this;
  }
}
class ResizeDouble {
  static callback: () => void;
  constructor(callback: () => void) {
    ResizeDouble.callback = callback;
  }
  observe() {}
  disconnect() {}
}
const result = {
  nodes: [
    { entityId: 'a', label: 'Source' },
    { entityId: 'b', label: 'Asset' },
  ],
  edges: [{ edgeId: 'ab', fromEntityId: 'a', toEntityId: 'b' }],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  engine.getZoom.mockReturnValue(1);
});

it('avoids overlapping overview labels and prioritizes a newly selected object without replacing the graph', async () => {
  vi.stubGlobal('Worker', WorkerDouble);
  vi.stubGlobal('ResizeObserver', ResizeDouble);
  engine.getZoom.mockReturnValue(0.1);
  const crowded = {
    nodes: Array.from({ length: 20 }, (_, i) => ({
      entityId: String(i),
      label: `流域资料 ${i}`,
      overviewLabel: true,
    })),
    edges: [],
  };
  const props = {
    locale: 'zh-CN' as const,
    result: crowded,
    onSelect: vi.fn(),
  };
  const rendered = render(
    <KnowledgeGraphCanvas {...props} selectedId={null} />,
  );
  await waitFor(() =>
    expect(WorkerDouble.current.postMessage).toHaveBeenCalledOnce(),
  );
  await act(async () => {
    WorkerDouble.current.onmessage?.({
      data: crowded.nodes.map((n, i) => ({ id: n.entityId, x: i * 30, y: 0 })),
    });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(
      screen.getByTestId('knowledge-graph').getAttribute('data-state'),
    ).toBe('ready'),
  );
  const visible = () =>
    engine.updateNodeData.mock.calls
      .at(-1)?.[0]
      .filter((n) => n.style?.labelVisibility === 'visible');
  await waitFor(() => expect(visible()).toHaveLength(1));
  expect(visible()?.[0].style?.labelLineHeight).toBe(160);
  rendered.rerender(<KnowledgeGraphCanvas {...props} selectedId="19" />);
  await waitFor(() => expect(visible()?.map((n) => n.id)).toEqual(['19']));
  expect(engine.render).toHaveBeenCalledOnce();
});

it('fits only after the first readable-label draw and does not refit on selection', async () => {
  vi.stubGlobal('Worker', WorkerDouble);
  vi.stubGlobal('ResizeObserver', ResizeDouble);
  let finishDraw!: () => void;
  engine.draw.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishDraw = resolve;
      }),
  );
  const props = { locale: 'zh-CN' as const, result, onSelect: vi.fn() };
  const rendered = render(
    <KnowledgeGraphCanvas {...props} selectedId={null} />,
  );
  await waitFor(() =>
    expect(WorkerDouble.current.postMessage).toHaveBeenCalledOnce(),
  );
  act(() => {
    WorkerDouble.current.onmessage?.({
      data: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 0, y: 800 },
      ],
    });
  });
  await waitFor(() => expect(engine.draw).toHaveBeenCalledOnce());
  expect(engine.fitView).not.toHaveBeenCalled();
  act(() => finishDraw());
  await waitFor(() => expect(engine.fitView).toHaveBeenCalledOnce());
  rendered.rerender(<KnowledgeGraphCanvas {...props} selectedId="b" />);
  await waitFor(() => expect(engine.draw).toHaveBeenCalledTimes(2));
  expect(engine.fitView).toHaveBeenCalledOnce();
});

it('renders worker positions, preserves the canvas on selection and disposes after rendering', async () => {
  vi.stubGlobal('Worker', WorkerDouble);
  vi.stubGlobal('ResizeObserver', ResizeDouble);
  const selected = vi.fn();
  const rendered = render(
    <KnowledgeGraphCanvas
      locale="zh-CN"
      result={result}
      selectedId={null}
      onSelect={selected}
    />,
  );
  await waitFor(() =>
    expect(WorkerDouble.current.postMessage).toHaveBeenCalledOnce(),
  );
  await act(async () => {
    WorkerDouble.current.onmessage?.({
      data: [
        { id: 'a', x: 12, y: 5 },
        { id: 'b', x: 52, y: 5 },
      ],
    });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(
      screen.getByTestId('knowledge-graph').getAttribute('data-state'),
    ).toBe('ready'),
  );
  expect(engine.options?.data?.nodes?.[0].style?.x).toBe(12);
  expect(engine.options?.layout).toBeUndefined();
  Object.defineProperties(screen.getByRole('img'), {
    clientWidth: { value: 390 },
    clientHeight: { value: 440 },
  });
  act(() => ResizeDouble.callback());
  await waitFor(() => expect(engine.fitView).toHaveBeenCalledTimes(2));
  expect(WorkerDouble.current.terminate).toHaveBeenCalledOnce();
  rendered.rerender(
    <KnowledgeGraphCanvas
      locale="zh-CN"
      result={result}
      selectedId="b"
      onSelect={selected}
    />,
  );
  await waitFor(() =>
    expect(engine.setElementState).toHaveBeenLastCalledWith(
      { b: ['selected'] },
      false,
    ),
  );
  rendered.rerender(
    <KnowledgeGraphCanvas
      locale="zh-CN"
      result={result}
      selectedId="b"
      path={{ nodeIds: ['a', 'b'], edgeIds: ['ab'] }}
      onSelect={selected}
    />,
  );
  await waitFor(() =>
    expect(engine.setElementState).toHaveBeenLastCalledWith(
      { a: ['path'], b: ['path', 'selected'], ab: ['path'] },
      false,
    ),
  );
  rendered.rerender(
    <KnowledgeGraphCanvas
      locale="zh-CN"
      result={result}
      selectedId="b"
      onSelect={selected}
    />,
  );
  await waitFor(() =>
    expect(engine.setElementState).toHaveBeenLastCalledWith(
      { a: [], b: ['selected'], ab: [] },
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '放大图谱' }));
  await waitFor(() =>
    expect(engine.zoomTo).toHaveBeenLastCalledWith(1.25, false),
  );
  fireEvent.click(screen.getByRole('button', { name: '定位所选节点' }));
  await waitFor(() =>
    expect(engine.focusElement).toHaveBeenCalledWith('b', false),
  );
  expect(engine.render).toHaveBeenCalledOnce();
  act(() => {
    engine.click?.({ target: { id: 'a' } });
  });
  expect(selected).toHaveBeenCalledWith('a');
  rendered.unmount();
  await waitFor(() => expect(engine.destroy).toHaveBeenCalledOnce());
});

it('uses current theme colors for rendered node and edge labels without resetting the view', async () => {
  vi.stubGlobal('Worker', WorkerDouble);
  vi.stubGlobal('ResizeObserver', ResizeDouble);
  const originalStyle = document.documentElement.getAttribute('style');
  const originalTheme = document.documentElement.getAttribute('data-theme');
  const theme = (foreground: string, background: string) => {
    document.documentElement.style.setProperty('--text-primary', foreground);
    document.documentElement.style.setProperty('--surface', background);
    document.documentElement.style.setProperty('--accent', foreground);
    document.documentElement.style.setProperty('--border-strong', foreground);
  };
  const resolve = (style: unknown) =>
    typeof style === 'function'
      ? (style as (datum: { data: { kind: string } }) => unknown)({
          data: { kind: 'PLACE' },
        })
      : style;
  try {
    theme('#12343d', '#edf5f6');
    render(
      <KnowledgeGraphCanvas
        locale="zh-CN"
        result={result}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(WorkerDouble.current.postMessage).toHaveBeenCalledOnce(),
    );
    act(() =>
      WorkerDouble.current.onmessage?.({
        data: [
          { id: 'a', x: 0, y: 0 },
          { id: 'b', x: 300, y: 300 },
        ],
      }),
    );
    await waitFor(() => expect(engine.fitView).toHaveBeenCalledOnce());
    const node = engine.options?.node?.style as Record<string, unknown>;
    const edge = engine.options?.edge?.style as Record<string, unknown>;
    expect(resolve(node['labelFill'])).toBe('#12343d');
    theme('#e8f3f4', '#0b303a');
    const draws = engine.draw.mock.calls.length;
    act(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await waitFor(() =>
      expect(engine.draw.mock.calls.length).toBeGreaterThan(draws),
    );
    expect(resolve(node['labelFill'])).toBe('#e8f3f4');
    expect(resolve(node['fill'])).toBe('#e8f3f4');
    expect(resolve(edge['labelFill'])).toBe('#e8f3f4');
    expect(resolve(edge['labelBackgroundFill'])).toBe('#0b303a');
    expect(resolve(edge['stroke'])).toBe('#e8f3f4');
    expect(engine.render).toHaveBeenCalledOnce();
    expect(engine.fitView).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    if (originalStyle === null)
      document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', originalStyle);
    if (originalTheme === null)
      document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', originalTheme);
  }
});

it('cancels unfinished layout when the graph is removed', async () => {
  vi.stubGlobal('ResizeObserver', ResizeDouble);
  vi.stubGlobal('Worker', WorkerDouble);
  const rendered = render(
    <KnowledgeGraphCanvas
      locale="en"
      result={result}
      selectedId={null}
      onSelect={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(WorkerDouble.current.postMessage).toHaveBeenCalledOnce(),
  );
  rendered.unmount();
  await waitFor(() =>
    expect(WorkerDouble.current.terminate).toHaveBeenCalledOnce(),
  );
  expect(engine.render).not.toHaveBeenCalled();
});

it('recomputes spacing at the current zoom so fitting cannot cancel density changes', async () => {
  vi.stubGlobal('Worker', WorkerDouble);
  vi.stubGlobal('ResizeObserver', ResizeDouble);
  engine.getZoom.mockReturnValue(0.4);
  const layoutSettings = {
    layout: 'network' as const,
    grouping: 'topology' as const,
    nodeSpacing: 40,
    groupSpacing: 200,
  };
  const props = {
    result,
    locale: 'zh-CN' as const,
    onSelect: vi.fn(),
    selectedId: null,
    layoutSettings,
    onLayoutSettingsChange: vi.fn(),
  };
  const view = render(<KnowledgeGraphCanvas {...props} />);
  await waitFor(() =>
    expect(WorkerDouble.current.postMessage).toHaveBeenCalled(),
  );
  const first = WorkerDouble.current;
  await act(async () => {
    first.onmessage?.({
      data: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
    });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(
      screen.getByTestId('knowledge-graph').getAttribute('data-state'),
    ).toBe('ready'),
  );
  view.rerender(
    <KnowledgeGraphCanvas
      {...props}
      layoutSettings={{ ...layoutSettings, nodeSpacing: 80 }}
    />,
  );
  await waitFor(() => expect(WorkerDouble.current).not.toBe(first));
  await act(async () => {
    WorkerDouble.current.onmessage?.({
      data: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 200, y: 0 },
      ],
    });
    await Promise.resolve();
  });
  await waitFor(() => expect(engine.zoomTo).toHaveBeenCalledWith(0.4, false));
  expect(engine.fitCenter).toHaveBeenCalled();
});
