import { expect, it } from 'vitest';
import {
  readSceneView,
  writeSceneView,
  defaultSceneView,
  scenePositions,
  projectScenePoint,
  zoomSceneCamera,
} from './business-scene-view';
import type { BusinessScene } from './business-scene';
const scene: BusinessScene = {
  nodes: Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    label: String(i),
    kind: i < 10 ? 'DOCUMENT' : 'PLACE',
    group: i < 10 ? 'reports' : 'PLACE',
    classificationBasis: null,
    record: null,
    periods: [],
  })),
  edges: [],
};
it('roundtrips bounded presentation and camera controls without touching query pins', () => {
  const params = new URLSearchParams(
    'saved=private&businessForm=layers&businessView=compare&businessYaw=30&businessZoom=2.5&businessStyle=smooth',
  );
  const settings = readSceneView(params);
  expect(settings.style).toBe('smooth');
  expect(settings.form).toBe('layers');
  expect(settings.view).toBe('compare');
  expect(settings.yaw).toBe(30);
  expect(settings.zoom).toBe(2.5);
  writeSceneView(params, settings);
  expect(params.get('saved')).toBe('private');
  expect(readSceneView(params)).toEqual(settings);
  expect(
    readSceneView(
      new URLSearchParams(
        'businessForm=layers&businessForm=space&businessZoom=Infinity&businessYaw=9999&businessView=sql',
      ),
    ),
  ).toEqual(defaultSceneView);
});
it('keeps exact membership and finite positions in every task and display mode', () => {
  for (const view of [
    'overview',
    'compare',
    'object',
    'trace',
    'time',
  ] as const)
    for (const form of ['flat', 'layers', 'space'] as const) {
      const layout = scenePositions(
        scene,
        { ...defaultSceneView, view, form },
        '1',
      );
      expect([...layout.positions.keys()].sort()).toEqual(
        scene.nodes.map((n) => n.id).sort(),
      );
      for (const p of layout.positions.values())
        expect(p.every(Number.isFinite)).toBe(true);
      expect(layout.groups.every((g) => g.members.length > 0)).toBe(true);
    }
});
it('uses depth for category layers, and rotation preserves identities rather than recomputing membership', () => {
  const layout = scenePositions(
    scene,
    { ...defaultSceneView, form: 'layers' },
    null,
  );
  const a = layout.positions.get('0')!,
    b = layout.positions.get('10')!;
  expect(a[2]).not.toBe(b[2]);
  expect(projectScenePoint(a, 0, 45)).not.toEqual(projectScenePoint(a, 50, 45));
  expect(projectScenePoint([10, 20, 0], 0, 0)).toEqual([10, 20]);
});
it('zooms around the cursor without moving its world point or changing source positions', () => {
  const camera = { zoom: 1, panX: 10, panY: 20 };
  const next = zoomSceneCamera(camera, 2, [100, 150]);
  expect((100 - next.panX) / next.zoom).toBe((100 - camera.panX) / camera.zoom);
  expect((150 - next.panY) / next.zoom).toBe((150 - camera.panY) / camera.zoom);
  expect(zoomSceneCamera(camera, 999, [0, 0]).zoom).toBeLessThanOrEqual(20);
});
it('offers every edge at a crossing instead of silently choosing the last painted edge', async () => {
  const { sceneEdgesAt } = await import('./business-scene-view');
  const positions = new Map<string, [number, number]>([
    ['a', [0, 0]],
    ['b', [100, 100]],
    ['c', [0, 100]],
    ['d', [100, 0]],
    ['e', [400, 400]],
  ]);
  expect(
    sceneEdgesAt(
      [
        { id: 'ab', from: 'a', to: 'b' },
        { id: 'cd', from: 'c', to: 'd' },
        { id: 'ae', from: 'a', to: 'e' },
      ],
      positions,
      [50, 50],
      5,
    ),
  ).toEqual(['ab', 'cd', 'ae']);
  expect(
    sceneEdgesAt([{ id: 'ee', from: 'e', to: 'e' }], positions, [50, 50], 5),
  ).toEqual([]);
});
