/**
 * Task-host observation lifecycle only. Neither an observer callback nor an open
 * window issues normal-runtime authority, a scanner receipt or runner verified.
 * The actual launch/collection composition must retain its own lexical register.
 */
export type RuntimeWindowReason =
  | 'observation_missing'
  | 'observation_unavailable'
  | 'invalid_observation'
  | 'generation_changed'
  | 'build_changed'
  | 'configuration_changed'
  | 'mount_changed'
  | 'migration_changed'
  | 'signature_changed'
  | 'ownership_changed'
  | 'loopback_changed'
  | 'unowned_session'
  | 'window_limit'
  | 'closed';
export interface RuntimeGeneration {
  readonly service: string;
  readonly actualId: string;
  readonly startedAt: string;
  readonly restartGeneration: number;
  readonly immutableImageId: string;
}
export interface RuntimeObservationBinding {
  readonly generations: readonly RuntimeGeneration[];
  readonly sourceBuildSha256: string;
  readonly configurationSha256: string;
  readonly mountsSha256: string;
  readonly migrationSha256: string;
  readonly signatureSourceSha256: string;
  readonly signatureBytesSha256: string;
  readonly signatureReadinessSha256: string;
  readonly ownershipLoopbackSha256: string;
}
export type RuntimeWindowResult =
  | { readonly status: 'unchanged' }
  | {
      readonly status: 'unknown' | 'rejected';
      readonly reason: RuntimeWindowReason;
    };
declare const observationWindowBrand: unique symbol;
export interface RuntimeObservationWindow {
  readonly [observationWindowBrand]: never;
}
export type OpenRuntimeObservationWindow =
  | { readonly status: 'open'; readonly window: RuntimeObservationWindow }
  | Exclude<RuntimeWindowResult, { status: 'unchanged' }>;
export interface RuntimeObservationWindows {
  openWindow(): Promise<OpenRuntimeObservationWindow>;
  checkpoint(window: RuntimeObservationWindow): Promise<RuntimeWindowResult>;
  signal(window: RuntimeObservationWindow): AbortSignal;
  closeWindow(window: RuntimeObservationWindow): void;
  close(): void;
  diagnostics(): {
    activeWindows: number;
    activeObservations: number;
    activeWatchers: number;
    closed: boolean;
  };
}
export interface RuntimeObservationControls {
  /** Execution bounds chosen by the task host, not A12 latency thresholds. */
  readonly maximumObservationMs: number;
  readonly sampleIntervalMs: number;
  readonly maximumWindows: number;
}

type Failure = Exclude<RuntimeWindowResult, { status: 'unchanged' }>;
type Observation =
  { status: 'observed'; binding: RuntimeObservationBinding } | Failure;
const hashFields = [
  'sourceBuildSha256',
  'configurationSha256',
  'mountsSha256',
  'migrationSha256',
  'signatureSourceSha256',
  'signatureBytesSha256',
  'signatureReadinessSha256',
  'ownershipLoopbackSha256',
] as const;
const unavailable = (): Failure => ({
  status: 'unknown',
  reason: 'observation_unavailable',
});
function captureNative(prototype: object, name: string, kind: 'value' | 'get') {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  const method: unknown = descriptor
    ? Reflect.get(descriptor, kind)
    : undefined;
  return typeof method === 'function' ? method : null;
}
const nativeAddListener = captureNative(
  EventTarget.prototype,
  'addEventListener',
  'value',
);
const nativeRemoveListener = captureNative(
  EventTarget.prototype,
  'removeEventListener',
  'value',
);
const nativeAborted = captureNative(AbortSignal.prototype, 'aborted', 'get');
function isAborted(signal: AbortSignal): boolean {
  return nativeAborted
    ? Reflect.apply(nativeAborted, signal, []) === true
    : true;
}
function exact(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> | null {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      ![Object.prototype, null].includes(
        Object.getPrototypeOf(value) as object | null,
      )
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== names.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== 'string' || !names.includes(key),
      ) ||
      Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value'))
    )
      return null;
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, d]) => [key, d.value]),
    );
  } catch {
    return null;
  }
}
function parseObservation(value: unknown): Observation {
  const failure = exact(value, ['status', 'reason']);
  if (
    failure &&
    failure.status === 'unknown' &&
    [
      'observation_missing',
      'observation_unavailable',
      'invalid_observation',
    ].includes(failure.reason as string)
  ) {
    return { status: 'unknown', reason: failure.reason as RuntimeWindowReason };
  }
  if (
    failure &&
    failure.status === 'rejected' &&
    [
      'generation_changed',
      'build_changed',
      'configuration_changed',
      'mount_changed',
      'migration_changed',
      'signature_changed',
      'ownership_changed',
      'loopback_changed',
    ].includes(failure.reason as string)
  ) {
    return {
      status: 'rejected',
      reason: failure.reason as RuntimeWindowReason,
    };
  }
  const fields = exact(value, ['status', 'binding']);
  const b =
    fields?.status === 'observed'
      ? exact(fields.binding, ['generations', ...hashFields])
      : null;
  const invalid = (): Failure => ({
    status: 'unknown',
    reason: 'invalid_observation',
  });
  if (
    !b ||
    hashFields.some(
      (key) => typeof b[key] !== 'string' || !/^[a-f0-9]{64}$/.test(b[key]),
    )
  )
    return invalid();
  if (
    !Array.isArray(b.generations) ||
    Object.getPrototypeOf(b.generations) !== Array.prototype
  )
    return invalid();
  const list = b.generations;
  const descriptors = Object.getOwnPropertyDescriptors(list);
  if (
    list.length < 3 ||
    list.length > 32 ||
    Reflect.ownKeys(descriptors).length !== list.length + 1 ||
    Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value'))
  )
    return invalid();
  const generations: RuntimeGeneration[] = [];
  for (let i = 0; i < list.length; i++) {
    const g = exact(descriptors[String(i)]?.value, [
      'service',
      'actualId',
      'startedAt',
      'restartGeneration',
      'immutableImageId',
    ]);
    if (
      !g ||
      typeof g.service !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(g.service) ||
      typeof g.actualId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(g.actualId) ||
      typeof g.startedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(g.startedAt) ||
      !Number.isSafeInteger(g.restartGeneration) ||
      (g.restartGeneration as number) < 0 ||
      typeof g.immutableImageId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(g.immutableImageId)
    )
      return invalid();
    generations.push(Object.freeze(g) as unknown as RuntimeGeneration);
  }
  if (
    new Set(generations.map((g) => g.service)).size !== generations.length ||
    !['api', 'data-worker', 'clamav'].every((service) =>
      generations.some((g) => g.service === service),
    )
  )
    return invalid();
  generations.sort((a, z) => a.service.localeCompare(z.service));
  return {
    status: 'observed',
    binding: Object.freeze({
      ...b,
      generations: Object.freeze(generations),
    }) as unknown as RuntimeObservationBinding,
  };
}

function changed(
  before: RuntimeObservationBinding,
  after: RuntimeObservationBinding,
): Failure | null {
  if (
    before.generations.length !== after.generations.length ||
    before.generations.some((g, i) => {
      const next = after.generations[i];
      return (
        next === undefined ||
        g.service !== next.service ||
        g.actualId !== next.actualId ||
        g.startedAt !== next.startedAt ||
        g.restartGeneration !== next.restartGeneration
      );
    })
  )
    return { status: 'rejected', reason: 'generation_changed' };
  if (
    before.generations.some(
      (g, i) => g.immutableImageId !== after.generations[i]?.immutableImageId,
    )
  )
    return { status: 'rejected', reason: 'build_changed' };
  const reasons: Record<(typeof hashFields)[number], RuntimeWindowReason> = {
    sourceBuildSha256: 'build_changed',
    configurationSha256: 'configuration_changed',
    mountsSha256: 'mount_changed',
    migrationSha256: 'migration_changed',
    signatureSourceSha256: 'signature_changed',
    signatureBytesSha256: 'signature_changed',
    signatureReadinessSha256: 'signature_changed',
    ownershipLoopbackSha256: 'ownership_changed',
  };
  for (const key of hashFields)
    if (before[key] !== after[key])
      return { status: 'rejected', reason: reasons[key] };
  return null;
}
interface WindowEntry {
  readonly abort: AbortController;
  baseline: RuntimeObservationBinding | null;
  failure: Failure | null;
  inflight: Promise<RuntimeWindowResult> | null;
  watcher: ReturnType<typeof setTimeout> | null;
}

export function createA12RuntimeObservationWindows(
  read: (signal: AbortSignal) => Promise<unknown>,
  controls: RuntimeObservationControls,
): RuntimeObservationWindows {
  const selected = exact(controls, [
    'maximumObservationMs',
    'sampleIntervalMs',
    'maximumWindows',
  ]);
  if (
    typeof read !== 'function' ||
    !selected ||
    Object.values(selected).some(
      (n) =>
        typeof n !== 'number' ||
        !Number.isSafeInteger(n) ||
        n < 1 ||
        n > 2_147_483_647,
    ) ||
    (selected.maximumWindows as number) > 32
  )
    throw new Error('Invalid runtime observation controls');
  const maximumObservationMs = selected.maximumObservationMs as number;
  const sampleIntervalMs = selected.sampleIntervalMs as number;
  const maximumWindows = selected.maximumWindows as number;
  let closed = false;
  const owned = new WeakMap<object, WindowEntry>();
  const active = new Set<WindowEntry>();
  let activeObservations = 0;
  const stop = (entry: WindowEntry, failure: Failure): Failure => {
    entry.failure ??= Object.freeze(failure);
    if (entry.watcher !== null) {
      clearTimeout(entry.watcher);
      entry.watcher = null;
    }
    active.delete(entry);
    if (!isAborted(entry.abort.signal)) entry.abort.abort(entry.failure.reason);
    return entry.failure;
  };
  function readBounded(entry: WindowEntry): Promise<Observation> {
    return new Promise((resolve) => {
      const controller = new AbortController();
      let settled = false;
      const done = (value: Observation) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        // Never use mutable instance methods exposed through signal(window).
        // Cleanup must not suppress completion or strand a canceled observation.
        try {
          if (nativeRemoveListener)
            Reflect.apply(nativeRemoveListener, entry.abort.signal, [
              'abort',
              onAbort,
            ]);
        } catch {
          /* The owned result still has to settle. */
        }
        resolve(value);
      };
      const onAbort = () => {
        done(entry.failure ?? { status: 'unknown', reason: 'closed' });
        controller.abort();
      };
      const deadline = setTimeout(() => {
        done(unavailable());
        controller.abort();
      }, maximumObservationMs);
      if (!nativeAddListener) {
        done(unavailable());
        return;
      }
      Reflect.apply(nativeAddListener, entry.abort.signal, [
        'abort',
        onAbort,
        { once: true },
      ]);
      if (isAborted(entry.abort.signal)) {
        onAbort();
        return;
      }
      // A non-cooperative reader is still bounded at the observation boundary;
      // neither its late fulfillment nor rejection may change a completed result.
      Promise.resolve()
        .then(() => {
          if (settled || isAborted(controller.signal)) return unavailable();
          return read(controller.signal);
        })
        .then(
          (value) => {
            try {
              done(parseObservation(value));
            } catch {
              done({ status: 'unknown', reason: 'invalid_observation' });
            }
          },
          () => done(unavailable()),
        );
    });
  }
  function sampleLater(entry: WindowEntry): void {
    if (entry.failure || closed || entry.watcher !== null) return;
    entry.watcher = setTimeout(() => {
      entry.watcher = null;
      void observe(entry).then(() => sampleLater(entry));
    }, sampleIntervalMs);
    entry.watcher.unref();
  }
  function observe(entry: WindowEntry): Promise<RuntimeWindowResult> {
    if (entry.failure) return Promise.resolve(entry.failure);
    if (entry.inflight) return entry.inflight;
    activeObservations++;
    const pending = (async (): Promise<RuntimeWindowResult> => {
      const observation = await readBounded(entry);
      if (entry.failure) return entry.failure;
      if (observation.status !== 'observed') return stop(entry, observation);
      if (entry.baseline) {
        const drift = changed(entry.baseline, observation.binding);
        if (drift) return stop(entry, drift);
      } else entry.baseline = observation.binding;
      return { status: 'unchanged' };
    })();
    entry.inflight = pending.finally(() => {
      activeObservations--;
      entry.inflight = null;
    });
    return entry.inflight;
  }
  return Object.freeze({
    openWindow: async () => {
      if (closed) return { status: 'unknown', reason: 'closed' };
      if (active.size >= maximumWindows)
        return { status: 'unknown', reason: 'window_limit' };
      const entry: WindowEntry = {
        abort: new AbortController(),
        baseline: null,
        failure: null,
        inflight: null,
        watcher: null,
      };
      const window = Object.freeze(
        Object.create(null),
      ) as RuntimeObservationWindow;
      owned.set(window, entry);
      active.add(entry);
      const check = await observe(entry);
      if (check.status !== 'unchanged') return check;
      if (entry.failure) return entry.failure;
      sampleLater(entry);
      return { status: 'open', window };
    },
    checkpoint: async (window) => {
      const entry = owned.get(window);
      return entry
        ? observe(entry)
        : { status: 'unknown', reason: 'unowned_session' };
    },
    signal: (window) =>
      owned.get(window)?.abort.signal ?? AbortSignal.abort('unowned_session'),
    closeWindow: (window) => {
      const entry = owned.get(window);
      if (entry) stop(entry, { status: 'unknown', reason: 'closed' });
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of [...active])
        stop(entry, { status: 'unknown', reason: 'closed' });
    },
    diagnostics: () => ({
      activeWindows: [...active].filter((entry) => entry.baseline !== null)
        .length,
      activeObservations,
      activeWatchers: [...active].filter((entry) => entry.watcher !== null)
        .length,
      closed,
    }),
  } satisfies RuntimeObservationWindows);
}
