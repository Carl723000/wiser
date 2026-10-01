import { describe, expect, it } from 'vitest';
import type { Geometry } from 'geojson';
import {
  geometryIntersectsWorkspaceBounds,
  isWorkspaceGeometry,
  parseWorkspaceBounds,
  projectWorkspaceCoordinate,
  workspaceGeometryAnchor,
} from './spatial-workspace-view';

const rectangle: Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [114, 38],
      [118, 38],
      [118, 42],
      [114, 42],
      [114, 38],
    ],
    [
      [115, 39],
      [117, 39],
      [117, 41],
      [115, 41],
      [115, 39],
    ],
  ],
};

describe('actual geometry intersection for spatial selection', () => {
  it('does not select the bounding box of a bent line as its geometry', () => {
    const line: Geometry = {
      type: 'LineString',
      coordinates: [
        [114, 38],
        [114, 42],
        [118, 42],
      ],
    };
    expect(geometryIntersectsWorkspaceBounds(line, [115, 39, 116, 40])).toBe(
      false,
    );
    expect(geometryIntersectsWorkspaceBounds(line, [113, 39, 115, 40])).toBe(
      true,
    );
  });

  it('selects a segment crossing a rectangle even when neither vertex is inside', () => {
    expect(
      geometryIntersectsWorkspaceBounds(
        {
          type: 'LineString',
          coordinates: [
            [114, 40],
            [118, 40],
          ],
        },
        [115, 39.5, 117, 40.5],
      ),
    ).toBe(true);
  });

  it('keeps a rectangle wholly inside a polygon hole unselected', () => {
    expect(
      geometryIntersectsWorkspaceBounds(rectangle, [115.2, 39.2, 116.8, 40.8]),
    ).toBe(false);
    expect(
      geometryIntersectsWorkspaceBounds(rectangle, [114.2, 38.2, 114.8, 38.8]),
    ).toBe(true);
    expect(
      geometryIntersectsWorkspaceBounds(rectangle, [113, 37, 119, 43]),
    ).toBe(true);
  });

  it('includes boundary contact without buffering or repairing the source', () => {
    expect(
      geometryIntersectsWorkspaceBounds(rectangle, [117, 39, 117.2, 40]),
    ).toBe(true);
  });

  it.each<Geometry>([
    {
      type: 'MultiPoint',
      coordinates: [
        [110, 30],
        [116, 40],
      ],
    },
    {
      type: 'MultiLineString',
      coordinates: [
        [
          [110, 30],
          [111, 31],
        ],
        [
          [114, 40],
          [118, 40],
        ],
      ],
    },
    { type: 'MultiPolygon', coordinates: [rectangle.coordinates] },
    {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [110, 30] },
        {
          type: 'LineString',
          coordinates: [
            [114, 40],
            [118, 40],
          ],
        },
      ],
    },
  ])('handles every part of %s without flattening its meaning', (geometry) => {
    expect(
      geometryIntersectsWorkspaceBounds(geometry, [114, 38, 114.5, 40.5]),
    ).toBe(geometry.type !== 'MultiPoint');
  });

  it('rejects invalid bounds instead of broadening the requested area', () => {
    expect(parseWorkspaceBounds('116,39,115,40')).toBeNull();
    expect(parseWorkspaceBounds('116,91,117,92')).toBeNull();
    expect(parseWorkspaceBounds('116,39,117,40,42')).toBeNull();
    expect(parseWorkspaceBounds('116,39,117,40')).toEqual([116, 39, 117, 40]);
  });
});

describe('geographic rendering invariants', () => {
  it.each([
    { type: 'Point', coordinates: [116] },
    { type: 'Point', coordinates: [116, Number.NaN] },
    { type: 'Point', coordinates: [216, 40] },
    { type: 'LineString', coordinates: [[116, 40]] },
    {
      type: 'Polygon',
      coordinates: [
        [
          [116, 40],
          [117, 40],
          [117, 41],
          [116, 41],
        ],
      ],
    },
    { type: 'GeometryCollection', geometries: [] },
    { type: 'Polygon', coordinates: [] },
  ])(
    'rejects malformed input rather than inventing repaired coordinates: %s',
    (value) => {
      expect(isWorkspaceGeometry(value)).toBe(false);
    },
  );

  it('takes a card connector anchor from original geometry, including a polygon with a hole', () => {
    expect(workspaceGeometryAnchor(rectangle)).toEqual([114, 38]);
    expect(
      workspaceGeometryAnchor({
        type: 'Point',
        coordinates: [116.2, 40.1, 20],
      }),
    ).toEqual([116.2, 40.1]);
  });

  it('uses the map-provided 3D matrix, including its perspective divide', () => {
    const matrix = [2, 0, 0, 0, 0, 2, 0, 0, 0, -1, 1, 1, -1, -1, 0, 1];
    expect(projectWorkspaceCoordinate(matrix, [0.5, 0.5, 0], 800, 600)).toEqual(
      {
        x: 400,
        y: 300,
      },
    );
    expect(
      projectWorkspaceCoordinate(matrix, [0.5, 0.5, 0.5], 800, 600),
    ).toEqual({
      x: 400,
      y: 400,
    });
  });

  it('clips connectors behind the camera or outside its depth range', () => {
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(projectWorkspaceCoordinate(matrix, [0, 0, 2], 800, 600)).toBeNull();
    expect(
      projectWorkspaceCoordinate(
        matrix.map((n) => -n),
        [0, 0, 0],
        800,
        600,
      ),
    ).toBeNull();
    expect(projectWorkspaceCoordinate([], [0, 0, 0], 800, 600)).toBeNull();
  });
});
