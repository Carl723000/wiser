import { supportedReadingCamera, type MapCamera } from './amap-camera';

/** Coordinate round trips may differ below display precision; all five fields count. */
export function sameCandidateMapCamera(a: MapCamera, b: MapCamera) {
  return (
    Math.abs(a.longitude - b.longitude) < 1e-6 &&
    Math.abs(a.latitude - b.latitude) < 1e-6 &&
    Math.abs(a.zoom - b.zoom) < 1e-8 &&
    Math.abs(((a.bearing - b.bearing + 540) % 360) - 180) < 1e-8 &&
    Math.abs(a.pitch - b.pitch) < 1e-8
  );
}

interface CameraEvent {
  originalEvent?: Event;
  candidateCameraReplay?: unknown;
}
interface CameraHost {
  current: () => boolean;
  read: () => MapCamera;
  jump: (camera: MapCamera, data: Record<string, unknown>) => void;
  scrollZooming: () => boolean;
  report: (camera: MapCamera) => void;
}

/** Per-map reading state only. The caller owns identity, permissions and source bytes. */
export function createCandidateMapCameraController(host: CameraHost) {
  let inputs = new WeakSet<Event>();
  let dragging = false;
  let wheel = false;
  let applying = false;
  let disposed = false;
  let owner: string | undefined;
  let controlled: MapCamera | undefined;
  let settled: MapCamera | undefined;
  let lastReport: MapCamera | undefined;
  let lastMove: MapCamera | undefined;
  const replay = {};
  const current = () => !disposed && host.current();
  function invalidate() {
    inputs = new WeakSet<Event>();
    dragging = false;
    wheel = false;
    lastMove = undefined;
    lastReport = undefined;
  }
  function apply(camera: MapCamera) {
    applying = true;
    try {
      // MapLibre jumpTo calls stop itself; the previous animation may end
      // synchronously before it emits the tagged replay movement.
      host.jump(camera, { candidateCameraReplay: replay });
    } finally {
      applying = false;
    }
  }
  function qualifies(event: CameraEvent) {
    if (!current() || applying || event.candidateCameraReplay !== undefined)
      return false;
    if (event.originalEvent) return inputs.has(event.originalEvent);
    // Native wheel classification occasionally has no DOM source. A fresh
    // wheel on this exact map must requalify it after every external replay.
    return wheel && host.scrollZooming();
  }
  return {
    hasControlledCamera() {
      return controlled !== undefined;
    },
    setControlled(camera: MapCamera | undefined, nextOwner?: string) {
      if (!current()) return;
      const ownerChanged = owner !== nextOwner;
      owner = nextOwner;
      const next = supportedReadingCamera(camera);
      if (!ownerChanged && camera === undefined && controlled === undefined)
        return;
      // Invalid camera proposals never replace a supported controlled view.
      if (camera && !next && !ownerChanged) return;
      if (
        !ownerChanged &&
        next &&
        controlled &&
        sameCandidateMapCamera(next, controlled)
      )
        return;
      controlled = next;
      if (
        !ownerChanged &&
        next &&
        lastReport &&
        sameCandidateMapCamera(next, lastReport)
      )
        return;
      invalidate();
      settled = next ?? host.read();
      if (ownerChanged || (next && !sameCandidateMapCamera(next, host.read())))
        apply(settled);
    },
    input(event: Event, inside: boolean) {
      if (!current() || applying) return;
      const start = ['mousedown', 'pointerdown', 'touchstart'].includes(
        event.type,
      );
      const continuation = [
        'mousemove',
        'mouseup',
        'pointermove',
        'pointerup',
        'pointercancel',
        'touchmove',
        'touchend',
        'touchcancel',
      ].includes(event.type);
      if (!inside && !(dragging && continuation)) return;
      inputs.add(event);
      if (start) dragging = true;
      if (event.type === 'wheel') wheel = true;
      if (
        [
          'mouseup',
          'pointerup',
          'pointercancel',
          'touchend',
          'touchcancel',
        ].includes(event.type)
      )
        dragging = false;
    },
    move(event: CameraEvent = {}) {
      if (qualifies(event)) lastMove = host.read();
    },
    end(event: CameraEvent = {}) {
      if (!current() || applying || event.candidateCameraReplay !== undefined)
        return;
      const camera = host.read();
      const deliveredMove =
        !event.originalEvent &&
        lastMove &&
        sameCandidateMapCamera(camera, lastMove);
      // Initial-camera-only callers retain their legacy end reporting. Strict
      // input ownership applies when the caller opts into controlled reading.
      if (
        (controlled === undefined && owner === undefined) ||
        qualifies(event) ||
        deliveredMove
      ) {
        settled = camera;
        lastReport = camera;
        lastMove = undefined;
        host.report(camera);
      } else if (
        controlled &&
        settled &&
        !sameCandidateMapCamera(camera, settled)
      ) {
        // A delayed rejected frame can still affect the native transform.
        // Restore the latest accepted camera without emitting a user proposal.
        apply(settled);
      }
    },
    perspective(change: () => void) {
      if (!current()) return;
      invalidate();
      applying = true;
      try {
        change();
      } finally {
        applying = false;
      }
      if (!current()) return;
      settled = host.read();
      lastReport = settled;
      host.report(settled);
    },
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}
