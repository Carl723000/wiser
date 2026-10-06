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
      (key) =>
        typeof b[key] !== 'string' || !/^[a-f0-9]{64}$/.test(b[key] as string),
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

export function createA12RuntimeObservationWindows(
  read: (signal: AbortSignal) => Promise<unknown>,
  _controls: RuntimeObservationControls,
): RuntimeObservationWindows {
  let closed = false;
  const owned = new WeakMap<object, AbortController>();
  const active = new Set<AbortController>();
  let activeObservations = 0;
  return {
    openWindow: async () => {
      const controller = new AbortController();
      activeObservations++;
      try {
        const observation = parseObservation(await read(controller.signal));
        if (observation.status !== 'observed') return observation;
        const window = Object.freeze(
          Object.create(null),
        ) as RuntimeObservationWindow;
        owned.set(window, controller);
        active.add(controller);
        return { status: 'open', window };
      } catch {
        return unavailable();
      } finally {
        activeObservations--;
      }
    },
    checkpoint: async (window) => {
      const controller = owned.get(window);
      if (!controller) return { status: 'unknown', reason: 'unowned_session' };
      activeObservations++;
      try {
        await read(controller.signal);
        return { status: 'unchanged' };
      } catch {
        return unavailable();
      } finally {
        activeObservations--;
      }
    },
    signal: (window) =>
      owned.get(window)?.signal ?? AbortSignal.abort('unowned_session'),
    closeWindow: (window) => {
      const controller = owned.get(window);
      controller?.abort('closed');
      if (controller) active.delete(controller);
    },
    close: () => {
      closed = true;
      for (const controller of active) controller.abort('closed');
      active.clear();
    },
    diagnostics: () => ({
      activeWindows: active.size,
      activeObservations,
      activeWatchers: 0,
      closed,
    }),
  };
}
