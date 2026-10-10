import { expect, it } from 'vitest';
import {
  amapCamera,
  displayCamera,
  authorityCamera,
  supportedReadingCamera,
} from './amap-camera';

it('matches the measured 512px MapLibre and 256px AMap world scales without shifting display coordinates twice', () => {
  const camera = {
    longitude: 116.39754,
    latitude: 39.908901,
    zoom: 15,
    bearing: 0,
    pitch: 0,
  };
  expect(amapCamera(camera)).toEqual({
    center: [116.39754, 39.908901],
    zoom: 16,
  });
});

it('saves and restores geographic cameras through a single coordinate conversion', () => {
  const original = {
    longitude: 116.3913,
    latitude: 39.9075,
    zoom: 12,
    bearing: 0,
    pitch: 0,
  };
  const display = displayCamera(original);
  expect(display.longitude).toBeCloseTo(116.39754, 5);
  const restored = authorityCamera(display);
  expect(restored.longitude).toBeCloseTo(original.longitude, 6);
  expect(restored.latitude).toBeCloseTo(original.latitude, 6);
  expect(restored.zoom).toBe(12);
  expect(original.longitude).toBe(116.3913);
});

it('preserves supported planar bird-eye bearing and pitch through authority/display conversion', () => {
  const camera = {
    longitude: 116.3913,
    latitude: 39.9075,
    zoom: 12,
    bearing: 32,
    pitch: 50,
  };
  expect(supportedReadingCamera(camera)).toEqual(camera);
  const restored = authorityCamera(displayCamera(camera));
  expect(restored.bearing).toBe(32);
  expect(restored.pitch).toBe(50);
  expect(supportedReadingCamera({ ...camera, pitch: 86 })).toBeUndefined();
  expect(supportedReadingCamera({ ...camera, bearing: 181 })).toBeUndefined();
});
