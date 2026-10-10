// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DataFoundationMap,
  type DataFoundationMapReadingHandle,
} from '@/components/data-foundation-map';
import { displayCamera, authorityCamera, type MapCamera } from './amap-camera';
import { getDictionary } from './i18n';

const native = vi.hoisted(() => ({ maps: [] as TestMap[] }));
interface TestMap {
  container: HTMLElement;
  camera: MapCamera;
  events: Map<string, (event: Record<string, unknown>) => void>;
  emit: (name: string, event?: Record<string, unknown>) => void;
  jumpTo: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  zooming: boolean;
  loads: Array<() => void>;
  fitBounds: ReturnType<typeof vi.fn>;
}
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  NavigationControl: class {},
  Map: class implements TestMap {
    container: HTMLElement;
    camera: MapCamera;
    events = new Map<string, (event: Record<string, unknown>) => void>();
    zooming = false;
    loads: Array<() => void> = [];
    constructor(options: {
      container: HTMLElement;
      center: [number, number];
      zoom: number;
      bearing: number;
      pitch: number;
    }) {
      this.container = options.container;
      this.camera = {
        longitude: options.center[0],
        latitude: options.center[1],
        zoom: options.zoom,
        bearing: options.bearing,
        pitch: options.pitch,
      };
      native.maps.push(this);
    }
    emit(name: string, data: Record<string, unknown> = {}) {
      this.events.get(name)?.({ target: this, ...data });
    }
    jumpTo = vi.fn(
      (
        options: {
          center?: [number, number];
          zoom?: number;
          bearing?: number;
          pitch?: number;
        },
        data: Record<string, unknown> = {},
      ) => {
        this.stop();
        this.camera = {
          longitude: options.center?.[0] ?? this.camera.longitude,
          latitude: options.center?.[1] ?? this.camera.latitude,
          zoom: options.zoom ?? this.camera.zoom,
          bearing: options.bearing ?? this.camera.bearing,
          pitch: options.pitch ?? this.camera.pitch,
        };
        this.emit('move', data);
        this.emit('moveend', data);
      },
    );
    // Native stop may synchronously end an old animation.
    stop = vi.fn(() => this.emit('moveend'));
    remove = vi.fn();
    getCenter() {
      return { lng: this.camera.longitude, lat: this.camera.latitude };
    }
    getZoom() {
      return this.camera.zoom;
    }
    getPitch() {
      return this.camera.pitch;
    }
    getBearing() {
      return this.camera.bearing;
    }
    scrollZoom = { isZooming: () => this.zooming };
    touchZoomRotate = { disableRotation: vi.fn() };
    on(name: string, action: (data: Record<string, unknown>) => void) {
      this.events.set(name, action);
    }
    once(name: string, action: () => void) {
      if (name === 'load') this.loads.push(action);
    }
    off() {}
    addControl() {}
    fitBounds = vi.fn();
    queryRenderedFeatures() {
      return [];
    }
    getLayer() {
      return undefined;
    }
    setLayoutProperty() {}
  },
}));
vi.mock('@/components/amap-basemap', () => ({ AmapBasemap: () => null }));
afterEach(() => {
  cleanup();
  native.maps = [];
  vi.clearAllMocks();
});

const initial: MapCamera = {
  longitude: 116,
  latitude: 40,
  zoom: 8,
  bearing: 0,
  pitch: 0,
};
const external: MapCamera = {
  longitude: 118,
  latitude: 41,
  zoom: 10,
  bearing: 30,
  pitch: 50,
};
const features = { type: 'FeatureCollection' as const, features: [] };
const props = {
  locale: 'en' as const,
  ariaLabel: 'Candidate camera',
  displayCrs: 'EPSG:4326' as const,
  features,
  stacExtents: [],
  labels: getDictionary('en').dataFoundation.mapPage,
};
function input(map: TestMap, event: Event) {
  void act(() => map.container.dispatchEvent(event));
  return event;
}
function move(map: TestMap, camera: MapCamera, originalEvent?: Event) {
  act(() => {
    map.camera = displayCamera(camera);
    map.emit('move', originalEvent ? { originalEvent } : {});
    map.emit('moveend', originalEvent ? { originalEvent } : {});
  });
}

it('synchronizes two mounted maps on all five camera fields without echo, recreation or source changes, and permits independent updates', () => {
  const left = vi.fn(),
    right = vi.fn();
  const View = ({ a, b }: { a: MapCamera; b: MapCamera }) => (
    <>
      <DataFoundationMap
        {...props}
        ariaLabel="Left"
        readingCamera={a}
        readingCameraOwner="left"
        onReadingCamera={left}
      />
      <DataFoundationMap
        {...props}
        ariaLabel="Right"
        readingCamera={b}
        readingCameraOwner="right"
        onReadingCamera={right}
      />
    </>
  );
  const { rerender } = render(<View a={initial} b={initial} />);
  const [a, b] = native.maps;
  expect(a.camera).toEqual(displayCamera(initial));
  rerender(<View a={external} b={external} />);
  expect(a.camera).toEqual(displayCamera(external));
  expect(b.camera).toEqual(displayCamera(external));
  expect(native.maps).toHaveLength(2);
  expect(left).not.toHaveBeenCalled();
  expect(right).not.toHaveBeenCalled();
  expect(a.remove).not.toHaveBeenCalled();
  rerender(<View a={initial} b={external} />);
  expect(a.camera).toEqual(displayCamera(initial));
  expect(b.camera).toEqual(displayCamera(external));
  expect(features).toEqual({ type: 'FeatureCollection', features: [] });
});

it.each(['wheel', 'keydown', 'mousedown', 'click'])(
  'reports a fresh %s input but never its delayed tail after external camera replay',
  (kind) => {
    const report = vi.fn();
    const { rerender } = render(
      <DataFoundationMap
        {...props}
        readingCamera={initial}
        onReadingCamera={report}
      />,
    );
    const map = native.maps[0];
    const event = input(
      map,
      kind === 'wheel'
        ? new WheelEvent(kind, { bubbles: true })
        : kind === 'keydown'
          ? new KeyboardEvent(kind, { bubbles: true, key: 'ArrowRight' })
          : new MouseEvent(kind, { bubbles: true }),
    );
    map.zooming = kind === 'wheel';
    move(map, { ...initial, longitude: 117 }, event);
    expect(report).toHaveBeenCalledTimes(1);
    report.mockClear();
    rerender(
      <DataFoundationMap
        {...props}
        readingCamera={external}
        onReadingCamera={report}
      />,
    );
    move(map, { ...initial, zoom: 9 }, event);
    expect(report).not.toHaveBeenCalled();
    expect(map.camera).toEqual(displayCamera(external));
    // Old native wheel frames may omit their event as well.
    move(map, { ...initial, zoom: 9.5 });
    expect(report).not.toHaveBeenCalled();
    expect(map.camera).toEqual(displayCamera(external));
    const fresh = input(
      map,
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }),
    );
    move(map, initial, fresh);
    expect(report).toHaveBeenCalledTimes(1);
  },
);

it('qualifies sourceless native scroll frames only after a new wheel, and accepts drag releases outside its container', () => {
  const report = vi.fn();
  render(
    <DataFoundationMap
      {...props}
      readingCamera={initial}
      onReadingCamera={report}
    />,
  );
  const map = native.maps[0];
  map.zooming = true;
  move(map, external);
  expect(report).not.toHaveBeenCalled();
  input(map, new WheelEvent('wheel', { bubbles: true }));
  move(map, { ...initial, zoom: 9 });
  expect(report).toHaveBeenCalledTimes(1);
  input(map, new MouseEvent('mousedown', { bubbles: true }));
  const released = new MouseEvent('mouseup', { bubbles: true });
  void act(() => document.dispatchEvent(released));
  move(map, external, released);
  expect(report).toHaveBeenCalledTimes(2);
});

it('retains a user camera reflection without stopping the next scroll frame or leaking between independent instances', () => {
  const left = vi.fn(),
    right = vi.fn();
  const View = ({ camera }: { camera: MapCamera }) => (
    <>
      <DataFoundationMap
        {...props}
        readingCamera={camera}
        onReadingCamera={left}
      />
      <DataFoundationMap
        {...props}
        readingCamera={initial}
        onReadingCamera={right}
      />
    </>
  );
  const { rerender } = render(<View camera={initial} />);
  const [a, b] = native.maps;
  const wheel = input(a, new WheelEvent('wheel', { bubbles: true }));
  a.zooming = b.zooming = true;
  move(a, external, wheel);
  const reflection = left.mock.calls[0][0] as MapCamera;
  a.stop.mockClear();
  rerender(<View camera={reflection} />);
  expect(a.stop).not.toHaveBeenCalled();
  move(a, { ...external, zoom: 11 }, wheel);
  expect(left).toHaveBeenCalledTimes(2);
  move(b, external, wheel);
  expect(right).not.toHaveBeenCalled();
});

it('invalidates user input on reading-owner replacement and rejects all callbacks from replaced geometry or an unmounted map', () => {
  const report = vi.fn();
  const { rerender, unmount } = render(
    <DataFoundationMap
      {...props}
      readingCamera={initial}
      readingCameraOwner="A"
      onReadingCamera={report}
    />,
  );
  const old = native.maps[0];
  const key = input(
    old,
    new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
  );
  rerender(
    <DataFoundationMap
      {...props}
      readingCamera={initial}
      readingCameraOwner="B"
      onReadingCamera={report}
    />,
  );
  move(old, external, key);
  expect(report).not.toHaveBeenCalled();
  expect(old.camera).toEqual(displayCamera(initial));
  rerender(
    <DataFoundationMap
      {...props}
      features={{ ...features }}
      readingCamera={initial}
      readingCameraOwner="B"
      onReadingCamera={report}
    />,
  );
  const current = native.maps.at(-1)!;
  move(old, external, key);
  expect(report).not.toHaveBeenCalled();
  const fresh = input(
    current,
    new KeyboardEvent('keydown', { bubbles: true, key: '+' }),
  );
  move(current, external, fresh);
  expect(report).toHaveBeenCalledTimes(1);
  unmount();
  move(current, initial, fresh);
  expect(report).toHaveBeenCalledTimes(1);
});

it('ignores unsupported external camera values and reports the explicit bird-eye button once while retaining center and zoom', () => {
  const report = vi.fn();
  const { rerender } = render(
    <DataFoundationMap
      {...props}
      readingCamera={initial}
      onReadingCamera={report}
    />,
  );
  const map = native.maps[0];
  rerender(
    <DataFoundationMap
      {...props}
      readingCamera={{ ...initial, zoom: Number.NaN }}
      onReadingCamera={report}
    />,
  );
  expect(map.camera).toEqual(displayCamera(initial));
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to bird’s-eye view' }),
  );
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(
    authorityCamera({ ...displayCamera(initial), pitch: 50 }),
  );
  expect(map.camera.zoom).toBe(initial.zoom);
});

it('rejects delayed tagged replay events even after fresh input, while permitting the new user event', () => {
  const report = vi.fn();
  const { rerender } = render(
    <DataFoundationMap
      {...props}
      readingCamera={initial}
      onReadingCamera={report}
    />,
  );
  const map = native.maps[0];
  rerender(
    <DataFoundationMap
      {...props}
      readingCamera={external}
      onReadingCamera={report}
    />,
  );
  const replay = map.jumpTo.mock.calls.at(-1)![1] as Record<string, unknown>;
  const fresh = input(
    map,
    new KeyboardEvent('keydown', { bubbles: true, key: '+' }),
  );
  act(() => map.emit('moveend', { ...replay, originalEvent: fresh }));
  expect(report).not.toHaveBeenCalled();
  move(map, { ...external, zoom: 11 }, fresh);
  expect(report).toHaveBeenCalledTimes(1);
});

it('applies a new controlled camera before initial load without later fitting over it, and accepts equivalent 180-degree bearings without replay', () => {
  const framedProps = {
    ...props,
    requestedBounds: [115, 39, 117, 41] as const,
  };
  const { rerender } = render(<DataFoundationMap {...framedProps} />);
  const map = native.maps[0];
  rerender(
    <DataFoundationMap
      {...framedProps}
      readingCamera={{ ...external, bearing: 180 }}
    />,
  );
  act(() => map.loads.forEach((load) => load()));
  expect(map.fitBounds).not.toHaveBeenCalled();
  map.jumpTo.mockClear();
  rerender(
    <DataFoundationMap
      {...framedProps}
      readingCamera={{ ...external, bearing: -180 }}
    />,
  );
  expect(map.jumpTo).not.toHaveBeenCalled();
});

it('captures the current native reading camera without reporting a user change and invalidates the capture on unmount', () => {
  const handle = { current: null as DataFoundationMapReadingHandle | null };
  const report = vi.fn();
  const { unmount } = render(
    <DataFoundationMap
      {...props}
      readingHandle={handle}
      onReadingCamera={report}
    />,
  );
  const map = native.maps[0];
  map.camera = displayCamera(external);
  expect(handle.current?.camera()).toEqual(
    authorityCamera(displayCamera(external)),
  );
  expect(report).not.toHaveBeenCalled();
  const captured = handle.current;
  unmount();
  expect(handle.current).toBeNull();
  expect(captured?.camera()).toBeUndefined();
});
