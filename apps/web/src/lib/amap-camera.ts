import { fromAmap, toAmap } from './amap-coordinates';

export interface MapCamera {
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
  readonly bearing: number;
  readonly pitch: number;
}

/** The current candidate map is planar, with its existing zoom bounds. */
export function supportedReadingCamera(camera: MapCamera | undefined) {
  return camera &&
    Object.values(camera).every(Number.isFinite) &&
    Math.abs(camera.longitude) <= 180 &&
    Math.abs(camera.latitude) <= 85.051129 &&
    camera.zoom >= 1 &&
    camera.zoom <= 21 &&
    camera.bearing === 0 &&
    camera.pitch === 0
    ? camera
    : undefined;
}

export function amapCamera(display: MapCamera) {
  return {
    center: [display.longitude, display.latitude],
    zoom: display.zoom + 1,
  };
}

export function displayCamera(authority: MapCamera): MapCamera {
  const [longitude, latitude] = toAmap([
    authority.longitude,
    authority.latitude,
  ]);
  return { ...authority, longitude, latitude, bearing: 0, pitch: 0 };
}

export function authorityCamera(display: MapCamera): MapCamera {
  const [longitude, latitude] = fromAmap([display.longitude, display.latitude]);
  return { ...display, longitude, latitude, bearing: 0, pitch: 0 };
}
